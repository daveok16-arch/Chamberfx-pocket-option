#!/usr/bin/env python3
"""
Inference service — live direction probability for Pocket Option OTC pairs.
==========================================================================
FastAPI service that loads the model trained by `train.py` and scores the
collector's rolling 60s feature windows in real time.

Endpoints:
    POST /predict   -> probability (0.0-1.0) + direction (1|0) for one asset
    GET  /health    -> service + model state
    POST /reload    -> force a model reload from disk

Run:
    uvicorn app:app --host 0.0.0.0 --port 8000

The service deliberately returns HTTP 503 rather than a fabricated probability
when no model is loaded. A made-up number here would be indistinguishable from
a real prediction downstream, which is exactly the failure mode this whole
pipeline is meant to avoid.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from features import FEATURE_NAMES, build_vector

MODEL_PATH = Path(os.environ.get("MODEL_FILE", "./model.pkl"))
# Model file is re-read when its mtime changes, so a retrain in another process
# is picked up without restarting the service.
AUTO_RELOAD = os.environ.get("MODEL_AUTO_RELOAD", "1") == "1"
THRESHOLD = float(os.environ.get("PREDICTION_THRESHOLD", "0.5"))

app = FastAPI(
    title="Chamberfx OTC Direction Inference",
    description="Live binary-direction probability from rolling 60s tick features.",
    version="1.0.0",
)


class _ModelHolder:
    """Holds the loaded model, reloading from disk when it changes on disk."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._model: Any = None
        self._mtime: float | None = None
        self._lock = threading.Lock()

    def _current_mtime(self) -> float | None:
        try:
            return self.path.stat().st_mtime
        except FileNotFoundError:
            return None

    def get(self) -> Any | None:
        """Return the model, reloading if the file changed. None if absent."""
        with self._lock:
            mtime = self._current_mtime()
            if mtime is None:
                # Model deleted/unavailable — drop any stale reference.
                self._model = None
                self._mtime = None
                return None
            if self._model is None or (AUTO_RELOAD and mtime != self._mtime):
                self._model = joblib.load(self.path)
                self._mtime = mtime
            return self._model

    def force_reload(self) -> bool:
        with self._lock:
            self._mtime = None
        return self.get() is not None

    @property
    def mtime(self) -> float | None:
        return self._current_mtime()


holder = _ModelHolder(MODEL_PATH)


class PredictRequest(BaseModel):
    """One asset's rolling feature window."""

    asset: str = Field(..., description='Asset id, e.g. "EURUSD_otc"')
    features: dict[str, Any] = Field(
        ..., description="The collector's FeatureWindow payload"
    )


class PredictResponse(BaseModel):
    asset: str
    probability: float = Field(..., ge=0.0, le=1.0, description="P(UP)")
    direction: int = Field(..., description="1 = UP, 0 = DOWN")
    threshold: float
    model_mtime: float | None
    feature_count: int


@app.get("/health")
def health() -> dict[str, Any]:
    model = holder.get()
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "model_path": str(MODEL_PATH),
        "model_mtime": holder.mtime,
        "threshold": THRESHOLD,
        "feature_count": len(FEATURE_NAMES),
        "auto_reload": AUTO_RELOAD,
    }


@app.post("/reload")
def reload_model() -> dict[str, Any]:
    ok = holder.force_reload()
    return {"model_loaded": ok, "model_mtime": holder.mtime}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    """Score one rolling 60s feature window.

    Returns the true model probability of an UP outcome plus the discretised
    direction. 503 if no model is trained yet.
    """
    model = holder.get()
    if model is None:
        raise HTTPException(
            status_code=503,
            detail=(
                f"No trained model at {MODEL_PATH}. "
                "Run `python train.py` once the collector has gathered enough "
                "observations (>=200 rows)."
            ),
        )

    try:
        vector = build_vector(req.features, req.asset)
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Bad feature payload: {e}") from e

    X = np.asarray([vector], dtype=float)

    # Guard the model/feature contract drifting apart (e.g. a model trained
    # before a feature was added would silently score the wrong columns).
    expected = getattr(model, "n_features_in_", None)
    if expected is not None and X.shape[1] != expected:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Feature mismatch: model expects {expected} features, "
                f"got {X.shape[1]}. Retrain with the current features.py."
            ),
        )

    # predict_proba[:, 1] is P(class == 1) == P(UP).
    proba = float(model.predict_proba(X)[0][1])
    proba = min(max(proba, 0.0), 1.0)
    direction = 1 if proba >= THRESHOLD else 0

    return PredictResponse(
        asset=req.asset,
        probability=proba,
        direction=direction,
        threshold=THRESHOLD,
        model_mtime=holder.mtime,
        feature_count=len(vector),
    )
