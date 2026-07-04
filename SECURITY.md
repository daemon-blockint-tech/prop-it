# Security Policy

TabulaMarkets is a hackathon-scale prediction-market prototype. It is
**not** production-audited software. This document captures the threat
model, the mitigations already in-tree, and the residual work required
before any real user funds should ever touch it.

## Reporting a Vulnerability

Please email **security@daemon-protocol.dev** with:

- A clear description of the issue and impact.
- A minimal reproduction (transaction signature, code snippet, curl command).
- Your PGP key if you want an encrypted reply.

We aim to acknowledge within 48h. Do **not** open public GitHub issues
for security-sensitive reports.

## Threat Model

### In-scope

| Actor              | Capability                                              | Mitigation |
|--------------------|---------------------------------------------------------|------------|
| Bettor             | Places bets, claims winnings                            | LMSR bounds + share bookkeeping + `checked_*` arithmetic |
| Rogue oracle       | Attempts to push malicious probabilities                | `pool.oracle_authority` gate + signed `update_prediction` |
| Rogue keeper       | Attempts to fake TxLINE settlement                      | `real-txline` feature verifies `TxLineAttestation` was signed by `pool.settlement_oracle` AND is < `MAX_RECEIPT_AGE_SEC` old |
| MEV / sandwich bot | Front-runs a large price update                         | `FEE_BPS=200` slippage floor + Solana leader scheduling |
| Sybil LP           | Drains vault via one runaway market                     | `MAX_MARKET_EXPOSURE` per-market cap |
| Broken client      | Sends malformed proofs / probs                          | Full input validation on-chain and in FastAPI |

### Out-of-scope (residual risk)

- **Oracle liveness / censorship.** If the settlement oracle key is lost, markets can be stuck in `Trading`. A future release should add a time-based emergency-cancel instruction that refunds pro-rata.
- **TabFM manipulation.** A compromised oracle service could bias `probs`. Mitigation is (a) rotate keys via `rotate_oracle`, (b) run a multi-signer oracle quorum (future work).
- **Solana runtime bugs.** Standard supply-chain risk with `anchor-lang 0.30.x` and `@solana/web3.js 1.95.x`. Dependabot is enabled for weekly bumps.
- **On-chain data availability.** TxLINE anchors Merkle roots per epoch-day; if TxODDS is down when a market resolves, settlement waits until the API recovers. There is no fallback data source in the MVP.

## Cryptographic Assumptions

- Solana keypair confidentiality (`ed25519`).
- SHA-256 / Keccak-256 pre-image resistance for Merkle inclusion proofs.
- TxLINE's off-chain signing chain (JWT + wallet signature) is trusted as
  the authoritative source-of-truth for stat values. TabulaMarkets does
  **not** re-verify the Merkle proof itself on the real-txline path — it
  relies on the keeper having successfully executed
  `Txoracle.validateStat(...).view()` against the deployed TxODDS program
  before posting a `TxLineAttestation`.

## Key Handling

- **Never** commit `.env`, `id.json`, or any `*.key`/`*.pem` file. The
  root `.gitignore` blocks the common patterns; `gitleaks` in CI catches
  the rest.
- Rotate the oracle and settlement authorities via
  `rotate_oracle(new_prediction_oracle, new_settlement_oracle)` — signed
  by the pool's `authority` key. Keep the pool authority in an air-gapped
  multisig for anything approaching mainnet.
- The keeper is a **hot** service: assume its keypair can leak. Bound
  blast radius by giving it only `settlement_oracle` and prediction rights
  — never the pool `authority`.

## Auditing Checklist Before Any Mainnet Deploy

- [ ] External Solana audit of `programs/tabula-markets` (Trail of Bits, Neodyme, OtterSec…).
- [ ] Formal specification of the Q_SCALE fixed-point math (numerical stability + rounding under adversarial inputs).
- [ ] Fuzz `place_bet` / `settle_via_txline` with `honggfuzz-rs` or `cargo-fuzz`.
- [ ] Test replay-attack scenarios against `TxLineAttestation` freshness.
- [ ] Chaos-test the keeper: kill / restart under load, verify no double-submission.
- [ ] Load-test the oracle: TabFM latency under batch of 32 concurrent requests.
- [ ] Confirm no `panic!`/`unwrap` remains in program code (grep already clean; keep it that way in CI via clippy).
- [ ] Legal review for jurisdiction of intended users.
