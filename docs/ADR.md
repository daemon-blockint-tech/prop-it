# Architecture Decision Records (short form)

## ADR 1 — TabFM ensemble instead of XGBoost / online learning

**Status**: Accepted.
**Context**: Long-tail prop markets need to open new outcome vectors
in seconds. XGBoost pipelines take minutes-to-hours per market.
**Decision**: Use `google/tabfm-1.0.0-pytorch` v1.0.0 as a zero-shot
in-context classifier with a 32-member ensemble. Historical rows are
prepended to the live row as a single "prompt".
**Consequences**:
- No retraining loop → new markets open in one HTTP call.
- Hard limit of 10 outcome classes → we bin continuous stats.
- Ensemble divergence gives us a free uncertainty signal used to
  modulate LMSR liquidity `b`.

## ADR 2 — CPI into a TxLINE-shaped program, not an optimistic oracle

**Status**: Accepted.
**Context**: Optimistic oracles (UMA, Kleros) impose 24–72 h dispute
windows and hurt capital velocity. Multi-sig oracles are centralised.
**Decision**: Delegate factual truth to TxLINE's own Merkle-anchored
attestations and CPI into their `validate_stat` instruction from
`tabula_markets::settle_via_txline`. We ship `txline-mock` locally so
the demo runs without external dependencies.
**Consequences**:
- Instant settlement — no dispute window.
- TxLINE is a trusted data source; its own reputation stake secures
  the market. Acceptable for a data-vendor track.

## ADR 3 — Dynamic LMSR vs constant-product

**Status**: Accepted.
**Context**: `x*y=k` is undefined for outcomes with sharply shifting
probabilities and provides no natural coupling to an off-chain
probability estimator.
**Decision**: LMSR with `b` set by the oracle each update.
`b` = `base_b * max(0.2, 1 - 3 * ensemble_divergence)`.
**Consequences**:
- Well-defined marginal price = `p_i * (1 + spread)`.
- When TabFM's ensemble disagrees (chaotic live state), the curve
  automatically tightens against courtsiders.

## ADR 4 — Q6 fixed-point on-chain, floats off-chain

**Status**: Accepted.
**Context**: Solana programs can't use floats. The oracle produces
`float` probs, but the program stores + compares integers.
**Decision**: Scale everything to `Q_SCALE = 1_000_000` before writing
on-chain. Use largest-remainder rounding in
`probs_to_q6(...)` so the vector always sums to exactly `Q_SCALE`.
**Consequences**:
- Deterministic on-chain math.
- 1 ppm precision on probabilities, more than enough for prop markets.

## ADR 5 — Single Solana program pair, not a bundled dapp

**Status**: Accepted.
**Context**: Judges must clone and run the repo in < 15 minutes.
**Decision**: Two Anchor programs (`tabula-markets`, `txline-mock`)
plus one FastAPI service, one keeper, and one Next.js app. No message
queue, no database, no Docker Compose required.
**Consequences**:
- `npm run simulate` is enough to see the end-to-end story.
- Production deploy needs a real TxLINE program ID and a proper
  keeper Prometheus stack — noted in Phase 3 of the roadmap.
