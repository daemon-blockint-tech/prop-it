"""tabfm_engine
================

Wrapper around the Google Research TabFM classifier ensemble.

Production install (real model, PyTorch backend):

    pip install ".[tabfm]"     # brings in tabfm[pytorch] @ github.com/google-research/tabfm

The engine transparently downloads model weights from the HuggingFace Hub
(`google/tabfm-1.0.0-pytorch`) on first use. Set the environment variable
``HF_HOME`` to control the cache directory in constrained environments.

If TabFM is not installable (CI runners without CUDA, laptops without
enough RAM) set ``TABULA_ORACLE_MOCK=1`` to force the deterministic mock
engine. The mock preserves the exact public surface of ``predict()`` so
downstream services can be tested end-to-end.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np
import pandas as pd

log = logging.getLogger(__name__)

Q_SCALE = 1_000_000

TABFM_MODEL_ID = os.environ.get("TABFM_MODEL_ID", "google/tabfm-1.0.0-pytorch")
TABFM_DEVICE   = os.environ.get("TABFM_DEVICE",   "auto")  # "auto" | "cpu" | "cuda"


@dataclass
class PredictionResult:
    probs: np.ndarray            # shape (n_classes,), float in [0,1], sums to ~1
    ensemble_divergence: float   # mean pairwise TV distance across ensemble members
    latency_ms: float
    backend: str                 # "tabfm-pytorch" | "mock"


def _resolve_device() -> str:
    if TABFM_DEVICE != "auto":
        return TABFM_DEVICE
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            return "cuda"
        # Apple Silicon (M-series) — TabFM's pytorch backend supports MPS.
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


class TabFMEngine:
    """Loads TabFM once and serves in-context predictions."""

    def __init__(self, ensemble_size: int = 32, prefer_backend: str = "pytorch"):
        self.ensemble_size = ensemble_size
        self.prefer_backend = prefer_backend
        self._clf = None
        self._backend = "mock"
        self._device: str = "cpu"
        self._load()

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------
    def _load(self) -> None:
        if os.environ.get("TABULA_ORACLE_MOCK") == "1":
            log.warning("TABULA_ORACLE_MOCK=1 — using deterministic mock engine.")
            self._backend = "mock"
            return

        try:
            self._device = _resolve_device()
            log.info("Loading TabFM v1.0.0 (PyTorch) on device=%s from %s …",
                     self._device, TABFM_MODEL_ID)

            # Preferred entrypoint per the TabFM README:
            #   from tabfm import TabFMClassifier
            # In-context ensemble is constructed via ``ensemble_size=`` or the
            # ``TabFMClassifier.ensemble(...)`` classmethod depending on wheel.
            from tabfm import TabFMClassifier                       # type: ignore
            try:
                from tabfm import tabfm_v1_0_0_pytorch as _tabfm    # type: ignore
                model = _tabfm.load(model_id=TABFM_MODEL_ID, device=self._device)
            except Exception:                                       # noqa: BLE001
                # Older wheels expose a HF-only loader.
                from tabfm.pytorch import TabFM_HF                  # type: ignore
                model = TabFM_HF.from_pretrained(
                    TABFM_MODEL_ID, subfolder="classification"
                ).to(self._device)

            if hasattr(TabFMClassifier, "ensemble"):
                self._clf = TabFMClassifier.ensemble(model=model, n=self.ensemble_size)
            else:
                self._clf = TabFMClassifier(
                    model=model, ensemble_size=self.ensemble_size, device=self._device
                )
            self._backend = "tabfm-pytorch"
            log.info("TabFM loaded — backend=%s ensemble=%d device=%s",
                     self._backend, self.ensemble_size, self._device)
        except ModuleNotFoundError as e:
            log.warning(
                "TabFM not installed (`pip install '.[tabfm]'` to enable). "
                "Falling back to mock engine. err=%s", e,
            )
            self._backend = "mock"
        except Exception as e:                                       # noqa: BLE001
            log.exception("TabFM load failed, falling back to mock: %s", e)
            self._backend = "mock"

    # ------------------------------------------------------------------
    # Prediction
    # ------------------------------------------------------------------
    def predict(
        self,
        history: pd.DataFrame,
        y_train: np.ndarray,
        live: pd.DataFrame,
        class_labels: List[int],
    ) -> PredictionResult:
        t0 = time.perf_counter()
        if self._backend == "mock" or self._clf is None:
            probs, div = self._mock_predict(history, y_train, live, class_labels)
        else:
            probs, div = self._real_predict(history, y_train, live, class_labels)
        elapsed = (time.perf_counter() - t0) * 1_000
        return PredictionResult(
            probs=probs,
            ensemble_divergence=div,
            latency_ms=elapsed,
            backend=self._backend,
        )

    # ------------------------------------------------------------------
    def _real_predict(
        self,
        history: pd.DataFrame,
        y_train: np.ndarray,
        live: pd.DataFrame,
        class_labels: List[int],
    ) -> Tuple[np.ndarray, float]:
        assert self._clf is not None
        self._clf.fit(history, y_train)
        proba = self._clf.predict_proba(live)[0]

        # Per-member proba (for divergence). Different wheel versions expose
        # this differently — probe common attribute names.
        div = 0.0
        member_probs: Optional[np.ndarray] = None
        for attr in ("ensemble_member_proba_", "member_proba_", "predict_proba_members"):
            if hasattr(self._clf, attr):
                try:
                    val = getattr(self._clf, attr)
                    member_probs = val(live) if callable(val) else val
                    break
                except Exception:                                   # noqa: BLE001
                    continue
        if member_probs is not None and len(member_probs) > 1:
            m = np.asarray(member_probs).reshape(len(member_probs), -1)
            n = m.shape[0]
            acc, count = 0.0, 0
            for i in range(n):
                for j in range(i + 1, n):
                    acc += 0.5 * np.abs(m[i] - m[j]).sum()
                    count += 1
            div = float(acc / max(1, count))
        else:
            p = np.clip(proba, 1e-9, 1.0)
            div = float(-(p * np.log(p)).sum() / np.log(len(p)))

        classes = getattr(self._clf, "classes_", np.array(class_labels))
        ordered = np.zeros(len(class_labels), dtype=np.float64)
        for i, c in enumerate(class_labels):
            idx = int(np.where(classes == c)[0][0]) if c in classes else -1
            ordered[i] = float(proba[idx]) if idx >= 0 else 0.0

        s = ordered.sum()
        if s > 0:
            ordered = ordered / s
        return ordered, div

    # ------------------------------------------------------------------
    def _mock_predict(
        self,
        history: pd.DataFrame,
        y_train: np.ndarray,
        live: pd.DataFrame,
        class_labels: List[int],
    ) -> Tuple[np.ndarray, float]:
        counts = np.array([(y_train == c).sum() for c in class_labels], dtype=np.float64)
        base = (counts + 1.0) / (counts.sum() + len(class_labels))

        shift = 0.0
        if "shots_on_target" in live.columns:
            shift = float(live["shots_on_target"].iloc[0]) * 0.02
        n = len(class_labels)
        idx = np.arange(n) - (n - 1) / 2.0
        adjust = 1.0 + shift * idx / max(1.0, abs(idx).max())
        p = base * adjust
        p = np.clip(p, 1e-6, None)
        p = p / p.sum()

        seed = int(pd.util.hash_pandas_object(live, index=False).sum()) & 0xFFFFFFFF
        rng = np.random.default_rng(seed)
        div = float(rng.uniform(0.02, 0.15))
        return p, div

    # ------------------------------------------------------------------
    @property
    def backend(self) -> str:
        return self._backend

    @property
    def device(self) -> str:
        return self._device


# ----------------------------------------------------------------------
# Dynamic LMSR liquidity parameter from ensemble divergence.
# ----------------------------------------------------------------------
def dynamic_b(base_b: int, ensemble_divergence: float, floor_ratio: float = 0.2) -> int:
    k = 3.0
    factor = max(floor_ratio, 1.0 - k * float(ensemble_divergence))
    return max(1, int(base_b * factor))


def probs_to_q6(p: np.ndarray) -> List[int]:
    raw = p * Q_SCALE
    floor = np.floor(raw).astype(np.int64)
    remainder = Q_SCALE - int(floor.sum())
    if remainder > 0:
        frac = raw - floor
        top = np.argsort(-frac)[:remainder]
        floor[top] += 1
    return [int(x) for x in floor]
