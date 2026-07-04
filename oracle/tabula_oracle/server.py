"""FastAPI service exposing the TabFM engine to keeper bots and frontends."""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .tabfm_engine import TabFMEngine, Q_SCALE, dynamic_b, probs_to_q6

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)


class LiveState(BaseModel):
    minute: int
    score_diff: int
    shots_on_target: int
    possession: float
    corners_so_far: int


class HistoryRow(LiveState):
    outcome_bin: int


class PredictRequest(BaseModel):
    match_id: str
    stat_type: str = Field(..., description="TabulaMarkets stat_type (e.g. corners_h2)")
    bin_edges: List[int] = Field(..., description="Length = n_classes + 1")
    history: List[HistoryRow]
    live: LiveState
    base_b: int = Field(5_000_000, description="Base LMSR liquidity parameter")


class PredictResponse(BaseModel):
    match_id: str
    probs_q6: List[int]
    probs_float: List[float]
    liquidity_b: int
    ensemble_divergence: float
    latency_ms: float
    model_backend: str
    n_classes: int


app = FastAPI(
    title="Tabula Oracle",
    version="0.1.0",
    description="TabFM zero-shot probability oracle for TabulaMarkets",
)

# ----------------------------------------------------------------------
# Engine bootstrap (lazy, so tests can override).
# ----------------------------------------------------------------------
_engine: Optional[TabFMEngine] = None


def get_engine() -> TabFMEngine:
    global _engine
    if _engine is None:
        n = int(os.environ.get("TABULA_ENSEMBLE_SIZE", "32"))
        _engine = TabFMEngine(ensemble_size=n)
    return _engine


@app.on_event("startup")
def _warm() -> None:
    get_engine()


# ----------------------------------------------------------------------
# Endpoints
# ----------------------------------------------------------------------
@app.get("/health")
def health() -> Dict[str, Any]:
    eng = get_engine()
    return {"ok": True, "backend": eng.backend}


@app.get("/model")
def model_info() -> Dict[str, Any]:
    eng = get_engine()
    return {
        "backend": eng.backend,
        "ensemble_size": eng.ensemble_size,
        "model_id": "google/tabfm-1.0.0-pytorch" if eng.backend != "mock" else "mock",
        "q_scale": Q_SCALE,
    }


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    if len(req.bin_edges) < 3:
        raise HTTPException(status_code=400, detail="bin_edges must have >=3 elements")
    n_classes = len(req.bin_edges) - 1
    if n_classes > 10:
        raise HTTPException(status_code=400, detail="TabFM hard limit: max 10 classes")

    if not req.history:
        raise HTTPException(status_code=400, detail="history must not be empty")

    class_labels: List[int] = list(range(n_classes))
    history_df = pd.DataFrame([h.model_dump() for h in req.history])
    y_train = history_df.pop("outcome_bin").to_numpy(dtype=np.int64)
    # Validate labels are within range
    if (y_train < 0).any() or (y_train >= n_classes).any():
        raise HTTPException(status_code=400, detail="history outcome_bin out of range")

    live_df = pd.DataFrame([req.live.model_dump()])

    eng = get_engine()
    result = eng.predict(
        history=history_df,
        y_train=y_train,
        live=live_df,
        class_labels=class_labels,
    )

    q6 = probs_to_q6(result.probs)
    b = dynamic_b(req.base_b, result.ensemble_divergence)

    return PredictResponse(
        match_id=req.match_id,
        probs_q6=q6,
        probs_float=[float(x) for x in result.probs],
        liquidity_b=b,
        ensemble_divergence=result.ensemble_divergence,
        latency_ms=result.latency_ms,
        model_backend=result.backend,
        n_classes=n_classes,
    )
