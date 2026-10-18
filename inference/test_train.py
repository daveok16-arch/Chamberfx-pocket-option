"""Regression tests for the training-side leakage guards.

These cover the purge in `chronological_split` and the horizon measurement in
`load_dataset`. The purge is the one thing standing between a longer label
horizon and a silently inflated score, so it is worth pinning.

Run: python -m unittest test_train -v   (from inference/)
"""

from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

from features import FEATURE_NAMES
from train import Dataset, _report_block_null, chronological_split, load_dataset

# A plausible 60s spacing between observations, as the collector produces.
STEP_MS = 60_000


def _make_dataset(n: int, horizon_ms: int) -> Dataset:
    """A synthetic dataset with `n` rows spaced STEP_MS apart."""
    start = 1_789_863_600_000
    entry_at = np.asarray([start + i * STEP_MS for i in range(n)], dtype=np.int64)
    ncols = len(FEATURE_NAMES)
    return Dataset(
        X=np.zeros((n, ncols), dtype=float),
        y=np.asarray([i % 2 for i in range(n)], dtype=int),
        assets=["EURUSD_otc"] * n,
        entry_at=entry_at,
        range_pct=np.zeros(n, dtype=float),
        horizon_ms=horizon_ms,
    )


class TestPurgeHonoursHorizon(unittest.TestCase):
    def test_row_inside_long_horizon_is_purged(self):
        """A row one step before the seam leaks under a 180s horizon, not under 60s.

        Its label resolves 180s after entry, i.e. 120s *after* the test period
        starts. Training on it would mean training on test-period prices.
        """
        n = 200
        ds = _make_dataset(n, horizon_ms=180_000)
        split = int(n * 0.8)
        seam = ds.entry_at[split]

        train_idx, test_idx = chronological_split(ds, test_size=0.2, embargo_ms=0)

        # The row one step before the seam must not survive.
        leaking = np.where(ds.entry_at == seam - STEP_MS)[0][0]
        self.assertNotIn(
            leaking, train_idx,
            "row whose 180s label reaches into the test period was kept",
        )
        # Sanity: no surviving train row's horizon crosses the seam either.
        if len(train_idx) > 0:
            latest = ds.entry_at[train_idx] + ds.horizon_ms
            self.assertLessEqual(int(latest.max()), int(seam))

    def test_short_horizon_keeps_the_same_row(self):
        """Under a 60s horizon the same row is legitimate — it resolves before
        the seam. This pins that the fix did not over-purge."""
        n = 200
        ds = _make_dataset(n, horizon_ms=60_000)
        split = int(n * 0.8)
        seam = ds.entry_at[split]

        train_idx, _ = chronological_split(ds, test_size=0.2, embargo_ms=0)
        row = np.where(ds.entry_at == seam - STEP_MS)[0][0]
        self.assertIn(row, train_idx)

    def test_longer_horizon_purges_at_least_as_much(self):
        n = 400
        short = _make_dataset(n, horizon_ms=60_000)
        long = _make_dataset(n, horizon_ms=300_000)
        ts, _ = chronological_split(short, 0.2, 0)
        tl, _ = chronological_split(long, 0.2, 0)
        self.assertLessEqual(len(tl), len(ts))


class TestHorizonMeasurement(unittest.TestCase):
    def _write(self, records: list[dict]) -> Path:
        fh = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        )
        json.dump(records, fh)
        fh.close()
        self.addCleanup(Path(fh.name).unlink, missing_ok=True)
        return Path(fh.name)

    def _record(self, entry_at: int, resolved_at: int, label: int) -> dict:
        return {
            "type": "OBSERVATION",
            "asset": "EURUSD_otc",
            "entryAt": entry_at,
            "resolvedAt": resolved_at,
            "entryPrice": 1.15,
            "expirationPrice": 1.1501,
            "delta": 1e-4,
            "label": label,
            "outcome": "UP" if label else "DOWN",
            "features": {"open": 1.15, "range": 1e-4, "tickCount": 100},
            "source": "test",
        }

    def test_measures_180s_horizon_from_records(self):
        base = 1_789_863_600_000
        recs = [
            self._record(base + i * STEP_MS, base + i * STEP_MS + 180_000, i % 2)
            for i in range(20)
        ]
        ds = load_dataset(self._write(recs))
        self.assertEqual(ds.horizon_ms, 180_000)

    def test_falls_back_when_resolved_at_absent(self):
        base = 1_789_863_600_000
        recs = []
        for i in range(20):
            r = self._record(base + i * STEP_MS, base + i * STEP_MS + 60_000, i % 2)
            del r["resolvedAt"]
            recs.append(r)
        ds = load_dataset(self._write(recs))
        self.assertEqual(ds.horizon_ms, 60_000)


    def test_jittered_horizons_do_not_count_as_mixed(self):
        """A 180s label lands at 180005/180467/194628ms — tick jitter, one
        horizon. It must not be treated as a mix."""
        base = 1_789_863_600_000
        jitter = [0, 5, 467, 1_500, 14_628, 899]
        recs = [
            self._record(base + i * STEP_MS, base + i * STEP_MS + 180_000 + jitter[i % len(jitter)], i % 2)
            for i in range(20)
        ]
        ds = load_dataset(self._write(recs))
        self.assertEqual(round(ds.horizon_ms / 60_000), 3)

    def test_true_mixed_horizons_are_refused(self):
        """A file spanning a 60s -> 180s change is two problems in one file."""
        base = 1_789_863_600_000
        recs = [
            self._record(base + i * STEP_MS, base + i * STEP_MS + 60_000, i % 2)
            for i in range(10)
        ] + [
            self._record(base + (10 + i) * STEP_MS, base + (10 + i) * STEP_MS + 180_000, i % 2)
            for i in range(10)
        ]
        with self.assertRaises(ValueError) as ctx:
            load_dataset(self._write(recs))
        self.assertIn("mixes label horizons", str(ctx.exception))


class TestSchemaDriftGuard(unittest.TestCase):
    """The guard must fire on genuinely-absent raw keys and stay quiet on keys
    that `build_vector` derives (rangePct etc.), which never appear in records.
    Getting this backwards makes the guard cry wolf on every clean dataset."""

    def _write(self, records: list[dict]) -> Path:
        fh = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump(records, fh)
        fh.close()
        self.addCleanup(Path(fh.name).unlink, missing_ok=True)
        return Path(fh.name)

    def _record(self, base: int, i: int, feats: dict) -> dict:
        return {
            "type": "OBSERVATION",
            "asset": "EURUSD_otc",
            "entryAt": base + i * STEP_MS,
            "resolvedAt": base + i * STEP_MS + 60_000,
            "label": i % 2,
            "features": feats,
            "source": "test",
        }

    def _full_features(self) -> dict:
        return {
            "open": 1.15, "tickCount": 100, "netChangePct": 0.001,
            "range": 1e-4, "avgAbsDelta": 1e-5, "stdDev": 2e-5,
            "upRatio": 0.5, "windowSpanSec": 59.0, "recentMomentumPct": 0.0005,
        }

    def _run(self, records: list[dict]) -> str:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            load_dataset(self._write(records))
        return buf.getvalue()

    def test_clean_data_does_not_warn(self):
        base = 1_789_863_600_000
        recs = [self._record(base, i, self._full_features()) for i in range(20)]
        out = self._run(recs)
        self.assertNotIn("SCHEMA DRIFT", out)

    def test_derived_keys_absent_do_not_warn(self):
        """rangePct/avgAbsDeltaPct/stdDevPct are computed in build_vector, so
        their absence from a record is normal — not drift."""
        base = 1_789_863_600_000
        feats = self._full_features()
        for derived in ("rangePct", "avgAbsDeltaPct", "stdDevPct"):
            self.assertNotIn(derived, feats)
        recs = [self._record(base, i, feats) for i in range(20)]
        self.assertNotIn("SCHEMA DRIFT", self._run(recs))

    def test_absent_renamed_key_warns(self):
        base = 1_789_863_600_000
        recs = []
        for i in range(20):
            f = self._full_features()
            del f["recentMomentumPct"]  # the pre-rename schema
            recs.append(self._record(base, i, f))
        out = self._run(recs)
        self.assertIn("SCHEMA DRIFT", out)
        self.assertIn("recentMomentumPct", out)


class TestBlockNull(unittest.TestCase):
    """The block null must not claim significance when the predictions carry no
    information, and must claim it when they do. It reuses predictions, so a
    bug here is silent — it never raises, it just prints the wrong verdict."""

    def test_pure_noise_is_not_significant(self):
        rng = np.random.default_rng(0)
        y = rng.integers(0, 2, 200)
        p = rng.random(200)
        real = roc_auc_score(y, p)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            _report_block_null(y, p, real, n_shift=300, seed=1)
        self.assertIn("does NOT clear the block null", buf.getvalue())

    def test_real_signal_is_significant(self):
        rng = np.random.default_rng(0)
        y = rng.integers(0, 2, 400)
        # Predictions aligned with labels -> AUC well above 0.5.
        p = np.where(y == 1, rng.uniform(0.6, 1.0, 400), rng.uniform(0.0, 0.4, 400))
        real = roc_auc_score(y, p)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            _report_block_null(y, p, real, n_shift=300, seed=1)
        self.assertIn("survives the stricter block null", buf.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
