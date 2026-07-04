# Architecture

This document is the technical companion to the PRD. It maps the four
concerns of a live prediction market — **pricing, trading, resolution,
and audit** — to concrete modules in this repo.

## 1. Pricing — TabFM ensemble + dynamic LMSR

**Where:** `oracle/tabula_oracle/tabfm_engine.py`, `programs/tabula-markets/src/lib.rs`.

Every ~3 s (configurable via `UPDATE_INTERVAL_MS`) the keeper posts a
`PredictRequest` to the oracle carrying:

- the outcome bin edges (≤ 10 bins, enforced by TabFM's max-class limit),
- 100–500 rows of historical training context,
- the current live state row.

The oracle calls `TabFMClassifier(...).predict_proba(live)` in a single
forward pass (in-context learning — no gradient step). It also computes
`ensemble_divergence`: the mean pairwise total-variation distance across
the 32 ensemble members. The dynamic LMSR liquidity parameter is:

```
b_eff = base_b * max(floor_ratio, 1 - k * divergence)     # k = 3.0, floor = 0.2
```

When TabFM disagrees with itself, `b` shrinks, sharpening the slippage
curve. This is our defence against courtsiding and VAR-window MEV.

## 2. Trading — single-sided USDC LMSR pool

**Where:** `programs/tabula-markets/src/lib.rs::place_bet`.

- LPs deposit USDC into a PDA-owned vault (`seeds = ["vault", pool]`).
- Each market has an outcome vector `probs[]` (Q6 fixed-point) and a
  liquidity parameter `b` (also Q6). Both are updatable only by the
  designated oracle account.
- `place_bet` prices at `p_i * (1 + FEE_BPS/10_000)` — 2 % spread routed
  to the pool treasury. Shares are minted at that marginal price and
  the position PDA (`seeds = ["position", market, bettor]`) records
  `{outcome_idx, shares, usdc_in}`.

## 3. Resolution — CPI to TxLINE

**Where:** `programs/tabula-markets/src/lib.rs::settle_via_txline`,
`programs/txline-mock/src/lib.rs::validate_stat`.

Sequence:

1. Keeper sees `full_time` on the feed and calls
   `txline_mock::publish_stat_root(match_id, merkle_root)` — the TxLINE
   authority anchors the Merkle root of the official stats.
2. Keeper (or anyone) calls `tabula_markets::settle_via_txline(stat_type,
   stat_value, proof)`.
3. Tabula CPIs into `txline_mock::validate_stat`, which walks the
   sort-pair keccak proof against the anchored root. On success it
   writes a `StatReceipt` PDA.
4. Tabula reloads the receipt, maps `stat_value` into the winning bin
   via `bin_edges[]`, sets `market.status = Resolved`, emits
   `MarketResolved`.

No optimistic delay. No multi-sig. If TxLINE lies about a match, its own
Merkle root proves the lie.

## 4. Audit — Verifiable Resolution UI

**Where:** `app/src/components/ReceiptPanel.tsx`, `keeper/src/merkle.ts`.

Bettors can pull the `StatReceipt` PDA plus the Merkle proof siblings
that the keeper submitted. The frontend renders both, and the client
can independently recompute keccak(leaf) → sort-pair-hash up the tree,
confirming without trust that the settled `stat_value` is exactly the
one anchored by TxLINE.

## Threat model (MVP scope)

| Vector                                         | Mitigation                                                  |
|------------------------------------------------|-------------------------------------------------------------|
| Oracle sends miscalibrated probs               | LMSR `b` scaled by ensemble divergence; spread absorbs error |
| Feed lag (courtsiding)                         | On divergence spikes, `b` shrinks → slippage tightens        |
| Solana MEV / sandwich on `update_prediction`   | *Out of scope for MVP*; noted in `docs/PRD.md` § Non-functional |
| TxLINE oracle failure                          | *Out of scope for MVP*; production would add circuit breaker |
| LP inventory depletion in a single market      | Per-market `max_exposure` cap (planned Phase 2)              |

## Key knobs

| Setting              | Default  | Meaning                                          |
|----------------------|----------|--------------------------------------------------|
| `Q_SCALE`            | 1e6      | Fixed-point scale for probs and b                |
| `MAX_OUTCOMES`       | 10       | TabFM classifier hard cap                        |
| `FEE_BPS`            | 200      | 2 % spread on each `place_bet`                   |
| `SETTLE_FEE_BPS`     | 50       | 0.5 % off *net winnings* at claim time           |
| `UPDATE_INTERVAL_MS` | 3000     | Keeper cadence for pushing new predictions       |
| `DIVERGENCE_THRESHOLD` | 0.02   | Min prob drift before submitting on-chain update |
| Ensemble size        | 32       | TabFM members (per ADR 1)                        |
