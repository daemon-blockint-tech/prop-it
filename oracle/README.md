# Tabula Oracle

TabFM-driven probability oracle for TabulaMarkets. Exposes a FastAPI HTTP
service that:

1. Ingests a match-state feature vector (live TxLINE + historical context)
2. Runs a TabFM classifier ensemble in-context on the tabular payload
3. Returns a probability vector over the market's outcome bins
4. Derives a dynamic LMSR liquidity parameter `b` from ensemble divergence

## Install

```bash
cd oracle
python -m venv .venv && source .venv/bin/activate
pip install -e .
# TabFM (real Google Research package):
pip install "tabfm[pytorch] @ git+https://github.com/google-research/tabfm.git"
```

If GPU is available, install a CUDA-matched `torch` wheel first.

## Run

```bash
uvicorn tabula_oracle.server:app --host 0.0.0.0 --port 8787
```

## Endpoints

| Method | Path         | Purpose                                                 |
|--------|--------------|---------------------------------------------------------|
| POST   | `/predict`   | Zero-shot probability + dynamic `b` for one live state  |
| GET    | `/health`    | Liveness (also confirms model is loaded)                |
| GET    | `/model`     | Introspection: backend, ensemble size, class labels     |

### `/predict` request body

```json
{
  "match_id": "world-cup-2026-r16-arg-vs-fra",
  "stat_type": "corners_h2",
  "bin_edges": [0, 3, 6, 9, 999],
  "history": [
    {"minute": 45, "score_diff": 0, "shots_on_target": 4, "possession": 55, "corners_so_far": 3, "corners_h2_final": 5},
    {"minute": 45, "score_diff": 1, "shots_on_target": 6, "possession": 61, "corners_so_far": 4, "corners_h2_final": 7},
    "..."
  ],
  "live": {"minute": 47, "score_diff": 0, "shots_on_target": 5, "possession": 58, "corners_so_far": 3}
}
```

### `/predict` response

```json
{
  "match_id": "world-cup-2026-r16-arg-vs-fra",
  "probs_q6": [120000, 480000, 300000, 100000],
  "liquidity_b": 5000000,
  "ensemble_divergence": 0.041,
  "latency_ms": 623,
  "model_id": "google/tabfm-1.0.0-pytorch"
}
```

`probs_q6` are in Q_SCALE=1_000_000 fixed-point units, ready to feed directly
into the on-chain `update_prediction` instruction.
