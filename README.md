# TabulaMarkets

AI-driven dynamic-LMSR prop-bet AMM on Solana. Prices are steered by an
ensemble of Google Research's [TabFM](https://github.com/google-research/tabfm)
tabular foundation model; settlement is cryptographically proven via
[TxLINE](https://txline.txodds.com/) Merkle roots.

**Status:** hackathon MVP + production-hardening pass. Not audited. Devnet only.

## Architecture (four layers)

1. **On-chain (Rust / Anchor 0.30)** — `programs/tabula-markets`
   - Dynamic LMSR AMM (Q6 fixed-point), per-market exposure cap, admin
     kill-switch, oracle-authority separation, arithmetic-overflow-safe.
   - Two settlement backends via Cargo feature flags:
     - `mock-txline` (default) — CPI into the bundled `programs/txline-mock`.
     - `real-txline` — verifies keeper-signed `TxLineAttestation` accounts
       backed by TxODDS `txoracle.validateStat` on devnet/mainnet.
2. **Oracle (Python / FastAPI)** — `oracle/`
   - Real TabFM (PyTorch backend, CPU/CUDA/MPS auto-detect) or mock.
   - Structured JSON logs, Prometheus /metrics, /healthz + /readyz.
3. **Keeper (TypeScript / Node)** — `keeper/`
   - Real TxLINE REST + SSE client (`txlineClient.ts`) with JWT + API token flow.
   - Local `LocalTxLineEmulator` for offline dev.
   - Prometheus /metrics + /healthz + /readyz.
4. **Frontend (Next.js)** — `app/`
   - MarketPanel, OracleStatus, ReceiptPanel. Devnet wallet-adapter ready.

```
       TxLINE feed  ─▶  keeper  ─▶  update_prediction  ─▶  tabula-markets
                                         │
                                         ▼
       TabFM oracle  ◀─  callOracle()    place_bet / settle / claim  ─▶  Solana
```

## Quick Start

### Local demo (mock everything)

```bash
git clone https://github.com/daemon-blockint-tech/prop-it
cd prop-it

# oracle (mock backend, no GPU needed)
./scripts/install-oracle.sh --mock
source oracle/.venv/bin/activate
TABULA_ORACLE_MOCK=1 tabula-oracle &

# keeper (local emulator)
cd keeper && npm install && npm run simulate
```

### Reproducible Docker

```bash
cp keeper/.env.example keeper/.env       # fill in the real values
docker compose up --build
```

Oracle → `http://localhost:8787`, keeper metrics → `http://localhost:9464/metrics`.

## Devnet Deploy

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full recipe. TL;DR:

```bash
anchor build                                # mock backend, for tests
# or:
cd programs/tabula-markets && \
  anchor build -- --no-default-features --features real-txline

anchor deploy --provider.cluster devnet
```

The real TxLINE devnet program is
`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` — already wired in
`keeper/src/config.ts`.

## Production Checklist

- ✅ `checked_add`/`checked_mul`/`checked_div` on every path
- ✅ Oracle-authority separation (`pool.oracle_authority`, `pool.settlement_oracle`)
- ✅ Per-market USDC exposure cap
- ✅ Pool-level pause / kill switch
- ✅ Attestation freshness check (`MAX_RECEIPT_AGE_SEC = 15 min`)
- ✅ Monotone-bins validation on `create_market`
- ✅ Prometheus metrics + healthz probes on oracle + keeper
- ✅ JSON structured logging with secret redaction
- ✅ Docker + docker-compose for reproducible deploy
- ✅ GitHub Actions: gitleaks, ruff, pytest, tsc, anchor build (mock + real)
- ✅ Dependabot for npm / pip / cargo / actions
- ✅ Pre-commit hooks: gitleaks, private-key detector, ruff
- ✅ Emergency-cancel instruction (`cancel_market` + `claim_refund`) — governance voids an unsettleable market; bettors reclaim full stake
- ⚠️ External audit — not started, required before any mainnet deploy
- ⚠️ TabFM ensemble load-testing at ensemble_size=32 — pending

See [`SECURITY.md`](SECURITY.md) for the full threat model and
[`docs/RUNBOOK.md`](docs/RUNBOOK.md) for the on-call playbook.

## Repository Layout

```
programs/tabula-markets/  # On-chain LMSR AMM (Anchor)
programs/txline-mock/     # Bundled mock oracle for local dev
oracle/                   # FastAPI + TabFM service
keeper/                   # TxLINE ⇆ oracle ⇆ Solana bridge (Node)
app/                      # Next.js frontend
docs/                     # ARCHITECTURE, PRD, ADR, DEPLOYMENT, RUNBOOK
scripts/                  # dev-up.sh, install-oracle.sh
tests/                    # Anchor integration tests
.github/workflows/ci.yml  # CI pipeline
```

## License

Apache 2.0 — see `LICENSE`.
