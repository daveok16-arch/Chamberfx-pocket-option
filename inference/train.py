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
  4. fits an isotonic CALIBRATION map on a purged slice, because a RandomForest's
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
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import TimeSeriesSplit

from features import FEATURE_NAMES, build_vector
from model_bundle import CalibratedModel

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

    # Chronological order is the whole point: every split below relies on it.
    rows.sort(key=lambda r: r[0])

    X = np.asarray([r[1] for r in rows], dtype=float)
    y = np.asarray([r[2] for r in rows], dtype=int)
    assets = [r[3] for r in rows]
    entry_at = np.asarray([r[0] for r in rows], dtype=np.int64)
    range_pct = np.asarray([r[4] for r in rows], dtype=float)

    return Dataset(X, y, assets, entry_at, range_pct)


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

    Train is the older block, test the newer. Any training row whose 60s label
    horizon reaches into the test period is dropped, plus `embargo_ms` of extra
    gap — otherwise a row can be labelled using test-period prices.
    """
    n = len(ds)
    split = int(n * (1.0 - test_size))
    split = max(1, min(split, n - 1))

    test_idx = np.arange(split, n)
    test_start = ds.entry_at[split]

    train_candidates = np.arange(0, split)
    # Purge: drop rows whose outcome window overlaps test, and embargo the seam.
    keep = ds.entry_at[train_candidates] + HORIZON_MS + embargo_ms <= test_start
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


def _fit_calibrated(
    X_tr: np.ndarray, y_tr: np.ndarray, X_cal: np.ndarray, y_cal: np.ndarray, seed: int
):
    """Fit the forest, then an isotonic map on a purged calibration slice.

    Returns (model, calibrator_or_None). The calibrator is None when the slice
    is too small or single-class to fit — in that case raw probabilities are
    used and the caller says so.
    """
    model = build_model(seed)
    model.fit(X_tr, y_tr)

    calibrator = None
    if len(y_cal) >= 30 and len(set(y_cal.tolist())) == 2:
        raw = model.predict_proba(X_cal)[:, 1]
        try:
            iso = IsotonicRegression(out_of_bounds="clip", y_min=0.0, y_max=1.0)
            iso.fit(raw, y_cal)
            calibrator = iso
        except ValueError:
            calibrator = None
    return model, calibrator


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
            min_confidence, no_trade_low, no_trade_high, max_volatility,
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

        model, calibrator = _fit_calibrated(
            ds.X[fit_idx], ds.y[fit_idx], ds.X[cal_idx], ds.y[cal_idx], seed
        )
        if calibrator is None:
            print("[calib] calibration slice too small/single-class — using raw probabilities")
        else:
            print(f"[calib] isotonic fitted on {len(cal_idx)} purged row(s)")

        X_te, y_te = ds.X[test_idx], ds.y[test_idx]
        raw = model.predict_proba(X_te)[:, 1]
        cal = _apply(model, calibrator, X_te)

        _report_metrics("held-out performance (raw probabilities)", y_te, raw, X_te)
        if calibrator is not None:
            _report_metrics("held-out performance (isotonic-calibrated)", y_te, cal, X_te)

        proba = cal if calibrator is not None else raw
        economic_harness(
            y_te, proba, ds.range_pct[test_idx], payout,
            min_confidence, no_trade_low, no_trade_high, max_volatility,
        )

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
        # isotonic step is bundled with the forest so `predict_proba` downstream
        # stays a single call.
        model_path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(CalibratedModel(model, calibrator), model_path)
        print(f"\n[save] wrote {model_path} ({model_path.stat().st_size} bytes)")

    return 0


def _walk_forward(
    ds: Dataset, test_size: float, seed: int, folds: int, embargo_ms: int,
    payout: float, min_confidence: float, no_trade_low: float,
    no_trade_high: float, max_volatility: float,
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
        test_start = ds.entry_at[te[0]]
        keep = ds.entry_at[tr] + HORIZON_MS + embargo_ms <= test_start
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
    economic_harness(
        np.asarray(all_y), np.asarray(all_p), np.asarray(all_r), payout,
        min_confidence, no_trade_low, no_trade_high, max_volatility,
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
    parser.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
    parser.add_argument("--no-trade-low", type=float, default=DEFAULT_NO_TRADE_LOW)
    parser.add_argument("--no-trade-high", type=float, default=DEFAULT_NO_TRADE_HIGH)
    parser.add_argument(
        "--max-volatility", type=float, default=DEFAULT_MAX_VOLATILITY_PCT
    )
    args = parser.parse_args()

    try:
        return train(
            args.data, args.model, args.test_size, args.seed, args.min_rows,
            args.walk_forward, args.folds, args.embargo_ms, args.payout,
            args.min_confidence, args.no_trade_low, args.no_trade_high,
            args.max_volatility,
        )
    except (FileNotFoundError, ValueError) as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
