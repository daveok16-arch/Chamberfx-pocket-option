"""
Feature contract — the single source of truth for the model's input vector.
==========================================================================
Shared by `train.py` (offline fitting) and `app.py` (live serving) so the
column order and scaling can never drift between the two.

Input is the `FeatureWindow` object the TypeScript collector writes into
`signals.json` / `live-prices.json`:

    {tickCount, open, close, high, low, netChange, netChangePct, range,
     avgAbsDelta, stdDev, upRatio, windowSpanSec, recentMomentumPct}

Raw price levels (open/close/high/low/netChange/range/stdDev/avgAbsDelta) are
deliberately NOT fed to the model. The six OTC pairs trade at wildly different
scales (XAUUSD ~4340 vs AUDUSD ~0.76), so raw magnitudes would let the model
recover asset identity from price level alone — it would split on "which pair
is this" instead of on market structure, and would not generalise. Every
magnitude feature is therefore divided by the window's open price to become
scale-free.

`upRatio` counts only directional ticks (FLAT ticks are excluded), and
`recentMomentumPct` is the return over the recent half of the window rather
than the full window — a second copy of `netChangePct` would only split
importance between two views of one signal.
"""

from __future__ import annotations

from typing import Any

# Assets the collector tracks. Order defines the one-hot column order.
ASSETS: list[str] = [
    "EURUSD_otc",
    "GBPUSD_otc",
    "USDJPY_otc",
    "XAUUSD_otc",
    "AUDUSD_otc",
    "USDCAD_otc",
]

# Scale-free numeric features, in canonical order.
NUMERIC_FEATURES: list[str] = [
    "tickCount",
    "netChangePct",
    "rangePct",
    "avgAbsDeltaPct",
    "stdDevPct",
    "upRatio",
    "windowSpanSec",
    "recentMomentumPct",
]

# One-hot asset columns, appended after the numeric block.
ASSET_FEATURES: list[str] = [f"asset_{a}" for a in ASSETS]

# The keys `build_vector` reads *directly* from a raw feature record. The
# remaining FEATURE_NAMES entries (rangePct, avgAbsDeltaPct, stdDevPct) are
# derived here by dividing by `open`, so they never appear in a record and must
# not be looked for there — a schema check against FEATURE_NAMES would flag
# them on every row. Keep this list in sync with the `_f(features, ...)` calls
# in `build_vector`.
RAW_FEATURE_KEYS: list[str] = [
    "tickCount",
    "open",
    "netChangePct",
    "range",
    "avgAbsDelta",
    "stdDev",
    "upRatio",
    "windowSpanSec",
    "recentMomentumPct",
]

FEATURE_NAMES: list[str] = NUMERIC_FEATURES + ASSET_FEATURES


def _f(features: dict[str, Any], key: str) -> float:
    """Read a numeric feature, tolerating missing/None/non-numeric values."""
    v = features.get(key)
    if v is None:
        return 0.0
    try:
        fv = float(v)
    except (TypeError, ValueError):
        return 0.0
    # NaN/inf would silently poison the model; treat as absent.
    if fv != fv or fv in (float("inf"), float("-inf")):
        return 0.0
    return fv


def build_vector(features: dict[str, Any], asset: str) -> list[float]:
    """Build the canonical feature vector from a raw feature window.

    Args:
        features: the collector's `FeatureWindow` payload.
        asset: asset id, e.g. "EURUSD_otc" (drives the one-hot block).

    Returns:
        A list of floats aligned with FEATURE_NAMES.
    """
    open_px = _f(features, "open")
    # Guard against a zero/absent open price so ratios stay finite.
    denom = open_px if open_px > 0 else 1.0

    numeric = [
        _f(features, "tickCount"),
        _f(features, "netChangePct"),
        _f(features, "range") / denom,
        _f(features, "avgAbsDelta") / denom,
        _f(features, "stdDev") / denom,
        _f(features, "upRatio"),
        _f(features, "windowSpanSec"),
        _f(features, "recentMomentumPct"),
    ]

    onehot = [1.0 if asset == a else 0.0 for a in ASSETS]
    return numeric + onehot
