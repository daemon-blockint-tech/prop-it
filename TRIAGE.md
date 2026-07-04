# Triage Report — prop-it (TabulaMarkets)

**Source:** `VULN-FINDINGS.json`  
**Target:** `/Users/macbook/DAEMON_BLOCKINT_TECHNOLOGIES/prop-it`  
**Triaged at:** 2026-07-04T04:57:22Z  
**Method:** 3-vote static verification (independent agents A/B/C, majority)

## Summary

| Verdict | Count |
|---------|-------|
| Input findings | 26 |
| **true_positive** | **21** (18 live, 3 latent) |
| false_positive | 4 |
| needs_info | 1 |
| duplicate | 0 |

**What changed vs `VULN-FINDINGS.json`:** 3-vote verification dropped 4 false positives and parked 1 needs_info. No exact duplicates; related issues are grouped into fix clusters. True positives are ranked by `patch_priority` for `/patch`.

## Fix clusters (patch together)

### LMSR pricing / vault drain — primary `F-003`
- Members: `F-001`, `F-002`, `F-003`, `F-011`, `F-014`
- Implement real LMSR or min-price + liability caps; restrict create_market.

### Market↔pool binding — primary `F-005`
- Members: `F-005`, `F-006`, `F-013`
- Store pool on Market; constrain all privileged and payout instructions.

### Settlement trust — primary `F-007`
- Members: `F-004`, `F-007`, `F-016`
- Gate mock publish_stat_root; CPI/verify TxLINE on real path.

### Oracle/keeper integrity — primary `F-008`
- Members: `F-008`, `F-009`, `F-015`, `F-017`, `F-021`, `F-025`
- Auth /predict; validate responses; fail-closed on mock; validate SSE before submit.

## True positives (patch queue)

| Pri | ID | Sev | Latent | Owner | File:line | Title |
|-----|----|-----|--------|-------|-----------|-------|
| 1 | F-003 | HIGH | no | on-chain | `programs/tabula-markets/src/lib.rs:266` | Share mint pays $1/share while price can be ~1/Q_SCALE, enabling vault drain |
| 2 | F-005 | HIGH | no | on-chain | `programs/tabula-markets/src/lib.rs:607` | update_prediction binds oracle to an arbitrary pool, not to the market |
| 3 | F-006 | HIGH | no | on-chain | `programs/tabula-markets/src/lib.rs:677` | Settlement oracle of any pool can resolve any market and drain victim vault |
| 4 | F-001 | HIGH | no | on-chain | `programs/tabula-markets/src/lib.rs:129` | Permissionless create_market allows attacker-chosen probabilities |
| 5 | F-002 | HIGH | no | on-chain | `programs/tabula-markets/src/lib.rs:246` | Exposure cap tracks stake-in, not payout liability |
| 6 | F-007 | HIGH | no | on-chain-mock | `programs/txline-mock/src/lib.rs:27` | Unauthenticated publish_stat_root lets anyone anchor a malicious Merkle root |
| 7 | F-004 | HIGH | no | on-chain | `programs/tabula-markets/src/lib.rs:373` | real-txline settlement never verifies TxLINE; keeper attestation is sole trust root |
| 8 | F-014 | HIGH | no | on-chain | `programs/tabula-markets/src/lib.rs:190` | update_prediction can set near-zero prices and instantly underprice liability |
| 9 | F-013 | MEDIUM | no | on-chain | `programs/tabula-markets/src/lib.rs:655` | Market is not bound to Pool; pause and pool context are bypassable at settlement |
| 10 | F-011 | MEDIUM | no | on-chain | `programs/tabula-markets/src/lib.rs:415` | No vault solvency check before minting or paying; shared vault cross-market contagion |
| 11 | F-016 | MEDIUM | no | on-chain | `programs/tabula-markets/src/lib.rs:338` | Mock settle_via_txline is permissionless; any holder of a valid proof can resolve |
| 12 | F-012 | MEDIUM | no | on-chain | `programs/tabula-markets/src/lib.rs:526` | Permissionless initialize_pool allows front-running canonical mint authority |
| 13 | F-008 | HIGH | no | oracle | `oracle/tabula_oracle/server.py:172` | Unauthenticated /predict returns pricing vectors that feed on-chain LMSR |
| 14 | F-010 | MEDIUM | no | frontend | `app/src/components/ReceiptPanel.tsx:20` | Receipt UI presents hardcoded mock Merkle data as authentic on-chain settlement proof |
| 15 | F-017 | MEDIUM | no | oracle | `oracle/tabula_oracle/tabfm_engine.py:111` | Load failure silently falls back to deterministic mock while still reporting ready |
| 16 | F-009 | HIGH | yes | keeper | `keeper/src/oracle.ts:41` | Oracle /predict response trusted without schema or economic validation |
| 17 | F-015 | HIGH | yes | keeper | `keeper/src/index.ts:82` | TxLINE SSE live stats drive predictions with no integrity checks |
| 18 | F-018 | MEDIUM | yes | keeper | `keeper/src/metrics.ts:58` | Unauthenticated metrics/health bind all interfaces and leak prediction timing |
| 19 | F-021 | LOW | no | oracle | `oracle/tabula_oracle/server.py:155` | Unauthenticated /metrics, /model, and /health expose backend and operational state |
| 20 | F-025 | LOW | no | oracle | `oracle/tabula_oracle/server.py:79` | Unbounded score_diff and client-chosen base_b fully steer model outputs |
| 21 | F-026 | LOW | no | keeper | `keeper/src/txlineClient.ts:83` | HTTP error bodies embedded in exceptions; log redaction misses opaque API tokens |

## False positives (dropped from patch queue)

### F-022 — Untrusted oracle JSON is rendered as authoritative market probabilities and odds
- `app/src/app/page.tsx:36` · LOW
- **Votes:** A/B/C = false_positive
- **Why:** place_bet is alert-only; no fund path today.

### F-024 — shares as i64 truncation when updating market.q
- `programs/tabula-markets/src/lib.rs:310` · LOW
- **Votes:** A/B/C = false_positive
- **Why:** market.q unused for pricing/payout today.

### F-020 — AdminOnly relies on body checks only; no has_one on pool.authority
- `programs/tabula-markets/src/lib.rs:559` · LOW
- **Votes:** A/B/C = false_positive
- **Why:** Body checks enforce pool.authority today; no live bypass.

### F-019 — Merkle leaf omits match_id; safety depends entirely on StatRoot PDA binding
- `programs/txline-mock/src/lib.rs:59` · LOW
- **Votes:** A/B/C = false_positive
- **Why:** match_id checked after CPI today; future footgun only.

## Needs info

### F-023 — fetchStatValidation returns API proofs/stat values with no local verification
- `keeper/src/txlineClient.ts:138` · HIGH
- **Why:** fetchStatValidation unused; settlement not wired to it.
- **Revisit when:** settlement attestation is wired to `fetchStatValidation` or another REST proof path.

## Per-finding notes (true positives)

### F-003 — [HIGH] Share mint pays $1/share while price can be ~1/Q_SCALE, enabling vault drain
- `programs/tabula-markets/src/lib.rs:266` · owner: `on-chain` · patch_priority: 1
- **Votes:** 3/3 true_positive
- **Rationale:** Share mint vs $1/share claim is live vault-drain math.
- **Related:** `F-001`, `F-002`, `F-011`, `F-014`
- **Recommendation:** Price shares with a real LMSR cost function using q and b so cost(Δq) is paid in USDC and winning shares redeem at $1 with inventory-consistent liabilities. Reject p_i below a minimum that keeps max leverage within vault capital.

### F-005 — [HIGH] update_prediction binds oracle to an arbitrary pool, not to the market
- `programs/tabula-markets/src/lib.rs:607` · owner: `on-chain` · patch_priority: 2
- **Votes:** 3/3 true_positive
- **Rationale:** Missing market.pool lets any-pool oracle reprice any market.
- **Related:** `F-006`, `F-013`
- **Recommendation:** Store pool: Pubkey on Market at create_market. Seed markets as [b"market", pool.key(), match_id]. On UpdatePrediction, add constraint = market.pool == pool.key(). Authorize against that pool's oracle_authority only.

### F-006 — [HIGH] Settlement oracle of any pool can resolve any market and drain victim vault
- `programs/tabula-markets/src/lib.rs:677` · owner: `on-chain` · patch_priority: 3
- **Votes:** 3/3 true_positive
- **Rationale:** Any-pool settlement_oracle resolves market; claim from victim vault.
- **Related:** `F-005`, `F-013`, `F-004`
- **Recommendation:** Bind each market to exactly one pool (field + PDA seeds). On PostTxLineAttestation, SettleViaTxLineReal, and ClaimWinnings, require market.pool == pool.key(). Ensure pause is evaluated for the market's home pool.

### F-001 — [HIGH] Permissionless create_market allows attacker-chosen probabilities
- `programs/tabula-markets/src/lib.rs:129` · owner: `on-chain` · patch_priority: 4
- **Votes:** 3/3 true_positive
- **Rationale:** Permissionless create_market accepts attacker probs; enables F-003 drain.
- **Related:** `F-002`, `F-003`, `F-011`, `F-014`
- **Recommendation:** Restrict create_market to pool.authority or oracle_authority; store pool on Market and constrain PlaceBet/ClaimWinnings to that pool; enforce a minimum per-outcome probability and/or maximum shares-per-USDC at creation time.

### F-002 — [HIGH] Exposure cap tracks stake-in, not payout liability
- `programs/tabula-markets/src/lib.rs:246` · owner: `on-chain` · patch_priority: 5
- **Votes:** 3/3 true_positive
- **Rationale:** Exposure tracks stake-in only; liability is shares.
- **Related:** `F-003`, `F-011`
- **Recommendation:** Track per-outcome (or max-outcome) liability as sum(shares) and require liability ≤ min(MAX_MARKET_EXPOSURE, vault free capital). On each bet, delta_liability must pass the cap before minting.

### F-007 — [HIGH] Unauthenticated publish_stat_root lets anyone anchor a malicious Merkle root
- `programs/txline-mock/src/lib.rs:27` · owner: `on-chain-mock` · patch_priority: 6
- **Votes:** 3/3 true_positive
- **Rationale:** Any signer publishes Merkle root; default mock settlement trusts it.
- **Related:** `F-016`
- **Recommendation:** Gate publish_stat_root on a fixed TxLINE authority (config PDA / upgrade authority / hardcoded pubkey). Until then, treat mock settlement as fully attacker-controlled whenever the attacker can race publish_stat_root.

### F-004 — [HIGH] real-txline settlement never verifies TxLINE; keeper attestation is sole trust root
- `programs/tabula-markets/src/lib.rs:373` · owner: `on-chain` · patch_priority: 7
- **Votes:** 3/3 true_positive
- **Rationale:** real-txline trusts settlement_oracle attestation only.
- **Related:** `F-006`
- **Recommendation:** On the production path, CPI into the real TxLINE/txoracle program (or verify an ed25519 signature over match_id, stat_type, stat_value, fixture_id, seq from a known TxLINE key). Do not treat keeper-written PDAs as evidence of Merkle validation.

### F-014 — [HIGH] update_prediction can set near-zero prices and instantly underprice liability
- `programs/tabula-markets/src/lib.rs:190` · owner: `on-chain` · patch_priority: 8
- **Votes:** 3/3 true_positive
- **Rationale:** update_prediction can set p_i=1 enabling F-003 mint.
- **Related:** `F-003`, `F-005`
- **Recommendation:** When updating probs, enforce min p_i, recompute and enforce global liability vs vault equity, and/or pause betting around updates. Prefer LMSR inventory pricing so oracle probs steer b/prior without directly setting executable price to 1/Q_SCALE.

### F-013 — [MEDIUM] Market is not bound to Pool; pause and pool context are bypassable at settlement
- `programs/tabula-markets/src/lib.rs:655` · owner: `on-chain` · patch_priority: 9
- **Votes:** 3/3 true_positive
- **Rationale:** Pause checked on caller-chosen pool; home-pool pause bypassable.
- **Related:** `F-005`, `F-006`
- **Recommendation:** Store pool on Market at creation and constrain market.pool == pool.key() in settle, claim, bet, and attestation accounts. Consider including pool.key() in market PDA seeds.

### F-011 — [MEDIUM] No vault solvency check before minting or paying; shared vault cross-market contagion
- `programs/tabula-markets/src/lib.rs:415` · owner: `on-chain` · patch_priority: 10
- **Votes:** 3/3 true_positive
- **Rationale:** No vault solvency vs share liability; cross-market contagion.
- **Related:** `F-002`, `F-003`
- **Recommendation:** Maintain reserved_liability per market and globally; place_bet must require vault.amount ≥ reserved_liability + new_shares. On claim, debit reserves and total_liquidity. Consider per-market vaults.

### F-016 — [MEDIUM] Mock settle_via_txline is permissionless; any holder of a valid proof can resolve
- `programs/tabula-markets/src/lib.rs:338` · owner: `on-chain` · patch_priority: 11
- **Votes:** 3/3 true_positive
- **Rationale:** Mock settle permissionless; with F-007 anyone resolves.
- **Related:** `F-007`
- **Recommendation:** If mock mode is only for demos, document that it is not production-safe. For any shared validator/devnet value, either require settlement_oracle on the mock path as well, or fix F-007 and add an optional allowlist/timelock before resolve_market.

### F-012 — [MEDIUM] Permissionless initialize_pool allows front-running canonical mint authority
- `programs/tabula-markets/src/lib.rs:526` · owner: `on-chain` · patch_priority: 12
- **Votes:** 3/3 true_positive
- **Rationale:** First-writer initialize_pool owns mint's authority and oracles.
- **Related:** `F-005`, `F-006`
- **Recommendation:** Initialize in the same transaction as deployment, or require a fixed deployer pubkey / multisig as authority signer constraint, or use a config PDA initialized once by program upgrade authority.

### F-008 — [HIGH] Unauthenticated /predict returns pricing vectors that feed on-chain LMSR
- `oracle/tabula_oracle/server.py:172` · owner: `oracle` · patch_priority: 13
- **Votes:** 3/3 true_positive
- **Rationale:** Unauthenticated /predict on 0.0.0.0 is a live API surface.
- **Related:** `F-009`, `F-021`, `F-025`
- **Recommendation:** Require a shared secret (Bearer/API key) or mTLS on /predict; terminate TLS between keeper and oracle; bind to 127.0.0.1 by default; optionally sign responses and verify in the keeper.

### F-010 — [MEDIUM] Receipt UI presents hardcoded mock Merkle data as authentic on-chain settlement proof
- `app/src/components/ReceiptPanel.tsx:20` · owner: `frontend` · patch_priority: 14
- **Votes:** 3/3 true_positive
- **Rationale:** Hardcoded receipt presented as on-chain proof without demo label.
- **Recommendation:** Load receipt fields from on-chain StatReceipt / StatRoot PDAs, recompute the leaf and walk the Merkle path in the browser, or show a clear unverified demo banner and fail closed with INVALID if proof does not match.

### F-017 — [MEDIUM] Load failure silently falls back to deterministic mock while still reporting ready
- `oracle/tabula_oracle/tabfm_engine.py:111` · owner: `oracle` · patch_priority: 15
- **Votes:** 3/3 true_positive
- **Rationale:** Load failure falls back to mock while /readyz stays ready.
- **Related:** `F-008`, `F-021`
- **Recommendation:** Fail closed in production: if TabFM cannot load, exit non-zero or set backend to a non-ready state and return 503 from /predict and /readyz. Have the keeper refuse model_backend == "mock" before submitting update_prediction.

### F-009 — [HIGH] Oracle /predict response trusted without schema or economic validation
- `keeper/src/oracle.ts:41` · owner: `keeper` · patch_priority: 16
- **Latent:** yes — exploit path completes when keeper `would.submit.update_prediction` TODO is removed.
- **Votes:** 3/3 true_positive
- **Rationale:** Unvalidated oracle response; on-chain impact when submit TODO removed.
- **Related:** `F-008`, `F-015`
- **Recommendation:** Validate response shape and invariants before any signing: length, Q6 sum within on-chain tolerance, liquidity_b > 0, match_id binding. Pin oracle identity (mTLS / signed responses).

### F-015 — [HIGH] TxLINE SSE live stats drive predictions with no integrity checks
- `keeper/src/index.ts:82` · owner: `keeper` · patch_priority: 17
- **Latent:** yes — exploit path completes when keeper `would.submit.update_prediction` TODO is removed.
- **Votes:** 3/3 true_positive
- **Rationale:** Unvalidated SSE feeds callOracle; dangerous once submit wired.
- **Related:** `F-009`
- **Recommendation:** Treat SSE as untrusted input: validate types/ranges, enforce seq/timestamp monotonicity per fixture, cross-check snapshots via fetchScoresSnapshot, and require authenticated/paid tokens for production.

### F-018 — [MEDIUM] Unauthenticated metrics/health bind all interfaces and leak prediction timing
- `keeper/src/metrics.ts:58` · owner: `keeper` · patch_priority: 18
- **Latent:** yes — exploit path completes when keeper `would.submit.update_prediction` TODO is removed.
- **Votes:** 3/3 true_positive
- **Rationale:** Unauth metrics leak pre-submit timing; impact rises when submit wired.
- **Related:** `F-009`
- **Recommendation:** Bind metrics to 127.0.0.1 (or a private scrape network), require mTLS/bearer auth, and avoid exporting pre-submit timing/divergence on a public interface.

### F-021 — [LOW] Unauthenticated /metrics, /model, and /health expose backend and operational state
- `oracle/tabula_oracle/server.py:155` · owner: `oracle` · patch_priority: 19
- **Votes:** 3/3 true_positive
- **Rationale:** Unauth health/model/metrics expose backend mode.
- **Related:** `F-008`, `F-017`
- **Recommendation:** Keep probes on a separate internal listener or protect /metrics and /model with the same auth as /predict. Disable OpenAPI UI in production.

### F-025 — [LOW] Unbounded score_diff and client-chosen base_b fully steer model outputs
- `oracle/tabula_oracle/server.py:79` · owner: `oracle` · patch_priority: 20
- **Votes:** 3/3 true_positive
- **Rationale:** Client-chosen features/base_b steer unauthenticated /predict.
- **Related:** `F-008`
- **Recommendation:** Bound score_diff to realistic ranges. Cap base_b to an operator-configured allowlist (or ignore client base_b). Add sanity checks on returned probs_q6 in the keeper.

### F-026 — [LOW] HTTP error bodies embedded in exceptions; log redaction misses opaque API tokens
- `keeper/src/txlineClient.ts:83` · owner: `keeper` · patch_priority: 21
- **Votes:** 3/3 true_positive
- **Rationale:** Error bodies may leak tokens; redaction incomplete.
- **Recommendation:** Do not append full response bodies to errors; log status codes only. Never return/log apiToken/jwt. Extend redaction for apiToken, X-Api-Token, and Bearer values.

## Next step

```text
> /patch TRIAGE.json --repo /Users/macbook/DAEMON_BLOCKINT_TECHNOLOGIES/prop-it --top 3
```

Patches only `verdict == true_positive`. Prefer fixing clusters (pricing, pool binding, settlement) rather than one-off symptoms.
