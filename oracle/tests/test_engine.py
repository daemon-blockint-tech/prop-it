"""Smoke tests for the mock engine (real TabFM tested via CI or manually)."""

import os
os.environ["TABULA_ORACLE_MOCK"] = "1"

import numpy as np
import pandas as pd

from tabula_oracle.tabfm_engine import TabFMEngine, dynamic_b, probs_to_q6, Q_SCALE


def test_mock_predict_shapes():
    eng = TabFMEngine(ensemble_size=8)
    assert eng.backend == "mock"

    hist = pd.DataFrame({
        "minute":          [45, 45, 45, 45, 45],
        "score_diff":      [0, 1, -1, 0, 2],
        "shots_on_target": [4, 6, 3, 5, 8],
        "possession":      [55, 61, 47, 58, 63],
        "corners_so_far":  [3, 4, 2, 3, 5],
    })
    y = np.array([1, 2, 0, 1, 3])
    live = pd.DataFrame({
        "minute": [47], "score_diff": [0], "shots_on_target": [5],
        "possession": [58], "corners_so_far": [3],
    })
    r = eng.predict(hist, y, live, class_labels=[0, 1, 2, 3])
    assert r.probs.shape == (4,)
    assert abs(r.probs.sum() - 1.0) < 1e-6
    assert 0.0 <= r.ensemble_divergence <= 1.0


def test_probs_to_q6_sums_to_q_scale():
    p = np.array([0.1, 0.3, 0.35, 0.25])
    q = probs_to_q6(p)
    assert sum(q) == Q_SCALE
    assert len(q) == 4


def test_dynamic_b_shrinks_with_divergence():
    base = 10_000_000
    b_calm = dynamic_b(base, ensemble_divergence=0.01)
    b_chaotic = dynamic_b(base, ensemble_divergence=0.25)
    assert b_calm > b_chaotic
    assert b_chaotic >= int(base * 0.2)  # floor
