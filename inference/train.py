#!/usr/bin/env python3
"""
Training loop — fits a direction classifier on collected observations.
=======================================================================
Reads the supervised-learning dataset produced by the TypeScript collector
(`signals.json`) and writes a trained model to `model.pkl`.

Dataset shape (one record per 60s observation):
    {type:"OBSERVATION", asset, entryAt, entryPrice, resolvedAt,
     expirationPrice, delta, label (0|1), outcome, features:{...}, source}

Validation methodology
----------------------
The observations are a time series of autocorrelated windows with a 60s label
horizon, so a shuffled train/test split leaks: near-identical adjacent windows
land on both sides and the held-out score becomes optimistic. This module
therefore:

  1. sorts by `entryAt` and splits CHRONOLOGICALLY (train = older, test = newer);
  2. PURGES training rows whose 60s label horizon overlaps the test period, plus
     an embargo gap, so no label window straddles the boundary;
  3. optionally runs WALK-FORWARD evaluation (expanding window, several folds)
     to expose regime dependence instead of reporting one lucky split;
  4. fits a Platt (sigmoid) CALIBRATION map on a purged slice, because a RandomForest's
     `predict_proba` is only "calibrated-ish" and the downstream confidence gate
     acts on the probability's magnitude, not just its ranking;
  5. reports an ECONOMIC harness — win rate and Wilson CI for the post-filter
     subset that would actually be acted on, against the payout break-even.

Usage:
    python train.py                         # chronological holdout
    python train.py --data ../price-bot/signals.json
    python train.py --walk-forward --folds 5
    python train.py --payout 0.92 --min-confidence 0.65
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier

from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import TimeSeriesSplit

from features import FEATURE_NAMES, RAW_FEATURE_KEYS, build_vector
from model_bundle import CalibratedModel, PlattCalibrator

# A model trained on a handful of rows is worse than no model: it produces
# confident-looking probabilities from noise. Refuse to emit one below this.
MIN_ROWS_TO_TRAIN = 200
# Below this the metrics are too noisy to trust for a go/no-go decision.
MIN_ROWS_FOR_MEANINGFUL_METRICS = 1000

# Label horizon in ms. Used to purge training rows whose outcome window
# overlaps the test period (see module docstring).
HORIZON_MS = 60_000

# Must mirror price-bot/signalFilter.ts so the economic harness measures the
# same subset the live engine would act on.
DEFAULT_MIN_CONFIDENCE = 0.65
DEFAULT_NO_TRADE_LOW = 0.36
DEFAULT_NO_TRADE_HIGH = 0.64
DEFAULT_MAX_VOLATILITY_PCT = 0.02


@dataclass
class Dataset:
    """Vectorised observations, ordered by entry time."""

    X: np.ndarray
    y: np.ndarray
    assets: list[str]
    entry_at: np.ndarray
    range_pct: np.ndarray
    horizon_ms: int = HORIZON_MS

    def __len__(self) -> int:
        return len(self.y)


def load_dataset(path: Path) -> Dataset:
    """Load, vectorise, and chronologically order the observation dataset.

    Returns:
        A `Dataset` sorted by `entryAt`. Records that are malformed or carry an
        out-of-range label are skipped rather than silently coerced.
    """
    if not path.exists():
        raise FileNotFoundError(
            f"Dataset not found: {path}\n"
            "Run the collector first (cd price-bot && npx tsx capture.ts) "
            "to generate signals.json."
        )

    raw = json.loads(path.read_text())
    if not isinstance(raw, list):
        raise ValueError(f"Expected a JSON array in {path}, got {type(raw).__name__}")

    rows: list[tuple[int, list[float], int, str, float]] = []
    horizons: list[int] = []
    skipped = 0

    for rec in raw:
        if not isinstance(rec, dict):
            skipped += 1
            continue
        label = rec.get("label")
        # Accept only strict binary labels; 0.5/None/strings are data errors.
        if label not in (0, 1):
            skipped += 1
            continue
        features = rec.get("features")
        asset = rec.get("asset")
        entry_at = rec.get("entryAt")
        if not isinstance(features, dict) or not isinstance(asset, str):
            skipped += 1
            continue
        if not isinstance(entry_at, (int, float)):
            skipped += 1
            continue

        # Measure the label horizon from the record itself. The purge in
        # chronological_split needs the true horizon: if the collector was run
        # with a 180s horizon and the purge still assumes 60s, training rows
        # whose outcomes land in the test period survive and leak. Reading it
        # from the data means the two can never drift apart.
        resolved_at = rec.get("resolvedAt")
        if isinstance(resolved_at, (int, float)) and resolved_at > entry_at:
            horizons.append(int(resolved_at - entry_at))

        open_px = features.get("open")
        rng = features.get("range")
        try:
            denom = float(open_px) if float(open_px) > 0 else 1.0
            range_pct = float(rng) / denom
        except (TypeError, ValueError):
            range_pct = 0.0
        if not math.isfinite(range_pct) or range_pct < 0:
            range_pct = 0.0

        rows.append(
            (int(entry_at), build_vector(features, asset), int(label), asset, range_pct)
        )

    if skipped:
        print(f"[data] skipped {skipped} malformed record(s)")

    # Schema drift guard. `build_vector` reads a missing feature as 0.0, which
    # is the right call for a stray partial record — but if a whole batch of
    # rows predates a feature rename, those rows get 0.0 for a column that
    # means something real for every other row. The model then trains on one
    # column with two meanings. Warn loudly rather than let that pass.
    numeric_keys = RAW_FEATURE_KEYS
    missing_counts = {k: 0 for k in numeric_keys}
    for rec in raw:
        if not isinstance(rec, dict):
            continue
        feats = rec.get("features")
        if not isinstance(feats, dict):
            continue
        for k in numeric_keys:
            if k not in feats:
                missing_counts[k] += 1
    drifted = {k: c for k, c in missing_counts.items() if c > 0}
    if drifted:
        print(
            "\n[data] !! SCHEMA DRIFT — these feature keys are absent in some "
            "rows and will be read as 0.0:"
        )
        for k, c in sorted(drifted.items(), key=lambda t: -t[1]):
            print(f"         {k:<20} missing in {c} row(s)")
        print(
            "       Rows from before a feature rename are NOT comparable with\n"
            "       current rows. Training on a mix produces a model that is\n"
            "       silently wrong. Point --data at one schema only.\n"
        )

    # Chronological order is the whole point: every split below relies on it.
    rows.sort(key=lambda r: r[0])

    X = np.asarray([r[1] for r in rows], dtype=float)
    y = np.asarray([r[2] for r in rows], dtype=int)
    assets = [r[3] for r in rows]
    entry_at = np.asarray([r[0] for r in rows], dtype=np.int64)
    range_pct = np.asarray([r[4] for r in rows], dtype=float)

    # A label resolves on the first tick at/after the horizon, so a "180s"
    # horizon lands at 180005ms, 180467ms, sometimes 194628ms — normal tick
    # jitter, not a different horizon. Bucket to whole minutes so jitter
    # collapses to one bucket while a real horizon change (60 -> 180) shows up
    # as two. Training one model on two horizons would answer two different
    # questions with one set of weights.
    buckets: dict[int, int] = {}
    for h in horizons:
        buckets[round(h / 60_000)] = buckets.get(round(h / 60_000), 0) + 1
    if len(buckets) > 1:
        detail = ", ".join(
            f"{m}min x{c}" for m, c in sorted(buckets.items(), key=lambda t: -t[1])
        )
        raise ValueError(
            f"Dataset mixes label horizons ({detail}). A signals.json that spans a "
            "horizon change cannot be trained as one model — it is two different "
            "prediction problems in one file. Archive or split it, or point --data "
            "at a single-horizon file."
        )
    horizon_ms = int(np.median(horizons)) if horizons else HORIZON_MS
    print(f"[data] label horizon: {horizon_ms}ms (measured from resolvedAt-entryAt)")

    return Dataset(X, y, assets, entry_at, range_pct, horizon_ms)


def build_model(seed: int) -> RandomForestClassifier:
    """The classifier. Shallow by design — a hedge against overfitting."""
    return RandomForestClassifier(
        n_estimators=300,
        max_depth=8,
        min_samples_leaf=10,
        random_state=seed,
        n_jobs=-1,
        class_weight="balanced",
    )


def chronological_split(
    ds: Dataset, test_size: float, embargo_ms: int
) -> tuple[np.ndarray, np.ndarray]:
    """Split indices into (train, test) by time, purging overlapping horizons.

    Train is the older block, test the newer. Any training row whose label
    horizon reaches into the test period is dropped, plus `embargo_ms` of extra
    gap — otherwise a row can be labelled using test-period prices.

    The horizon comes from `ds.horizon_ms` (measured from the data), not a
    constant: a dataset collected at a 180s horizon must be purged over 180s,
    or rows up to 180s before the seam keep labels built from test prices.
    """
    n = len(ds)
    split = int(n * (1.0 - test_size))
    split = max(1, min(split, n - 1))

    test_idx = np.arange(split, n)
    test_start = ds.entry_at[split]

    train_candidates = np.arange(0, split)
    # Purge: drop rows whose outcome window overlaps test, and embargo the seam.
    keep = ds.entry_at[train_candidates] + ds.horizon_ms + embargo_ms <= test_start
    train_idx = train_candidates[keep]

    if len(train_idx) == 0:
        # Degenerate (tiny dataset / huge embargo): fall back to the raw split
        # rather than crashing, and let the caller warn.
        train_idx = train_candidates
    return train_idx, test_idx


def wilson_ci(successes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion (better than normal at
    small n and near 0/1, which is exactly where a win rate lives)."""
    if n == 0:
        return (0.0, 0.0)
    p = successes / n
    denom = 1.0 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def passes_filter(
    prob: float,
    range_pct: float,
    min_confidence: float,
    no_trade_low: float,
    no_trade_high: float,
    max_volatility: float,
) -> bool:
    """Mirror of price-bot/signalFilter.ts so the harness scores the real subset."""
    if not math.isfinite(prob):
        return False
    confidence = max(prob, 1.0 - prob)
    if confidence < min_confidence:
        return False
    if no_trade_low <= prob <= no_trade_high:
        return False
    if range_pct > max_volatility:
        return False
    return True


def economic_harness(
    y_true: np.ndarray,
    proba: np.ndarray,
    range_pct: np.ndarray,
    payout: float,
    min_confidence: float,
    no_trade_low: float,
    no_trade_high: float,
    max_volatility: float,
) -> None:
    """Report win rate + CI for the post-filter subset vs payout break-even.

    Accuracy is not the objective. A binary option at payout `b` breaks even at
    `1 / (1 + b)`; the only number that matters is the win rate of the signals
    that survive the filters, with an interval that says how much to trust it.
    """
    n = len(y_true)
    if n == 0:
        print("\n[econ] no test rows — nothing to evaluate")
        return

    break_even = 1.0 / (1.0 + payout)
    accepted = np.array(
        [
            passes_filter(
                p, r, min_confidence, no_trade_low, no_trade_high, max_volatility
            )
            for p, r in zip(proba, range_pct)
        ]
    )

    # A CALL (direction 1) wins when the label is 1; a PUT wins when it is 0.
    pred_dir = (proba >= 0.5).astype(int)
    wins = (y_true == pred_dir).astype(int)

    print("\n[econ] post-filter subset (what the engine would actually act on)")
    print(f"  payout assumed          : {payout:.4f}  -> break-even win rate {break_even:.4f}")

    k = int(accepted.sum())
    if k == 0:
        print("  accepted signals        : 0")
        print("  => no signal cleared the filters on this test set; nothing to trade.")
        return

    w = int(wins[accepted].sum())
    lo, hi = wilson_ci(w, k)
    rate = w / k
    print(f"  accepted signals        : {k} / {n} ({k / n:.1%} of windows)")
    print(f"  win rate (accepted)     : {rate:.4f}  [{lo:.4f}, {hi:.4f}] 95% CI")
    print(f"  vs break-even           : {rate - break_even:+.4f}")
    if lo > break_even:
        print("  => CI sits ABOVE break-even. Promising, but confirm out-of-sample.")
    elif hi < break_even:
        print("  => CI sits BELOW break-even. No edge at this payout.")
    else:
        print(
            "  => CI straddles break-even. Inconclusive — collect more data before\n"
            "     treating this as a trading edge."
        )


def _calibrator_improves_brier(
    raw_cal: np.ndarray, y_cal: np.ndarray
) -> tuple[bool, float, float]:
    """Does a Platt map actually help on this slice? Honest, out-of-fold check.

    Returns `(improves, raw_brier, calibrated_brier)`. The slice is split
    chronologically in two; each half fits the map and scores the other, so no
    row is ever scored by a map that saw it. A half without both classes is
    skipped, which leaves the calibrated prediction equal to the raw one there —
    so a degenerate slice simply fails to demonstrate an improvement and the
    calibrator is dropped. That is the conservative direction, and the right
    one: applying a map that does not help is strictly worse than not applying
    one, because the confidence filter downstream reads the *magnitude*.

    Why this guard exists: Platt is a monotone squashing map. On a weak model
    with few calibration points it can compress the whole raw range into the
    no-trade zone — every window then reads ~0.5 and the engine goes
    permanently silent. It was measured doing exactly that. Calibration is only
    worth keeping when it demonstrably improves the held-out Brier score.
    """
    n = len(y_cal)
    if n < 8:
        return False, float("nan"), float("nan")

    mid = n // 2
    halves = [(np.arange(0, mid), np.arange(mid, n)),
              (np.arange(mid, n), np.arange(0, mid))]
    cal_pred = raw_cal.astype(float).copy()
    for fit_i, eval_i in halves:
        if len(set(y_cal[fit_i].tolist())) < 2 or len(set(y_cal[eval_i].tolist())) < 2:
            continue
        try:
            map_ = PlattCalibrator.fit(raw_cal[fit_i], y_cal[fit_i])
        except ValueError:
            continue
        # A calibration map must be monotone INCREASING. A negative slope means
        # this half was (by chance) anti-correlated with the raw score, so the
        # map would invert the model's direction on live data. Leave those rows
        # raw: an inverting map is not calibration, so it must never be able to
        # earn an "improvement" here.
        if map_.coef <= 0.0:
            continue
        cal_pred[eval_i] = np.clip(map_.predict(raw_cal[eval_i]), 0.0, 1.0)

    raw_brier = float(brier_score_loss(y_cal, raw_cal))
    cal_brier = float(brier_score_loss(y_cal, cal_pred))
    return cal_brier < raw_brier, raw_brier, cal_brier


def _fit_calibrated(
    X_tr: np.ndarray, y_tr: np.ndarray, X_cal: np.ndarray, y_cal: np.ndarray, seed: int
) -> tuple[RandomForestClassifier, Any, str]:
    """Fit the forest, then a Platt (sigmoid) map on a purged calibration slice.

    Returns `(model, calibrator_or_None, note)`. The calibrator is None when the
    slice is too small, single-class, or when the map fails to improve the
    out-of-fold Brier score — in every one of those cases raw probabilities are
    used and `note` says why.

    Platt, not isotonic: isotonic is non-parametric and, on the ~30-row slices
    available here, steps to exactly 0.0/1.0. The confidence filter downstream
    reads that as certainty, so a handful of calibration points would mint
    full-confidence signals out of a 0.58 raw score. See `PlattCalibrator`.
    """
    model = build_model(seed)
    model.fit(X_tr, y_tr)

    if len(y_cal) < 30 or len(set(y_cal.tolist())) != 2:
        return model, None, (
            f"calibration slice too small/single-class (n={len(y_cal)}) "
            "- using raw probabilities"
        )

    raw = model.predict_proba(X_cal)[:, 1]
    improves, raw_brier, cal_brier = _calibrator_improves_brier(raw, y_cal)
    if not improves:
        return model, None, (
            f"Platt rejected: out-of-fold Brier {cal_brier:.4f} does not beat raw "
            f"{raw_brier:.4f} on {len(y_cal)} row(s) - using raw probabilities"
        )

    try:
        calibrator = PlattCalibrator.fit(raw, y_cal)
    except ValueError:
        return model, None, "Platt fit failed - using raw probabilities"

    # Belt and braces: the out-of-fold check above already refuses to reward a
    # decreasing map, but the map finally persisted is fit on the full slice,
    # where the slope could differ in sign. A non-positive slope is never a
    # calibration — it inverts the model's direction, and the direction filter
    # downstream reads `P >= 0.5` — so refuse it outright.
    if calibrator.coef <= 0.0:
        return model, None, (
            f"Platt rejected: slope {calibrator.coef:.4f} is not positive "
            "(would invert the model's direction) - using raw probabilities"
        )

    return model, calibrator, (
        f"Platt (sigmoid) fitted on {len(y_cal)} purged row(s); out-of-fold Brier "
        f"{cal_brier:.4f} beats raw {raw_brier:.4f}"
    )


def _apply(model, calibrator, X: np.ndarray) -> np.ndarray:
    proba = model.predict_proba(X)[:, 1]
    if calibrator is not None:
        proba = np.clip(calibrator.predict(proba), 0.0, 1.0)
    return proba


def _report_metrics(
    title: str, y_te: np.ndarray, proba: np.ndarray, X_te: np.ndarray
) -> None:
    pred = (proba >= 0.5).astype(int)
    acc = accuracy_score(y_te, pred)
    prec = precision_score(y_te, pred, zero_division=0)
    rec = recall_score(y_te, pred, zero_division=0)
    try:
        auc = roc_auc_score(y_te, proba)
    except ValueError:
        auc = float("nan")
    brier = brier_score_loss(y_te, proba) if len(set(y_te.tolist())) == 2 else float("nan")

    print(f"\n[eval] {title}")
    print(f"  n        : {len(y_te)}")
    print(f"  accuracy : {acc:.4f}")
    print(f"  precision: {prec:.4f}")
    print(f"  recall   : {rec:.4f}")
    print(f"  roc_auc  : {auc:.4f}")
    print(f"  brier    : {brier:.4f}  (lower is better; 0.25 = coin flip)")
    print(f"  confusion matrix [[tn fp],[fn tp]]: {confusion_matrix(y_te, pred).tolist()}")


def _permutation_baseline(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    X_te: np.ndarray,
    y_te: np.ndarray,
    seed: int,
    n_perm: int = 10,
) -> np.ndarray:
    """AUC of models trained on the *same features* with shuffled labels.

    This is the control that makes a held-out AUC interpretable. Shuffling
    destroys any real relationship between features and outcome, so whatever
    AUC these models reach is the score a model can get from this feature set
    *by chance at this sample size*. If the real model's AUC sits inside this
    spread, it has learned nothing the noise would not also produce.

    Returns the array of null AUCs (empty if the test set is single-class).
    """
    rng = np.random.default_rng(seed)
    null_aucs: list[float] = []
    for _ in range(n_perm):
        shuffled = rng.permutation(y_tr)
        # A permutation can land on a single class; skip those folds rather
        # than let the forest fit a degenerate boundary.
        if len(set(shuffled.tolist())) < 2:
            continue
        m = build_model(seed)
        m.fit(X_tr, shuffled)
        proba = m.predict_proba(X_te)[:, 1]
        try:
            null_aucs.append(roc_auc_score(y_te, proba))
        except ValueError:
            continue
    return np.asarray(null_aucs, dtype=float)


def _report_permutation(
    y_te: np.ndarray, real_auc: float, null_aucs: np.ndarray
) -> None:
    """Print the real AUC against the shuffled-label null distribution."""
    if len(null_aucs) == 0:
        print("\n[perm] skipped (test set unusable for a null distribution)")
        return

    lo = float(np.percentile(null_aucs, 5))
    hi = float(np.percentile(null_aucs, 95))
    mean = float(null_aucs.mean())
    # Two-sided empirical p: how often the null reaches the real score.
    p_value = float((np.abs(null_aucs - 0.5) >= abs(real_auc - 0.5)).mean())

    print("\n[perm] shuffled-label control (does the feature set beat chance?)")
    print(f"  real roc_auc        : {real_auc:.4f}")
    print(f"  null roc_auc mean   : {mean:.4f}  [5th, 95th] = [{lo:.4f}, {hi:.4f}]")
    print(f"  empirical p-value   : {p_value:.3f}  (n_perm={len(null_aucs)})")
    if lo <= real_auc <= hi:
        print("  => INSIDE the null spread. The model is indistinguishable from")
        print("     chance on this feature set and sample size. Treat any edge")
        print("     it appears to show as noise.")
    elif real_auc > hi:
        print("  => ABOVE the null spread — the features carry signal beyond chance.")
        print("     Still confirm on out-of-sample data before trusting it.")
    else:
        print("  => BELOW the null spread — worse than chance; check for a bug.")


def train(
    data_path: Path,
    model_path: Path,
    test_size: float,
    seed: int,
    min_rows: int,
    walk_forward: bool,
    folds: int,
    embargo_ms: int,
    payout: float,
    min_confidence: float,
    no_trade_low: float,
    no_trade_high: float,
    max_volatility: float,
    n_perm: int = 10,
    refit_full: bool = False,
) -> int:
    print(f"[data] loading {data_path}")
    ds = load_dataset(data_path)
    n = len(ds)

    print(f"[data] {n} labelled observation(s), {len(set(ds.assets))} asset(s)")
    if n == 0:
        print("[error] no usable rows — nothing to train on", file=sys.stderr)
        return 1

    # Class balance. A lopsided split is the first thing to check, because it
    # makes raw accuracy look good while precision is meaningless.
    pos = int(ds.y.sum())
    neg = n - pos
    print(f"[data] class balance: UP={pos} ({pos / n:.1%})  DOWN={neg} ({neg / n:.1%})")

    if n < min_rows:
        print(
            f"\n[error] only {n} rows; need >= {min_rows} to train.\n"
            "        A model fit on this little data will be pure noise.\n"
            "        Let the collector run longer to accumulate more observations.\n"
            "        (Override with --min-rows, but only for smoke tests.)",
            file=sys.stderr,
        )
        return 1

    # Both classes must be present or the classifier cannot learn a boundary.
    if pos == 0 or neg == 0:
        print(f"[error] only one class present (UP={pos}, DOWN={neg})", file=sys.stderr)
        return 1

    span_min = (ds.entry_at[-1] - ds.entry_at[0]) / 60000.0
    print(f"[data] time span: {span_min:.0f} minute-buckets (chronological order enforced)")

    if walk_forward:
        _walk_forward(
            ds, test_size, seed, folds, embargo_ms, payout,
            min_confidence, no_trade_low, no_trade_high, max_volatility, n_perm,
        )
    else:
        train_idx, test_idx = chronological_split(ds, test_size, embargo_ms)
        purged = (len(ds) - len(test_idx)) - len(train_idx)
        print(
            f"[split] chronological train={len(train_idx)} test={len(test_idx)}"
            f" (test_size={test_size}, purged {purged} overlapping row(s))"
        )

        # Carve a purged calibration slice off the end of train, so the
        # calibrator never sees the test period either.
        cal_frac = 0.2
        cut = int(len(train_idx) * (1.0 - cal_frac))
        cut = max(1, min(cut, len(train_idx) - 1))
        fit_idx, cal_idx = train_idx[:cut], train_idx[cut:]

        model, calibrator, calib_note = _fit_calibrated(
            ds.X[fit_idx], ds.y[fit_idx], ds.X[cal_idx], ds.y[cal_idx], seed
        )
        print(f"[calib] {calib_note}")

        X_te, y_te = ds.X[test_idx], ds.y[test_idx]
        raw = model.predict_proba(X_te)[:, 1]
        cal = _apply(model, calibrator, X_te)

        _report_metrics("held-out performance (raw probabilities)", y_te, raw, X_te)
        if calibrator is not None:
            _report_metrics("held-out performance (calibrated)", y_te, cal, X_te)

        proba = cal if calibrator is not None else raw
        economic_harness(
            y_te, proba, ds.range_pct[test_idx], payout,
            min_confidence, no_trade_low, no_trade_high, max_volatility,
        )

        # The control that makes the AUC above interpretable: fit the same
        # feature set on shuffled labels and compare. Reported for the raw
        # forest. A calibration map that is monotone *increasing* leaves ranking
        # (and therefore AUC) unchanged; if the two AUCs sum to ~1.0 the map is
        # decreasing and has inverted the model, which is why `_fit_calibrated`
        # refuses a non-positive slope.
        raw_auc = roc_auc_score(y_te, raw) if len(set(y_te.tolist())) == 2 else float("nan")
        if math.isfinite(raw_auc):
            null_aucs = _permutation_baseline(
                ds.X[fit_idx], ds.y[fit_idx], X_te, y_te, seed, n_perm=n_perm
            )
            _report_permutation(y_te, raw_auc, null_aucs)

        print(f"  baseline (always predict majority): {max(pos, neg) / n:.4f}")
        if n < MIN_ROWS_FOR_MEANINGFUL_METRICS:
            print(
                f"\n[warn] only {n} rows. Metrics are noisy at this size — treat the\n"
                "       numbers as a smoke test, NOT as evidence of a trading edge."
            )

        print("\n[eval] feature importances")
        for name, imp in sorted(
            zip(FEATURE_NAMES, model.feature_importances_), key=lambda t: -t[1]
        ):
            if imp > 0.001:
                print(f"  {name:<18} {imp:.4f}")

        # Persist the calibrated model so serving applies the same map. The
        # calibration step is bundled with the forest so `predict_proba` downstream
        # stays a single call.
        #
        # By default we save the model that produced the metrics above, which was
        # fit on `fit_idx` only — a fraction of the data. That is honest, but it
        # discards the rest. `--refit-full` refits the forest on every non-test
        # row (still excluding the purged band and the test period, so the
        # reported metrics remain valid). The calibrator is *reused*, not refit:
        # it was fit out-of-sample on `cal_idx`, and refitting it here would fit
        # it on rows the forest had already seen — in-sample calibration is
        # over-confident, which is exactly the failure the calibrator exists to
        # avoid. Reusing the out-of-sample map keeps calibration honest while the
        # forest still sees all available rows. Deployment-only; evaluation is
        # unaffected.
        if refit_full:
            deploy_model = build_model(seed)
            deploy_model.fit(ds.X[train_idx], ds.y[train_idx])
            deploy_calib = calibrator
            calib_state = (
                "calibrator reused from the purged slice"
                if calibrator is not None
                else "no calibrator (rejected above)"
            )
            print(
                f"[save] --refit-full: forest refit on {len(train_idx)} rows "
                f"(was {len(fit_idx)}); {calib_state}"
            )
        else:
            deploy_model, deploy_calib = model, calibrator

        model_path.parent.mkdir(parents=True, exist_ok=True)
        # Write to a temp file and rename, so a concurrent reader (the inference
        # service reloads on mtime change) can never observe a half-written
        # pickle. An in-place dump is not atomic: the reload can land mid-write,
        # and joblib.load then raises rather than returning the old model.
        # rename(2) is atomic within a filesystem, so a reader sees either the
        # previous file or the complete new one.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(model_path.parent), prefix=f".{model_path.name}.", suffix=".tmp"
        )
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            joblib.dump(
                CalibratedModel(deploy_model, deploy_calib, FEATURE_NAMES), tmp_path
            )
            # mkstemp creates 0600; match what an ordinary dump would leave so
            # the mode does not silently change if a reader runs as another user.
            os.chmod(tmp_path, 0o644)
            os.replace(tmp_path, model_path)
        finally:
            tmp_path.unlink(missing_ok=True)
        print(f"\n[save] wrote {model_path} ({model_path.stat().st_size} bytes)")

    return 0


def _walk_forward(
    ds: Dataset, test_size: float, seed: int, folds: int, embargo_ms: int,
    payout: float, min_confidence: float, no_trade_low: float,
    no_trade_high: float, max_volatility: float, n_perm: int = 10,
) -> None:
    """Expanding-window walk-forward evaluation.

    Reports the spread of AUC across folds. A single holdout can look good by
    luck; a wide spread across folds is the signal that the "edge" is regime
    noise, which is the failure mode this whole harness exists to catch.
    """
    n = len(ds)
    folds = max(2, min(folds, max(2, n // 50)))
    splitter = TimeSeriesSplit(n_splits=folds)

    print(f"\n[wf] expanding-window walk-forward, {folds} fold(s), embargo={embargo_ms}ms")
    aucs: list[float] = []
    accs: list[float] = []
    all_y: list[int] = []
    all_p: list[float] = []
    all_r: list[float] = []

    for i, (tr, te) in enumerate(splitter.split(ds.X), start=1):
        # Purge train rows whose label horizon reaches into this fold's test.
        # Uses the measured horizon so a 180s dataset is purged over 180s.
        test_start = ds.entry_at[te[0]]
        keep = ds.entry_at[tr] + ds.horizon_ms + embargo_ms <= test_start
        tr_p = tr[keep]
        if len(tr_p) < 20 or len(set(ds.y[tr_p].tolist())) < 2:
            print(f"  fold {i}: skipped (insufficient purged training rows)")
            continue

        model = build_model(seed)
        model.fit(ds.X[tr_p], ds.y[tr_p])
        proba = model.predict_proba(ds.X[te])[:, 1]
        pred = (proba >= 0.5).astype(int)

        try:
            auc = roc_auc_score(ds.y[te], proba)
        except ValueError:
            auc = float("nan")
        acc = accuracy_score(ds.y[te], pred)
        aucs.append(auc)
        accs.append(acc)
        all_y.extend(ds.y[te].tolist())
        all_p.extend(proba.tolist())
        all_r.extend(ds.range_pct[te].tolist())
        print(f"  fold {i}: train={len(tr_p)} test={len(te)}  auc={auc:.4f} acc={acc:.4f}")

    if not aucs:
        print("[wf] no fold produced a usable model")
        return

    finite = [a for a in aucs if math.isfinite(a)]
    if finite:
        print(
            f"\n[wf] auc across folds: mean={np.mean(finite):.4f} "
            f"std={np.std(finite):.4f} min={min(finite):.4f} max={max(finite):.4f}"
        )
    print(f"[wf] acc across folds: mean={np.mean(accs):.4f} std={np.std(accs):.4f}")

    # Pooled out-of-sample predictions across all folds — the most honest
    # single estimate this dataset can give.
    pooled_y = np.asarray(all_y)
    pooled_p = np.asarray(all_p)
    economic_harness(
        pooled_y, pooled_p, np.asarray(all_r), payout,
        min_confidence, no_trade_low, no_trade_high, max_volatility,
    )

    # Pooled null control. The per-fold AUCs above are noisy at this sample
    # size; pooling every fold's out-of-sample prediction into one AUC, and
    # comparing it against the same pipeline run on shuffled labels, is the
    # strongest read available. It answers "does this feature set beat chance
    # on this data?" using every test row rather than a 20% slice.
    if len(set(pooled_y.tolist())) == 2:
        try:
            pooled_auc = roc_auc_score(pooled_y, pooled_p)
        except ValueError:
            pooled_auc = float("nan")
        if math.isfinite(pooled_auc):
            null_pooled = _walk_forward_null(
                ds, test_size, seed, folds, embargo_ms, n_perm=n_perm,
            )
            _report_permutation(pooled_y, pooled_auc, null_pooled)
            _report_block_null(pooled_y, pooled_p, pooled_auc)


def _walk_forward_null(
    ds: Dataset, test_size: float, seed: int, folds: int, embargo_ms: int,
    n_perm: int = 10,
) -> np.ndarray:
    """Pooled shuffled-label AUCs under the same walk-forward split.

    Mirrors `_walk_forward`'s fold loop but permutes the training labels before
    each fit, then pools the out-of-sample probabilities exactly as the real
    run does. Returns one AUC per permutation, each computed on the full pooled
    set of test rows — so the comparison to the real pooled AUC is like-for-like.
    """
    rng = np.random.default_rng(seed)
    splitter = TimeSeriesSplit(n_splits=folds)
    splits = list(splitter.split(ds.X))

    null_aucs: list[float] = []
    for _ in range(n_perm):
        pooled_y: list[int] = []
        pooled_p: list[float] = []
        for tr, te in splits:
            test_start = ds.entry_at[te[0]]
            keep = ds.entry_at[tr] + ds.horizon_ms + embargo_ms <= test_start
            tr_p = tr[keep]
            if len(tr_p) < 20:
                continue
            shuffled = rng.permutation(ds.y[tr_p])
            if len(set(shuffled.tolist())) < 2:
                continue
            model = build_model(seed)
            model.fit(ds.X[tr_p], shuffled)
            pooled_y.extend(ds.y[te].tolist())
            pooled_p.extend(model.predict_proba(ds.X[te])[:, 1].tolist())
        if len(set(pooled_y)) < 2:
            continue
        try:
            null_aucs.append(roc_auc_score(np.asarray(pooled_y), np.asarray(pooled_p)))
        except ValueError:
            continue
    return np.asarray(null_aucs, dtype=float)


def _report_block_null(
    y: np.ndarray, p: np.ndarray, real_auc: float, n_shift: int = 1000, seed: int = 0
) -> None:
    """Second control: a circular-shift null on the *already-computed* predictions.

    The shuffled-label control assumes observations are exchangeable. Overlapping
    windows are autocorrelated, so that assumption is false and the shuffle can
    make the null too tight. A circular shift rotates the label series against
    the fixed predictions, preserving the label autocorrelation, so it is a
    stricter null. No model refits — it reuses `p` — so it costs nothing.

    If the real AUC clears both nulls, the signal is not a shuffle artifact. If
    it clears the i.i.d. null but not this one, treat it as autocorrelation.
    """
    if len(y) < 10 or len(set(y.tolist())) < 2:
        return
    rng = np.random.default_rng(seed)
    shifts = np.empty(n_shift, dtype=float)
    for i in range(n_shift):
        k = int(rng.integers(1, len(y)))
        try:
            shifts[i] = roc_auc_score(np.roll(y, k), p)
        except ValueError:
            shifts[i] = float("nan")
    shifts = shifts[np.isfinite(shifts)]
    if len(shifts) == 0:
        return
    p_value = float((np.abs(shifts - 0.5) >= abs(real_auc - 0.5)).mean())
    lo = float(np.percentile(shifts, 5))
    hi = float(np.percentile(shifts, 95))
    print(
        f"[perm] block null (circular shift, keeps autocorrelation): "
        f"mean={shifts.mean():.4f} [5,95]=[{lo:.4f},{hi:.4f}] p={p_value:.3f} "
        f"(n={len(shifts)})"
    )
    if p_value <= 0.05:
        print("  => survives the stricter block null too — not a shuffle artifact.")
    else:
        print(
            "  => does NOT clear the block null. The i.i.d. p-value was likely "
            "too optimistic; treat the signal as unproven."
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Train the direction classifier.")
    parser.add_argument(
        "--data",
        type=Path,
        default=Path(os.environ.get("SIGNALS_FILE", "./signals.json")),
        help="path to signals.json (default: ./signals.json)",
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=Path(os.environ.get("MODEL_FILE", "./model.pkl")),
        help="output path for the trained model (default: ./model.pkl)",
    )
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--min-rows",
        type=int,
        default=MIN_ROWS_TO_TRAIN,
        help=(
            f"minimum rows required to train (default {MIN_ROWS_TO_TRAIN}). "
            "Lower it ONLY for smoke tests; a small-data model is not trustworthy."
        ),
    )
    parser.add_argument(
        "--walk-forward",
        action="store_true",
        help="use expanding-window walk-forward evaluation instead of one holdout",
    )
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument(
        "--embargo-ms",
        type=int,
        default=HORIZON_MS,
        help="extra gap purged between train and test (default: one 60s horizon)",
    )
    parser.add_argument(
        "--payout",
        type=float,
        default=0.92,
        help="net profit per unit stake on a win; sets the break-even win rate",
    )
    parser.add_argument(
        "--permutations",
        type=int,
        default=10,
        help="shuffled-label controls for the null distribution (default: 10). "
        "Raise it for a finer p-value; each one is a full refit.",
    )
    parser.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
    parser.add_argument("--no-trade-low", type=float, default=DEFAULT_NO_TRADE_LOW)
    parser.add_argument("--no-trade-high", type=float, default=DEFAULT_NO_TRADE_HIGH)
    parser.add_argument(
        "--max-volatility", type=float, default=DEFAULT_MAX_VOLATILITY_PCT
    )
    parser.add_argument(
        "--refit-full",
        action="store_true",
        help="after evaluating on the held-out split, refit the saved model on "
        "all non-test rows so deployment uses the whole dataset. The reported "
        "metrics are unchanged (they still come from the held-out fit).",
    )
    args = parser.parse_args()

    try:
        return train(
            args.data, args.model, args.test_size, args.seed, args.min_rows,
            args.walk_forward, args.folds, args.embargo_ms, args.payout,
            args.min_confidence, args.no_trade_low, args.no_trade_high,
            args.max_volatility, args.permutations, args.refit_full,
        )
    except (FileNotFoundError, ValueError) as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
