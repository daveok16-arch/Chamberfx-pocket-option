#!/usr/bin/env python3
"""
Serving-contract tests for app.py.
=================================
`/predict` must refuse a model whose feature *identity* differs from the
service's, not just one whose feature *count* differs. A rename keeps the
column count, so a count-only check would let a stale model score a column that
now means something else and return a plausible-looking number.

Runs with the stdlib `unittest` and no HTTP client: `holder` is swapped for a
stub and the endpoint function is called directly. `fastapi.HTTPException` is
the only framework object touched, and it is raised by app.py itself.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app as app_module
from features import FEATURE_NAMES


class _StubModel:
    """A stand-in that records the matrix it was asked to score."""

    def __init__(self, feature_names, n_features=None):
        self.feature_names = feature_names
        self.n_features_in_ = n_features if n_features is not None else len(FEATURE_NAMES)
        self.seen = None

    def predict_proba(self, X):
        self.seen = X
        return np.asarray([[0.4, 0.6]])


class _StubHolder:
    def __init__(self, model):
        self._model = model
        self.mtime = 123.0

    def get(self):
        return self._model

    def force_reload(self):
        return True


class TestPredictContract(unittest.TestCase):
    def setUp(self):
        self._orig_holder = app_module.holder
        self.addCleanup(self._restore)

    def _restore(self):
        app_module.holder = self._orig_holder

    def _request(self):
        return app_module.PredictRequest(
            asset="EURUSD_otc",
            features={
                "open": 1.15, "tickCount": 120, "netChangePct": 0.001,
                "range": 1e-4, "avgAbsDelta": 1e-5, "stdDev": 2e-5,
                "upRatio": 0.55, "windowSpanSec": 59.0, "recentMomentumPct": 0.0005,
            },
        )

    def test_matching_schema_scores(self):
        app_module.holder = _StubHolder(_StubModel(list(FEATURE_NAMES)))
        resp = app_module.predict(self._request())
        self.assertEqual(resp.feature_count, len(FEATURE_NAMES))
        self.assertAlmostEqual(resp.probability, 0.6, places=6)

    def test_renamed_feature_is_refused(self):
        """Same length, different name — must 409, not silently score."""
        renamed = list(FEATURE_NAMES)
        renamed[0] = "someOldName"
        app_module.holder = _StubHolder(_StubModel(renamed))
        with self.assertRaises(app_module.HTTPException) as ctx:
            app_module.predict(self._request())
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("trained on", ctx.exception.detail)

    def test_wrong_count_is_refused(self):
        """A bare estimator without names still gets the count check."""
        stub = _StubModel(None, n_features=len(FEATURE_NAMES) + 1)
        stub.feature_names = None
        app_module.holder = _StubHolder(stub)
        with self.assertRaises(app_module.HTTPException) as ctx:
            app_module.predict(self._request())
        self.assertEqual(ctx.exception.status_code, 409)

    def test_no_model_returns_503(self):
        app_module.holder = _StubHolder(None)
        with self.assertRaises(app_module.HTTPException) as ctx:
            app_module.predict(self._request())
        self.assertEqual(ctx.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main(verbosity=2)
