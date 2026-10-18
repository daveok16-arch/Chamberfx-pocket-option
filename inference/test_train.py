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
import joblib
from sklearn.metrics import roc_auc_score

from features import FEATURE_NAMES
from model_bundle import PlattCalibrator
from train import (
    Dataset,
    _calibrator_improves_brier,
    _fit_calibrated,
    _report_block_null,
    chronological_split,
    load_dataset,
    train,
)

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


class TestRefitFull(unittest.TestCase):
    """`--refit-full` must make the *saved* model use more rows than the one that
    produced the metrics, without changing the metrics. Pinned on the artifact,
    not on the log line, because the failure mode is a model silently trained on
    a subset."""

    def _write(self, records: list[dict]) -> Path:
        fh = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump(records, fh)
        fh.close()
        self.addCleanup(Path(fh.name).unlink, missing_ok=True)
        return Path(fh.name)

    def _records(self, n: int) -> list[dict]:
        rng = np.random.default_rng(0)
        base = 1_789_863_600_000
        recs = []
        for i in range(n):
            x = float(rng.normal(0, 1))
            recs.append({
                "type": "OBSERVATION",
                "asset": "EURUSD_otc",
                "entryAt": base + i * STEP_MS,
                "resolvedAt": base + i * STEP_MS + 60_000,
                "entryPrice": 1.15,
                "expirationPrice": 1.1501,
                "delta": 1e-4,
                "label": 1 if x > 0 else 0,
                "outcome": "UP" if x > 0 else "DOWN",
                "features": {
                    "open": 1.15, "tickCount": 100, "netChangePct": x * 1e-3,
                    "range": 1e-4, "avgAbsDelta": 1e-5, "stdDev": 2e-5,
                    "upRatio": 0.5, "windowSpanSec": 59.0,
                    "recentMomentumPct": x * 1e-4,
                },
                "source": "test",
            })
        return recs

    def _run(self, data: Path, model: Path, refit: bool) -> None:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = train(
                data, model, 0.2, 42, 10, False, 5, 60_000, 0.92,
                0.65, 0.36, 0.64, 0.02, 5, refit,
            )
        self.assertEqual(rc, 0, buf.getvalue())

    @staticmethod
    def _rows_seen(model_path: Path) -> int:
        """Root node sample count of the first tree == training-set size."""
        bundle = joblib.load(model_path)
        return int(bundle.model.estimators_[0].tree_.n_node_samples[0])

    def test_refit_full_trains_the_saved_model_on_more_rows(self):
        data = self._write(self._records(250))
        with tempfile.TemporaryDirectory() as td:
            plain = Path(td) / "plain.pkl"
            full = Path(td) / "full.pkl"
            self._run(data, plain, refit=False)
            self._run(data, full, refit=True)
            n_plain = self._rows_seen(plain)
            n_full = self._rows_seen(full)
        self.assertGreater(
            n_full, n_plain,
            "refit-full saved a model that did not see more rows than the default",
        )


class TestCalibratorDoesNotSaturate(unittest.TestCase):
    """The calibrator must not turn a middling raw score into certainty.

    Isotonic regression is non-parametric: on the ~30-row calibration slices
    this project produces it steps straight to exactly 0.0/1.0. The confidence
    filter reads 1.0 as certainty, so a raw 0.58 would mint a full-confidence
    signal — and the live engine showed exactly that (P(UP)=1.0000 in the logs).
    Platt has two parameters, so it stays strictly inside (0, 1).
    """

    def _slice(self, n: int = 40) -> tuple[np.ndarray, np.ndarray]:
        rng = np.random.default_rng(7)
        raw = rng.uniform(0.3, 0.7, size=n)
        # A real but weak relationship, so the fit is not degenerate.
        y = (raw + rng.normal(0, 0.25, size=n) > 0.5).astype(int)
        if len(set(y.tolist())) < 2:
            y[0], y[1] = 0, 1
        return raw, y

    def test_platt_stays_inside_the_open_unit_interval(self):
        raw, y = self._slice()
        cal = PlattCalibrator.fit(raw, y)
        out = cal.predict(np.array([0.0, 0.05, 0.5, 0.95, 1.0]))
        self.assertTrue(np.all(out > 0.0) and np.all(out < 1.0), out)
        self.assertFalse(np.any(out == 0.0) or np.any(out == 1.0))

    def test_platt_is_monotone_and_finite(self):
        raw, y = self._slice()
        cal = PlattCalibrator.fit(raw, y)
        grid = np.linspace(0, 1, 50)
        out = cal.predict(grid)
        self.assertTrue(np.all(np.isfinite(out)))
        self.assertTrue(np.all(np.diff(out) >= -1e-12), "Platt map is not monotone")

    def test_platt_survives_pickle_round_trip(self):
        """Serving unpickles the bundle in a different process; the calibrator
        must round-trip like `CalibratedModel` does."""
        import joblib
        import tempfile
        from pathlib import Path

        raw, y = self._slice()
        cal = PlattCalibrator.fit(raw, y)
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "c.pkl"
            joblib.dump(cal, p)
            back = joblib.load(p)
        np.testing.assert_allclose(cal.predict(raw), back.predict(raw))


class TestCalibratorIsRejectedWhenItHurts(unittest.TestCase):
    """A calibration map is only kept when it demonstrably helps.

    The failure this pins: a Platt map fitted on a weak model compressed the
    entire raw range into the no-trade zone, so the deployed engine could never
    emit a signal — it went permanently silent while every prediction looked
    plausible. The map's own out-of-fold Brier score is the evidence, so a map
    that does not beat raw probabilities must not be saved.
    """

    def _slice(self, n: int, *, overconfident: bool) -> tuple[np.ndarray, np.ndarray]:
        """Scores whose relationship to the label is known.

        `overconfident=False` produces raw scores that are already calibrated
        (the label is drawn from the score itself), so no monotone remap can
        help. `overconfident=True` deliberately exaggerates the score's
        confidence, which is exactly what Platt exists to correct.
        """
        rng = np.random.default_rng(3)
        z = rng.normal(0, 1.2, size=n)
        p_true = 1.0 / (1.0 + np.exp(-z))
        y = (rng.uniform(size=n) < p_true).astype(int)
        k = 5.0 if overconfident else 1.0
        raw = 1.0 / (1.0 + np.exp(-k * z))
        return raw, y

    def test_guard_accepts_a_map_that_helps(self):
        raw, y = self._slice(400, overconfident=True)
        improves, raw_b, cal_b = _calibrator_improves_brier(raw, y)
        self.assertTrue(improves, f"raw={raw_b:.4f} calibrated={cal_b:.4f}")

    def test_guard_rejects_a_map_that_does_not_help(self):
        """Already-calibrated scores: there is nothing to fix, so the map must
        not be kept just because it ran without error."""
        raw, y = self._slice(400, overconfident=False)
        improves, _, _ = _calibrator_improves_brier(raw, y)
        self.assertFalse(improves)

    def test_fit_calibrated_returns_none_when_the_map_hurts(self):
        """End-to-end: a useless slice yields calibrator=None and a note, so the
        saved model serves raw probabilities instead of a squashed map."""
        rng = np.random.default_rng(11)
        n = 120
        X = rng.normal(size=(n, len(FEATURE_NAMES)))
        y = rng.integers(0, 2, size=n)  # labels independent of X
        X_cal, y_cal = X[:64], y[:64]
        if len(set(y_cal.tolist())) < 2:
            y_cal[0], y_cal[1] = 0, 1
        _, calibrator, note = _fit_calibrated(X[64:], y[64:], X_cal, y_cal, 0)
        self.assertIsNone(calibrator, note)
        self.assertIn("rejected", note)

    def test_deployed_output_can_reach_the_confidence_gate(self):
        """The engine must be able to emit *something*.

        Regression for the silence bug: if the served probability range lies
        entirely inside the no-trade zone [0.36, 0.64], every window is
        discarded forever no matter how strong the signal.
        """
        NT_LOW, NT_HIGH, GATE = 0.36, 0.64, 0.65
        rng = np.random.default_rng(5)
        n = 200
        X = rng.normal(size=(n, len(FEATURE_NAMES)))
        # A learnable relationship, so the forest produces a spread of scores.
        y = (X[:, 0] + X[:, 1] > 0).astype(int)
        model, calibrator, _ = _fit_calibrated(
            X[:120], y[:120], X[120:180], y[120:180], 0
        )

        grid = np.linspace(0, 1, 10001)
        out = np.clip(calibrator.predict(grid), 0, 1) if calibrator is not None else grid

        def passes(p: float) -> bool:
            return max(p, 1 - p) >= GATE and not (NT_LOW <= p <= NT_HIGH)

        self.assertTrue(
            any(passes(float(v)) for v in out),
            "served probabilities can never clear the confidence gate",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
