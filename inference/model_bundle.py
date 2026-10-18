"""
Model artifact wrapper shared by training and serving.
=====================================================
Bundles the fitted forest with its optional isotonic calibrator so a single
`model.pkl` serves calibrated probabilities.

This lives in its own module — not in `train.py` — for a specific reason:
`joblib` records the defining module of a pickled class, so a wrapper defined in
`train.py` would be pickled as `__main__._Bundle` and fail to unpickle in the
serving process ("Can't get attribute '_Bundle' on <module '__main__'>").
Defining it here means both `train.py` and `app.py` resolve the same importable
class.

It deliberately exposes `n_features_in_` and `predict_proba`, so
`inference/app.py` needs no special-casing and its feature-count contract check
keeps working against the bundled model exactly as it did against a bare forest.
"""

from __future__ import annotations

from typing import Any

import numpy as np


class CalibratedModel:
    """A fitted estimator plus an optional probability calibrator.

    `feature_names` records the exact feature order the model was trained on.
    A count check alone is not enough: after a feature rename the vector still
    has the same length, so a model trained on the old schema would score a
    column that now means something else and quietly return plausible numbers.
    Serving compares names against the incoming contract and refuses on a
    mismatch.
    """

    def __init__(
        self,
        model: Any,
        calibrator: Any = None,
        feature_names: list[str] | None = None,
    ) -> None:
        self.model = model
        self.calibrator = calibrator
        self.feature_names = feature_names

    @property
    def n_features_in_(self) -> Any:
        return getattr(self.model, "n_features_in_", None)

    @property
    def feature_importances_(self) -> Any:
        return getattr(self.model, "feature_importances_", None)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Return a two-column probability matrix, calibrated when possible."""
        proba = self.model.predict_proba(X)
        if self.calibrator is None:
            return proba
        p1 = np.clip(self.calibrator.predict(proba[:, 1]), 0.0, 1.0)
        return np.column_stack([1.0 - p1, p1])
