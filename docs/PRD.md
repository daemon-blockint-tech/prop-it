# TabulaMarkets — Product Requirements (MVP scope)

This is the trimmed, executable subset of the full architecture spec
under `docs/spec/`. It is what the MVP in this repo actually delivers.

## Goals

1. Ship an autonomous prop-bet AMM on Solana devnet where prices are set
   by an AI (TabFM) rather than by a bookmaker.
2. Prove trustless settlement via CPI into a TxLINE-shaped program.
3. Give judges a 5-minute demo path: `simulate` → watch odds evolve →
   `full_time` → verify Merkle receipt on-screen.

## Non-goals (MVP)

- Mainnet deployment or real USDC.
- Cross-sport generalisation. We ship one match (WC R16 ARG vs FRA)
  with `corners_h2` as the prop stat.
- Governance token / DAO. LP fees accumulate to the pool authority.

## Users

- **Bettor** — connects a Solana wallet, picks an outcome bin, sees
  decimal odds derived from TabFM + spread, places a bet, and later
  claims USDC directly from the vault.
- **Liquidity provider** — deposits USDC into the pool. Earns spread
  and settlement fees; loses when TabFM misprices.
- **Keeper bot** — the process in `keeper/`. Runs anywhere; earns a
  premium fee (out of scope for MVP; hard-coded to 0).

## Functional requirements

| ID  | Requirement                                                                            | Delivered in                          |
|-----|----------------------------------------------------------------------------------------|---------------------------------------|
| F1  | Create a market with 2–10 categorical outcome bins + initial TabFM probs               | `create_market`                       |
| F2  | Update on-chain probability vector and `b` from an authorised oracle account           | `update_prediction`                   |
| F3  | Place a bet at marginal price = `p_i * (1 + FEE_BPS)`                                  | `place_bet`                           |
| F4  | Settle a market by CPI-verifying a Merkle proof of the definitive stat via TxLINE     | `settle_via_txline`                   |
| F5  | Claim USDC winnings pro-rata to shares held in the winning outcome                     | `claim_winnings`                      |
| F6  | Public JSON API for TabFM probability + dynamic `b`                                    | `oracle/tabula_oracle/server.py`      |
| F7  | Local emulator streaming realistic TxLINE ticks over 90 wall-clock seconds             | `keeper/src/txlineFeed.ts`            |
| F8  | UI showing decimal odds, live minute scrubber, and Merkle proof receipt                | `app/src/app/page.tsx`                |

## Non-functional requirements

- **Latency**: oracle p50 < 800 ms (real TabFM ensemble), p50 < 50 ms (mock).
- **Determinism**: same `match_id + seed` in mock mode → identical demo.
- **Safety**: all on-chain math uses `checked_*`; no `unsafe`.
- **Compliance**: devnet only, no real funds, README calls it out.

## Out-of-scope backlog

- Per-market LP exposure caps and circuit breakers.
- Commit-reveal for oracle updates against sandwich MEV.
- Multi-sport keeper (basketball, tennis) using the same TabFM engine.
- Ensemble-member-level Prometheus telemetry.
- Backtesting harness against `@srivtx/sports-workbench`.
