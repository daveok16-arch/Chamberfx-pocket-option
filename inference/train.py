#!/usr/bin/env python3
"""
Training loop — fits a direction classifier on collected observations.
=======================================================================
Reads the supervised-learning dataset produced by the TypeScript collector
(`signals.json`) and writes a trained model to `model.pkl`.

Dataset shape (one record per 60s observation):
    {type:"OBSERVATION", asset, entryAt, entryPrice, resolvedAt,
     expirationPrice, delta, label (0|1), outcome, features:{...}, source}

Usage:
    python train.py                         # train on ./signals.json
    python train.py --data ../price-bot/signals.json
    python train.py --model model.pkl --test-size 0.2
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split

from features import FEATURE_NAMES, build_vector

# A model trained on a handful of rows is worse than no model: it produces
# confident-looking probabilities from noise. Refuse to emit one below this.
MIN_ROWS_TO_TRAIN = 200
# Below this the metrics are too noisy to trust for a go/no-go decision.
MIN_ROWS_FOR_MEANINGFUL_METRICS = 1000


def load_dataset(path: Path) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Load and vectorise the observation dataset.

    Returns:
        (X, y, assets). Records that are malformed or carry an out-of-range
        label are skipped rather than silently coerced.
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

    X: list[list[float]] = []
    y: list[int] = []
    assets: list[str] = []
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
        if not isinstance(features, dict) or not isinstance(asset, str):
            skipped += 1
            continue
        X.append(build_vector(features, asset))
        y.append(int(label))
        assets.append(asset)

    if skipped:
        print(f"[data] skipped {skipped} malformed record(s)")

    return np.asarray(X, dtype=float), np.asarray(y, dtype=int), assets


def train(
    data_path: Path, model_path: Path, test_size: float, seed: int, min_rows: int
) -> int:
    print(f"[data] loading {data_path}")
    X, y, assets = load_dataset(data_path)

    n = len(y)
    print(f"[data] {n} labelled observation(s), {len(set(assets))} asset(s)")
    if n == 0:
        print("[error] no usable rows — nothing to train on", file=sys.stderr)
        return 1

    # Class balance. A lopsided split is the first thing to check, because it
    # makes raw accuracy look good while precision is meaningless.
    pos = int(y.sum())
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

    # stratify keeps the class ratio in both splits; without it a small dataset
    # can produce a test set of a single class and crash roc_auc_score.
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=test_size, random_state=seed, stratify=y
    )
    print(f"[split] train={len(y_tr)} test={len(y_te)} (test_size={test_size})")

    # RandomForest is the default: it needs no feature scaling, tolerates the
    # mixed scales here, gives calibrated-ish probabilities via predict_proba,
    # and — importantly for this project — exposes feature_importances_ so we
    # can confirm the model didn't just learn asset identity.
    model = RandomForestClassifier(
        n_estimators=300,
        max_depth=8,          # shallow: it is a hedge against overfitting this dataset
        min_samples_leaf=10,
        random_state=seed,
        n_jobs=-1,
        class_weight="balanced",
    )
    model.fit(X_tr, y_tr)

    # --- Evaluation -----------------------------------------------------
    proba = model.predict_proba(X_te)[:, 1]
    pred = (proba >= 0.5).astype(int)

    acc = accuracy_score(y_te, pred)
    prec = precision_score(y_te, pred, zero_division=0)
    rec = recall_score(y_te, pred, zero_division=0)
    try:
        auc = roc_auc_score(y_te, proba)
    except ValueError:
        auc = float("nan")

    print("\n[eval] held-out performance")
    print(f"  accuracy : {acc:.4f}")
    print(f"  precision: {prec:.4f}")
    print(f"  recall   : {rec:.4f}")
    print(f"  roc_auc  : {auc:.4f}")
    print(f"  confusion matrix [[tn fp],[fn tp]]: {confusion_matrix(y_te, pred).tolist()}")

    # A binary-options edge needs to beat the break-even implied by the payout
    # (~52% at 0.92). Report the gap explicitly so it isn't mistaken for skill.
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

    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, model_path)
    print(f"\n[save] wrote {model_path} ({model_path.stat().st_size} bytes)")
    return 0


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
    args = parser.parse_args()

    try:
        return train(args.data, args.model, args.test_size, args.seed, args.min_rows)
    except (FileNotFoundError, ValueError) as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())