# TabulaMarkets · `prop-it`

**AI-driven dynamic-LMSR AMM for sports prop-bets with cryptographic settlement on Solana.**
Submitted to the [TxODDS × Solana Prediction Markets & Settlement track](https://superteam.fun/earn/listing/prediction-markets-and-settlement/).

TabulaMarkets removes both human market makers *and* optimistic-oracle
dispute windows from long-tail sports prop markets. A Google Research
[TabFM](https://github.com/google-research/tabfm) ensemble runs zero-shot
in-context inference on historical + live TxLINE tabular data to price
outcome bins in real time. An Anchor program on Solana consumes those
predictions through a dynamic-LMSR curve and settles trustlessly via a
Cross-Program Invocation into the TxLINE `validate_stat` program.

> **Devnet only.** No real funds. Hackathon MVP.

---

## Repository layout

```
prop-it/
├── programs/
│   ├── tabula-markets/    ← Anchor program: LMSR pool, markets, positions, CPI settle
│   └── txline-mock/       ← Local stand-in for TxLINE on-chain validate_stat program
├── oracle/                ← Python FastAPI service wrapping TabFM (v1.0.0 PyTorch)
├── keeper/                ← TypeScript keeper bot: TxLINE feed → oracle → Solana
├── app/                   ← Next.js frontend + Verifiable Resolution UI
├── docs/                  ← Architecture, ADRs, PRD
└── scripts/               ← Local devnet bootstrap helpers
```

## Architecture in one diagram

```
┌────────────┐    ticks (8-10ms)    ┌─────────────┐   probs+b   ┌────────────────────────┐
│  TxLINE    │────────────────────▶ │  Keeper Bot │────────────▶│  tabula-markets        │
│  feed      │                      │  (TS/Node)  │             │  Anchor program        │
└────────────┘                      └──────┬──────┘             │  · LMSR state          │
      │                                    │ /predict           │  · Position PDAs       │
      │                                    ▼                    │  · Vault (USDC)        │
      │                             ┌─────────────┐             └──────────┬─────────────┘
      │                             │  Oracle     │                        │ CPI: validate_stat
      │                             │  FastAPI +  │                        ▼
      │  publish_stat_root          │  TabFM v1.0 │             ┌────────────────────────┐
      └────────────────────────────▶│  ensemble   │             │  txline-mock program   │
                                    └─────────────┘             │  · StatRoot            │
                                                                │  · StatReceipt (Merkle)│
                                                                └────────────────────────┘
```

## Quickstart (fully offline)

```bash
# 1) Oracle
cd oracle
python -m venv .venv && source .venv/bin/activate
pip install -e .
# real TabFM (recommended for the submission):
pip install "tabfm[pytorch] @ git+https://github.com/google-research/tabfm.git"
# or, quick mock for laptops without GPU:
export TABULA_ORACLE_MOCK=1
uvicorn tabula_oracle.server:app --port 8787

# 2) Keeper (in another shell)
cd keeper
cp .env.example .env
npm install
npm run simulate      # emulates a full 90' match and drives the oracle

# 3) Frontend (in another shell)
cd app
npm install
npm run dev           # http://localhost:3000
```

## Deploying to Solana devnet

```bash
solana config set --url devnet
anchor build
anchor deploy
# grab the deployed program IDs and copy them into keeper/.env and app/.env.local
```

The Anchor tests under `programs/tabula-markets/tests/` exercise the full
lifecycle: `initialize_pool → deposit_liquidity → create_market →
update_prediction → place_bet → publish_stat_root → settle_via_txline →
claim_winnings`.

## Judging cheat-sheet (Prediction Markets & Settlement track)

| Criterion                       | Where implemented                                                         |
|---------------------------------|---------------------------------------------------------------------------|
| Decentralized AMM               | [`programs/tabula-markets/src/lib.rs`](programs/tabula-markets/src/lib.rs) — LMSR with oracle-adjusted `b` |
| Custom on-chain settlement      | `settle_via_txline` instruction — CPI into TxLINE program                 |
| Verifiable data delivery        | `programs/txline-mock/src/lib.rs` — keccak Merkle proof over stats        |
| TxLINE feed integration         | [`keeper/src/txlineFeed.ts`](keeper/src/txlineFeed.ts) + WS shim         |
| AI-native pricing               | [`oracle/tabula_oracle/tabfm_engine.py`](oracle/tabula_oracle/tabfm_engine.py) — real TabFM v1.0.0 ensemble |
| UX / Verifiable Resolution UI   | [`app/src/components/ReceiptPanel.tsx`](app/src/components/ReceiptPanel.tsx) |

## Legal

Devnet only. No monetary value. Apache-2.0. This is not an officially
supported Google product; TabFM is used under its own Apache-2.0 license.
