"""tabfm_engine
================

Thin wrapper around the Google Research TabFM classifier ensemble.

The real dependency is installed via:

    pip install "tabfm[pytorch] @ git+https://github.com/google-research/tabfm.git"

If the package is not available (CI, unit tests, laptop without GPU) this
module falls back to a deterministic mock engine that mirrors the surface
of :class:`tabfm.TabFMClassifier` closely enough for the rest of the
oracle service to be tested end-to-end.
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


@dataclass
class PredictionResult:
    probs: np.ndarray            # shape (n_classes,), float in [0,1], sums to ~1
    ensemble_divergence: float   # mean pairwise TV distance across ensemble members
    latency_ms: float
    backend: str                 # "tabfm-pytorch" | "mock"


class TabFMEngine:
    """Loads TabFM once and serves in-context predictions."""

    def __init__(self, ensemble_size: int = 32, prefer_backend: str = "pytorch"):
        self.ensemble_size = ensemble_size
        self.prefer_backend = prefer_backend
        self._clf = None
        self._backend = "mock"
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
            # Prefer PyTorch backend (see architecture doc ADR 1).
            from tabfm import TabFMClassifier                              # type: ignore
            from tabfm import tabfm_v1_0_0_pytorch as tabfm_v1_0_0         # type: ignore

            log.info("Loading TabFM v1.0.0 (PyTorch backend) …")
            model = tabfm_v1_0_0.load()
            # NOTE: TabFMClassifier.ensemble(...) API surface per the doc.
            # Some builds expose it as a classmethod, others as a kwarg —
            # we handle both.
            if hasattr(TabFMClassifier, "ensemble"):
                self._clf = TabFMClassifier.ensemble(model=model, n=self.ensemble_size)
            else:
                self._clf = TabFMClassifier(model=model, ensemble_size=self.ensemble_size)
            self._backend = "tabfm-pytorch"
            log.info("TabFM loaded — backend=%s ensemble=%d", self._backend, self.ensemble_size)
        except Exception as e:                                              # noqa: BLE001
            log.warning("Falling back to mock TabFM: %s", e)
            self._backend = "mock"
            self._clf = None

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
        """Zero-shot in-context prediction.

        :param history:      training-context rows (features only)
        :param y_train:      class labels for `history`, ints in class_labels
        :param live:         one-row DataFrame with the current match state
        :param class_labels: canonical ordering of classes for the returned vector
        """
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

        # `predict_proba` returns shape (1, n_classes) — normalized by TabFM.
        proba = self._clf.predict_proba(live)[0]

        # Ensemble divergence: if the wrapper exposes per-member probabilities
        # use them; otherwise approximate with prediction entropy.
        div = 0.0
        member_probs: Optional[np.ndarray] = None
        for attr in ("ensemble_member_proba_", "member_proba_", "predict_proba_members"):
            if hasattr(self._clf, attr):
                try:
                    val = getattr(self._clf, attr)
                    member_probs = val(live) if callable(val) else val
                    break
                except Exception:                                          # noqa: BLE001
                    continue
        if member_probs is not None and len(member_probs) > 1:
            # Mean pairwise total-variation distance across members.
            m = np.asarray(member_probs).reshape(len(member_probs), -1)
            n = m.shape[0]
            acc, count = 0.0, 0
            for i in range(n):
                for j in range(i + 1, n):
                    acc += 0.5 * np.abs(m[i] - m[j]).sum()
                    count += 1
            div = float(acc / max(1, count))
        else:
            # Fallback: normalized Shannon entropy on the mean proba.
            p = np.clip(proba, 1e-9, 1.0)
            div = float(-(p * np.log(p)).sum() / np.log(len(p)))

        # Align to canonical class ordering. `self._clf.classes_` may reorder.
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
        """Deterministic mock: base rates from y_train nudged by `live` heuristics."""
        counts = np.array([(y_train == c).sum() for c in class_labels], dtype=np.float64)
        base = (counts + 1.0) / (counts.sum() + len(class_labels))

        # Simple domain nudge: high shots_on_target shifts mass right.
        shift = 0.0
        if "shots_on_target" in live.columns:
            shift = float(live["shots_on_target"].iloc[0]) * 0.02
        n = len(class_labels)
        idx = np.arange(n) - (n - 1) / 2.0
        adjust = 1.0 + shift * idx / max(1.0, abs(idx).max())
        p = base * adjust
        p = np.clip(p, 1e-6, None)
        p = p / p.sum()

        # Ensemble divergence: pseudo-random but stable per input.
        seed = int(pd.util.hash_pandas_object(live, index=False).sum()) & 0xFFFFFFFF
        rng = np.random.default_rng(seed)
        div = float(rng.uniform(0.02, 0.15))
        return p, div

    # ------------------------------------------------------------------
    @property
    def backend(self) -> str:
        return self._backend


# ----------------------------------------------------------------------
# Dynamic LMSR liquidity parameter from ensemble divergence.
# ----------------------------------------------------------------------
def dynamic_b(base_b: int, ensemble_divergence: float, floor_ratio: float = 0.2) -> int:
    """Shrink `b` as ensemble disagreement grows.

    b_eff = base_b * max(floor_ratio, 1 - k * divergence)

    A larger divergence means TabFM is uncertain (chaotic live state) so we
    tighten the curve to prevent arbitrageurs from picking off the pool.
    """
    k = 3.0
    factor = max(floor_ratio, 1.0 - k * float(ensemble_divergence))
    return max(1, int(base_b * factor))


def probs_to_q6(p: np.ndarray) -> List[int]:
    """Convert a normalized float probability vector to Q_SCALE fixed-point.

    Uses largest-remainder rounding so the sum is exactly Q_SCALE.
    """
    raw = p * Q_SCALE
    floor = np.floor(raw).astype(np.int64)
    remainder = Q_SCALE - int(floor.sum())
    if remainder > 0:
        frac = raw - floor
        top = np.argsort(-frac)[:remainder]
        floor[top] += 1
    return [int(x) for x in floor]
