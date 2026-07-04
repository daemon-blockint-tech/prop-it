"""Contract tests for the /predict endpoint (mock backend)."""
import os
os.environ["TABULA_ORACLE_MOCK"] = "1"

from fastapi.testclient import TestClient

from tabula_oracle.server import app

client = TestClient(app)


def _valid_body():
    return {
        "match_id":  "test-match",
        "stat_type": "corners_h2",
        "bin_edges": [0, 3, 6, 9, 999],
        "history": [
            {"minute": 45, "score_diff": 0, "shots_on_target": 4,
             "possession": 55.0, "corners_so_far": 3, "outcome_bin": 1},
            {"minute": 45, "score_diff": 1, "shots_on_target": 6,
             "possession": 61.0, "corners_so_far": 4, "outcome_bin": 2},
        ],
        "live": {"minute": 47, "score_diff": 0, "shots_on_target": 5,
                 "possession": 58.0, "corners_so_far": 3},
        "base_b": 5_000_000,
    }


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # Minimal public health — no backend details.
    assert "backend" not in r.json()


def test_readyz():
    r = client.get("/readyz")
    assert r.status_code == 200
    assert r.json()["ready"] is True


def test_predict_rejects_extreme_score_diff():
    b = _valid_body()
    b["live"]["score_diff"] = 99
    r = client.post("/predict", json=b)
    assert r.status_code == 422


def test_metrics_prometheus_format():
    # Trigger at least one prediction to populate counters.
    client.post("/predict", json=_valid_body())
    r = client.get("/metrics")
    assert r.status_code == 200
    assert b"tabula_oracle_predict_total" in r.content


def test_predict_happy_path():
    r = client.post("/predict", json=_valid_body())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_classes"] == 4
    assert len(body["probs_q6"]) == 4
    assert sum(body["probs_q6"]) == 1_000_000
    assert body["liquidity_b"] > 0
    assert body["model_backend"] == "mock"


def test_predict_rejects_non_monotonic_bins():
    b = _valid_body()
    b["bin_edges"] = [0, 5, 3, 9, 999]
    r = client.post("/predict", json=b)
    assert r.status_code == 400
    assert "monotonic" in r.json()["detail"].lower()


def test_predict_rejects_too_many_classes():
    b = _valid_body()
    b["bin_edges"] = list(range(12))  # 11 classes
    r = client.post("/predict", json=b)
    assert r.status_code == 400
    assert "10" in r.json()["detail"]


def test_predict_rejects_empty_history():
    b = _valid_body()
    b["history"] = []
    r = client.post("/predict", json=b)
    assert r.status_code == 400


def test_predict_rejects_out_of_range_outcome_bin():
    b = _valid_body()
    b["history"][0]["outcome_bin"] = 9  # >= n_classes=4
    r = client.post("/predict", json=b)
    assert r.status_code == 400
