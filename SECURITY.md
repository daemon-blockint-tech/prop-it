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
| Bettor             | Places bets, claims winnings                            | `MIN_PROB` floor + share liability caps vs `MAX_MARKET_EXPOSURE` and vault balance + `checked_*` arithmetic |
| Rogue oracle       | Attempts to push malicious probabilities                | `pool.oracle_authority` gate + `MIN_PROB` on every non-zero `p_i` + market bound to pool |
| Rogue keeper       | Attempts to fake TxLINE settlement                      | Mock path: config-gated `publish_stat_root` + `settlement_oracle` signer. Real path: one-shot attestation PDA bound to `(pool, market)` + freshness — **still trusts keeper** (see residual risk) |
| Cross-pool attacker| Reprices / settles victim markets via attacker pool     | `Market.pool` field + PDA seeds `[b"market", pool, match_id]` + `market.pool == pool.key()` on all instructions |
| Unauthorized admin | Spins up pools / markets                                | `GlobalConfig` admin gate for `initialize_pool`; `create_market` restricted to pool `authority` or `oracle_authority` |
| MEV / sandwich bot | Front-runs a large price update                         | `FEE_BPS=200` slippage floor + Solana leader scheduling |
| Sybil LP           | Drains vault via one runaway market                     | Liability = outstanding shares; capped per market and vs vault |
| Broken client      | Sends malformed proofs / probs                          | Full input validation on-chain and in FastAPI / keeper |

### Out-of-scope (residual risk)

- **F-004 — Keeper trust on `real-txline`.** Settlement still relies on the
  `settlement_oracle` having honestly run `validateStat.view()` off-chain.
  There is no on-chain TxODDS CPI or ed25519 verification of TxLINE transcripts.
  A compromised keeper can post a false one-shot attestation within
  `MAX_RECEIPT_AGE_SEC` and resolve the market. Mitigate operationally
  (HSM / multisig keeper, monitoring) until a real TxODDS CPI lands.
- **F-023 / needs_info items.** Findings marked `needs_info` in `TRIAGE.json`
  were not fully actionable from static review alone; re-triage after the
  next audit pass.
- **Oracle liveness / censorship.** If the settlement oracle key is lost,
  markets can be stuck in `Trading`. A future release should add a time-based
  emergency-cancel instruction that refunds pro-rata.
- **TabFM manipulation.** A compromised oracle service could bias `probs`
  within `MIN_PROB` bounds. Mitigation is (a) rotate keys via `rotate_oracle`,
  (b) run a multi-signer oracle quorum (future work), (c) optional
  `TABULA_ORACLE_API_KEY` on the FastAPI surface.
- **GlobalConfig front-run.** `initialize_global` is permissionless one-shot;
  the first deployer becomes admin. Deploy via a controlled script on a fresh
  program id; do not leave the race open on shared validators.
- **Solana runtime / dalek advisories.** `RUSTSEC-2024-0344` and
  `RUSTSEC-2022-0093` are ignored in `.cargo/audit.toml` as Solana 1.18 /
  Anchor 0.30 transitive deps; clear on Anchor upgrade.
- **On-chain data availability.** TxLINE anchors Merkle roots per epoch-day;
  if TxODDS is down when a market resolves, settlement waits until the API
  recovers. There is no fallback data source in the MVP.

## Cryptographic Assumptions

- Solana keypair confidentiality (`ed25519`).
- SHA-256 / Keccak-256 pre-image resistance for Merkle inclusion proofs.
- TxLINE's off-chain signing chain (JWT + wallet signature) is trusted as
  the authoritative source-of-truth for stat values on the **real-txline**
  path. TabulaMarkets does **not** re-verify the Merkle proof itself — it
  relies on the keeper having successfully executed
  `Txoracle.validateStat(...).view()` against the deployed TxODDS program
  before posting a one-shot `TxLineAttestation` bound to `(pool, market)`.

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
  — never the pool `authority` or `GlobalConfig.admin`.

## Auditing Checklist Before Any Mainnet Deploy

- [ ] External Solana audit of `programs/tabula-markets` (Trail of Bits, Neodyme, OtterSec…).
- [ ] Formal specification of the Q_SCALE fixed-point math (numerical stability + rounding under adversarial inputs).
- [ ] Real LMSR cost-function pricing (current path is fixed-odds at oracle marginal price with `MIN_PROB` + liability caps).
- [ ] On-chain TxODDS CPI / signature verification for `real-txline` (close F-004).
- [ ] Fuzz `place_bet` / `settle_via_txline` with `honggfuzz-rs` or `cargo-fuzz`.
- [ ] Test replay-attack scenarios against `TxLineAttestation` freshness and one-shot `used` flag.
- [ ] Chaos-test the keeper: kill / restart under load, verify no double-submission.
- [ ] Load-test the oracle: TabFM latency under batch of 32 concurrent requests.
- [ ] Confirm no `panic!`/`unwrap` remains in program code (grep already clean; keep it that way in CI via clippy).
- [ ] Legal review for jurisdiction of intended users.
