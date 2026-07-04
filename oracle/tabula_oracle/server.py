"""FastAPI service exposing the TabFM engine to keeper bots and frontends.

Production hardening:
  * structured logging (json when LOG_JSON=1)
  * /metrics endpoint with Prometheus counters + histograms
  * /healthz + /readyz probes
  * strict request validation with 400-on-error
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Response
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from pydantic import BaseModel, Field

from .tabfm_engine import Q_SCALE, TabFMEngine, dynamic_b, probs_to_q6

# ----------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------
if os.environ.get("LOG_JSON") == "1":
    import json as _json

    class JsonFormatter(logging.Formatter):
        def format(self, record: logging.LogRecord) -> str:  # noqa: D401
            payload = {
                "ts":     self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
                "level":  record.levelname,
                "logger": record.name,
                "msg":    record.getMessage(),
            }
            if record.exc_info:
                payload["exc"] = self.formatException(record.exc_info)
            return _json.dumps(payload)

    _handler = logging.StreamHandler()
    _handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), handlers=[_handler])
else:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

log = logging.getLogger("tabula_oracle")

# ----------------------------------------------------------------------
# Metrics
# ----------------------------------------------------------------------
PRED_COUNTER = Counter(
    "tabula_oracle_predict_total", "Number of /predict calls", ["backend", "status"]
)
PRED_LATENCY = Histogram(
    "tabula_oracle_predict_latency_ms",
    "Latency of /predict in milliseconds",
    ["backend"],
    buckets=(5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000),
)
BACKEND_GAUGE = Gauge(
    "tabula_oracle_backend_up", "1 if backend is loaded, 0 otherwise", ["backend"]
)


# ----------------------------------------------------------------------
# Schemas
# ----------------------------------------------------------------------
class LiveState(BaseModel):
    minute: int = Field(..., ge=0, le=180)
    score_diff: int
    shots_on_target: int = Field(..., ge=0)
    possession: float = Field(..., ge=0.0, le=100.0)
    corners_so_far: int = Field(..., ge=0)


class HistoryRow(LiveState):
    outcome_bin: int = Field(..., ge=0, le=9)


class PredictRequest(BaseModel):
    match_id: str = Field(..., min_length=1, max_length=64)
    stat_type: str = Field(..., min_length=1, max_length=16)
    bin_edges: List[int]
    history: List[HistoryRow]
    live: LiveState
    base_b: int = Field(5_000_000, ge=1, le=10_000_000_000)


class PredictResponse(BaseModel):
    match_id: str
    probs_q6: List[int]
    probs_float: List[float]
    liquidity_b: int
    ensemble_divergence: float
    latency_ms: float
    model_backend: str
    n_classes: int


# ----------------------------------------------------------------------
# App + engine
# ----------------------------------------------------------------------
app = FastAPI(
    title="Tabula Oracle",
    version="0.2.0",
    description="TabFM zero-shot probability oracle for TabulaMarkets",
)

_engine: Optional[TabFMEngine] = None


def get_engine() -> TabFMEngine:
    global _engine
    if _engine is None:
        n = int(os.environ.get("TABULA_ENSEMBLE_SIZE", "32"))
        _engine = TabFMEngine(ensemble_size=n)
        BACKEND_GAUGE.labels(backend=_engine.backend).set(1)
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
    return {"ok": True, "backend": eng.backend, "device": eng.device}


@app.get("/healthz")
def healthz() -> Dict[str, Any]:
    return {"ok": True, "ts": time.time()}


@app.get("/readyz")
def readyz() -> Dict[str, Any]:
    eng = get_engine()
    return {"ready": eng.backend != "unloaded", "backend": eng.backend}


@app.get("/metrics")
def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/model")
def model_info() -> Dict[str, Any]:
    eng = get_engine()
    return {
        "backend":        eng.backend,
        "device":         eng.device,
        "ensemble_size":  eng.ensemble_size,
        "model_id":       "google/tabfm-1.0.0-pytorch" if eng.backend != "mock" else "mock",
        "q_scale":        Q_SCALE,
    }


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    eng = get_engine()
    t0 = time.perf_counter()

    try:
        if len(req.bin_edges) < 3:
            raise HTTPException(status_code=400, detail="bin_edges must have >=3 elements")
        n_classes = len(req.bin_edges) - 1
        if n_classes > 10:
            raise HTTPException(status_code=400, detail="TabFM hard limit: max 10 classes")
        for a, b in zip(req.bin_edges, req.bin_edges[1:]):
            if a >= b:
                raise HTTPException(status_code=400,
                                    detail="bin_edges must be strictly monotonic")
        if not req.history:
            raise HTTPException(status_code=400, detail="history must not be empty")
        if len(req.history) > 5_000:
            raise HTTPException(status_code=400, detail="history too large (max 5000 rows)")

        class_labels: List[int] = list(range(n_classes))
        history_df = pd.DataFrame([h.model_dump() for h in req.history])
        y_train = history_df.pop("outcome_bin").to_numpy(dtype=np.int64)
        if (y_train < 0).any() or (y_train >= n_classes).any():
            raise HTTPException(status_code=400, detail="history outcome_bin out of range")

        live_df = pd.DataFrame([req.live.model_dump()])

        result = eng.predict(
            history=history_df,
            y_train=y_train,
            live=live_df,
            class_labels=class_labels,
        )

        q6 = probs_to_q6(result.probs)
        b = dynamic_b(req.base_b, result.ensemble_divergence)

        PRED_COUNTER.labels(backend=result.backend, status="ok").inc()
        PRED_LATENCY.labels(backend=result.backend).observe(result.latency_ms)

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
    except HTTPException:
        PRED_COUNTER.labels(backend=eng.backend, status="client_error").inc()
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("predict failed")
        PRED_COUNTER.labels(backend=eng.backend, status="server_error").inc()
        raise HTTPException(status_code=500, detail=f"internal: {type(e).__name__}")
    finally:
        _ = time.perf_counter() - t0  # (already captured in engine result)


# ----------------------------------------------------------------------
# Console entrypoint
# ----------------------------------------------------------------------
def _run_uvicorn() -> None:
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8787"))
    workers = int(os.environ.get("UVICORN_WORKERS", "1"))
    uvicorn.run(
        "tabula_oracle.server:app",
        host=host,
        port=port,
        workers=workers,
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
    )
