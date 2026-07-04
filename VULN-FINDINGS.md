# Vulnerability Findings — prop-it (TabulaMarkets)

**Target:** `/Users/macbook/DAEMON_BLOCKINT_TECHNOLOGIES/prop-it`  
**Scanned at:** 2026-07-04T04:32:00Z  
**Focus areas:** 6  
**Source files (non-test):** ~20  

**Summary:** 26 findings (12 HIGH / 7 MEDIUM / 7 LOW), 0 low-confidence (&lt; 0.4)

These are **static candidates**, not execution-verified. For verified crashes/PoCs, use `vuln-pipeline run <target>`.

## Summary table

| ID | Severity | Category | File:line | Title |
|----|----------|----------|-----------|-------|
| F-001 | HIGH | auth-bypass | programs/tabula-markets/src/lib.rs:129 | Permissionless create_market allows attacker-chosen probabilities |
| F-002 | HIGH | logic-bug | programs/tabula-markets/src/lib.rs:246 | Exposure cap tracks stake-in, not payout liability |
| F-003 | HIGH | logic-bug | programs/tabula-markets/src/lib.rs:266 | Share mint pays $1/share while price can be ~1/Q_SCALE, enabling vault drain |
| F-004 | HIGH | crypto-weakness | programs/tabula-markets/src/lib.rs:373 | real-txline settlement never verifies TxLINE; keeper attestation is sole trust root |
| F-005 | HIGH | account-confusion | programs/tabula-markets/src/lib.rs:607 | update_prediction binds oracle to an arbitrary pool, not to the market |
| F-006 | HIGH | privilege-escalation | programs/tabula-markets/src/lib.rs:677 | Settlement oracle of any pool can resolve any market and drain victim vault |
| F-007 | HIGH | auth-bypass | programs/txline-mock/src/lib.rs:27 | Unauthenticated publish_stat_root lets anyone anchor a malicious Merkle root |
| F-008 | HIGH | auth-bypass | oracle/tabula_oracle/server.py:172 | Unauthenticated /predict returns pricing vectors that feed on-chain LMSR |
| F-009 | HIGH | logic-bug | keeper/src/oracle.ts:41 | Oracle /predict response trusted without schema or economic validation |
| F-010 | MEDIUM | logic-bug | app/src/components/ReceiptPanel.tsx:20 | Receipt UI presents hardcoded mock Merkle data as authentic on-chain settlement proof |
| F-011 | MEDIUM | logic-bug | programs/tabula-markets/src/lib.rs:415 | No vault solvency check before minting or paying; shared vault cross-market contagion |
| F-012 | MEDIUM | privilege-escalation | programs/tabula-markets/src/lib.rs:526 | Permissionless initialize_pool allows front-running canonical mint authority |
| F-013 | MEDIUM | logic-bug | programs/tabula-markets/src/lib.rs:655 | Market is not bound to Pool; pause and pool context are bypassable at settlement |
| F-014 | HIGH | logic-bug | programs/tabula-markets/src/lib.rs:190 | update_prediction can set near-zero prices and instantly underprice liability |
| F-015 | HIGH | logic-bug | keeper/src/index.ts:82 | TxLINE SSE live stats drive predictions with no integrity checks |
| F-016 | MEDIUM | auth-bypass | programs/tabula-markets/src/lib.rs:338 | Mock settle_via_txline is permissionless; any holder of a valid proof can resolve |
| F-017 | MEDIUM | integrity-failure | oracle/tabula_oracle/tabfm_engine.py:111 | Load failure silently falls back to deterministic mock while still reporting ready |
| F-018 | MEDIUM | auth-bypass | keeper/src/metrics.ts:58 | Unauthenticated metrics/health bind all interfaces and leak prediction timing |
| F-019 | LOW | logic-bug | programs/txline-mock/src/lib.rs:59 | Merkle leaf omits match_id; safety depends entirely on StatRoot PDA binding |
| F-020 | LOW | auth-bypass | programs/tabula-markets/src/lib.rs:559 | AdminOnly relies on body checks only; no has_one on pool.authority |
| F-021 | LOW | information-disclosure | oracle/tabula_oracle/server.py:155 | Unauthenticated /metrics, /model, and /health expose backend and operational state |
| F-022 | LOW | logic-bug | app/src/app/page.tsx:36 | Untrusted oracle JSON is rendered as authoritative market probabilities and odds |
| F-023 | HIGH | crypto-weakness | keeper/src/txlineClient.ts:138 | fetchStatValidation returns API proofs/stat values with no local verification |
| F-024 | LOW | integer-overflow | programs/tabula-markets/src/lib.rs:310 | shares as i64 truncation when updating market.q |
| F-025 | LOW | input-validation | oracle/tabula_oracle/server.py:79 | Unbounded score_diff and client-chosen base_b fully steer model outputs |
| F-026 | LOW | secrets-in-logs | keeper/src/txlineClient.ts:83 | HTTP error bodies embedded in exceptions; log redaction misses opaque API tokens |

## Findings

### F-001 — HIGH — Permissionless create_market allows attacker-chosen probabilities

- **File:** `programs/tabula-markets/src/lib.rs:129`
- **Category:** auth-bypass
- **Confidence:** 1.0 — CreateMarket is any signer + unpaused pool; initial_probs only need sum≈Q_SCALE so p_i=1 is valid; Market has no pool field and vault is pool-scoped.

**Description:** create_market is callable by any signer with no pool.authority or oracle check. The creator supplies initial_probs subject only to sum ≈ Q_SCALE. A market with `initial_probs = [1, Q_SCALE-1]` is valid and enables the share-mint vault drain (F-003). Markets are not bound to a pool; PlaceBet/ClaimWinnings pair any market with the pool vault.

**Exploit scenario:** Attacker creates a market with `probs=[1, 999_999]`, bets minimum USDC on outcome 0, resolves that outcome, and claims a payout orders of magnitude above stake from the shared vault.

**Recommendation:** Restrict create_market to pool.authority or oracle_authority; store pool on Market; enforce minimum per-outcome probability.

---

### F-002 — HIGH — Exposure cap tracks stake-in, not payout liability

- **File:** `programs/tabula-markets/src/lib.rs:246`
- **Category:** logic-bug
- **Confidence:** 1.0 — exposure only adds usdc_amount against MAX_MARKET_EXPOSURE; liability is shares which can be ~Q_SCALE× stake.

**Description:** place_bet only does `exposure += usdc_amount`. Outstanding claimable liability is `position.shares` (paid 1:1 as USDC), which can be up to ~Q_SCALE× larger than stake when p_i is tiny.

**Exploit scenario:** Attacker places small-stake bets on a near-zero-priced outcome, stays under the exposure cap, then claims far more than 1M USDC of liability.

**Recommendation:** Track liability as sum(shares) and require liability ≤ min(MAX_MARKET_EXPOSURE, vault free capital).

---

### F-003 — HIGH — Share mint pays $1/share while price can be ~1/Q_SCALE, enabling vault drain

- **File:** `programs/tabula-markets/src/lib.rs:266`
- **Category:** logic-bug
- **Confidence:** 1.0 — shares = usdc*Q_SCALE/price_scaled with p_i=1 → price_scaled=1; claim pays shares as USDC.

**Description:** place_bet mints `shares = usdc_amount * Q_SCALE / price_scaled`. claim_winnings pays `gross = position.shares` in USDC. For p_i = 1, price_scaled = 1, so 1 USDC stake mints ~1M USDC of claimable liability. `liquidity_b` and `market.q` are never used in pricing.

**Exploit scenario:** Attacker bets 1 USDC on an outcome with p_i=1, receives ~1e12 shares, resolves that outcome, claims ~1M USDC from the LP vault.

**Recommendation:** Implement real LMSR cost-function pricing, or enforce min p_i and bankroll-consistent share minting.

---

### F-004 — HIGH — real-txline settlement never verifies TxLINE; keeper attestation is sole trust root

- **File:** `programs/tabula-markets/src/lib.rs:373`
- **Category:** crypto-weakness
- **Confidence:** 1.0 — only settlement_oracle + attestation PDA; no Merkle/TxODDS CPI (txodds_* args unused).

**Description:** Under `real-txline`, settle_via_txline does not CPI to TxODDS, does not check a Merkle proof, and does not verify any TxLINE signature. Checks are only settlement_oracle signer, attestation freshness, and field match. post_txline_attestation lets that oracle write arbitrary stat_value.

**Exploit scenario:** Compromised settlement_oracle posts attestation with V_attacker and settles within 15 minutes; correlated positions claim vault funds.

**Recommendation:** CPI into real TxLINE/txoracle or verify a signature over (match_id, stat_type, stat_value, …) from a known TxLINE key.

---

### F-005 — HIGH — update_prediction binds oracle to an arbitrary pool, not to the market

- **File:** `programs/tabula-markets/src/lib.rs:607`
- **Category:** account-confusion
- **Confidence:** 1.0 — Auth is oracle == pool.oracle_authority only; Market has no pool field.

**Description:** UpdatePrediction checks `oracle == pool.oracle_authority` but never constrains that market belongs to pool. Attacker inits their own pool as oracle_authority and updates any victim market's probs.

**Exploit scenario:** Attacker creates mint M', inits pool with self as oracle, calls update_prediction on victim market with extreme probs, then bets the mispriced side against the real USDC vault.

**Recommendation:** Store `pool` on Market; constrain `market.pool == pool.key()` on UpdatePrediction.

---

### F-006 — HIGH — Settlement oracle of any pool can resolve any market and drain victim vault

- **File:** `programs/tabula-markets/src/lib.rs:677`
- **Category:** privilege-escalation
- **Confidence:** 1.0 — attest/settle check oracle against passed pool only; claim pays from passed pool vault.

**Description:** Attacker inits a pool with themselves as settlement_oracle, attests and resolves any market to a chosen bin, then claim_winnings with the victim pool vault.

**Exploit scenario:** Bet on victim market via real USDC pool → settle with attacker pool → claim from victim vault.

**Recommendation:** Bind market to exactly one pool on attest, settle, and claim.

---

### F-007 — HIGH — Unauthenticated publish_stat_root lets anyone anchor a malicious Merkle root

- **File:** `programs/txline-mock/src/lib.rs:27`
- **Category:** auth-bypass
- **Confidence:** 1.0 — publish_stat_root only requires a signer; no authority allowlist.

**Description:** Any signer can init the stat-root PDA for a match_id with an arbitrary merkle_root (first writer wins). Mock settlement treats that root as authoritative.

**Exploit scenario:** Race publish_stat_root for match M with a root covering a favorable V, bet, settle, claim.

**Recommendation:** Gate publish_stat_root on a fixed TxLINE authority.

---

### F-008 — HIGH — Unauthenticated /predict returns pricing vectors that feed on-chain LMSR

- **File:** `oracle/tabula_oracle/server.py:172`
- **Category:** auth-bypass
- **Confidence:** 1.0 — /predict has no auth; HOST defaults to 0.0.0.0.

**Description:** POST /predict has no authentication. Any network client can obtain or influence probs_q6 / liquidity_b that the keeper is designed to push on-chain. Default bind is 0.0.0.0 without TLS.

**Exploit scenario:** Reachable oracle or MITM on keeper→oracle path returns attacker-chosen probs for the next update_prediction.

**Recommendation:** API key or mTLS on /predict; TLS; bind loopback by default; signed responses.

---

### F-009 — HIGH — Oracle /predict response trusted without schema or economic validation

- **File:** `keeper/src/oracle.ts:41`
- **Category:** logic-bug
- **Confidence:** 1.0 — callOracle casts response with no checks; signing still TODO (would.submit).

**Description:** callOracle returns `data as PredictResponse` with no validation of length, Q6 sum, or bounds. Trust boundary is established for when Anchor signing is wired.

**Exploit scenario:** Compromised/MITM'd oracle returns skewed probs; keeper signs them once update_prediction is wired.

**Recommendation:** Validate invariants before signing; pin oracle identity.

---

### F-010 — MEDIUM — Receipt UI presents hardcoded mock Merkle data as authentic on-chain settlement proof

- **File:** `app/src/components/ReceiptPanel.tsx:20`
- **Category:** logic-bug
- **Confidence:** 1.0 — loadDemoReceipt hardcodes all fields; no chain read or verify.

**Description:** Fetch receipt always injects fixed client-side values (stat_value: 5, static siblings including 0xdeadbeef…) while UI copy claims on-chain TxLINE proof.

**Exploit scenario:** Users believe settlement was cryptographically verified when it was not.

**Recommendation:** Load from on-chain PDAs and verify Merkle path in-browser, or label as unverified demo and fail closed.

---

### F-011 — MEDIUM — No vault solvency check before minting or paying; shared vault cross-market contagion

- **File:** `programs/tabula-markets/src/lib.rs:415`
- **Category:** logic-bug
- **Confidence:** 1.0 — claim transfers with no vault.amount check; one vault backs many markets.

**Description:** No check that vault reserves cover outstanding share liability. All markets share one vault per pool.

**Exploit scenario:** Over-mint on market A drains vault; honest winners on market B cannot be paid.

**Recommendation:** Reserved liability accounting; place_bet requires vault.amount ≥ reserves + new shares.

---

### F-012 — MEDIUM — Permissionless initialize_pool allows front-running canonical mint authority

- **File:** `programs/tabula-markets/src/lib.rs:526`
- **Category:** privilege-escalation
- **Confidence:** 1.0 — any signer; pool PDA is [b"pool", usdc_mint]; first writer wins.

**Description:** First caller to initialize_pool for a mint owns authority and both oracles.

**Exploit scenario:** Attacker inits pool for mainnet USDC before operators; honest init fails.

**Recommendation:** Atomic deploy+init, or require deployer/multisig constraint.

---

### F-013 — MEDIUM — Market is not bound to Pool; pause and pool context are bypassable at settlement

- **File:** `programs/tabula-markets/src/lib.rs:655`
- **Category:** logic-bug
- **Confidence:** 1.0 — Market has no pool field; settle only checks !pool.paused on the passed pool.

**Description:** Settlement can use any unpaused pool while resolving a global market PDA.

**Exploit scenario:** Admin pauses primary pool; attacker settles via a decoy unpaused pool; after unpause, claims drain primary vault.

**Recommendation:** Bind market.pool at creation; constrain all instructions.

---

### F-014 — HIGH — update_prediction can set near-zero prices and instantly underprice liability

- **File:** `programs/tabula-markets/src/lib.rs:190`
- **Category:** logic-bug
- **Confidence:** 0.9 — oracle-gated but can set p_i=1, enabling F-003 mint path.

**Description:** Oracle may set any normalized probs including p_i=1. liquidity_b is written but never used in place_bet. No solvency check on update.

**Exploit scenario:** Compromised/buggy oracle posts p_win=1; attackers race place_bet and drain vault after resolve.

**Recommendation:** Min p_i, liability checks on update, or real LMSR inventory pricing.

---

### F-015 — HIGH — TxLINE SSE live stats drive predictions with no integrity checks

- **File:** `keeper/src/index.ts:82`
- **Category:** logic-bug
- **Confidence:** 0.9 — SSE JSON.parse payloads treated as any and fed to callOracle.

**Description:** Live features from SSE are unvalidated (no signature, seq, freshness, or range checks).

**Exploit scenario:** Poisoned scores stream fabricates live state → misleading oracle probs → signed update when wired.

**Recommendation:** Validate types/ranges; enforce monotonicity; cross-check snapshots; require paid auth in production.

---

### F-016 — MEDIUM — Mock settle_via_txline is permissionless; any holder of a valid proof can resolve

- **File:** `programs/tabula-markets/src/lib.rs:338`
- **Category:** auth-bypass
- **Confidence:** 0.9 — only payer signer; combined with F-007 fully controls resolution.

**Description:** Mock settle requires only a payer signer. With open publish_stat_root, no second gate before resolution.

**Exploit scenario:** After malicious root, attacker settles as ordinary payer without settlement_oracle key.

**Recommendation:** Require settlement_oracle on mock path for shared networks, or fix F-007.

---

### F-017 — MEDIUM — Load failure silently falls back to deterministic mock while still reporting ready

- **File:** `oracle/tabula_oracle/tabfm_engine.py:111`
- **Category:** integrity-failure
- **Confidence:** 0.9 — load errors set backend=mock; /readyz still ready.

**Description:** TabFM load failure falls back to deterministic mock; /readyz reports ready.

**Exploit scenario:** Attacker detects mock via /health, reproduces outputs offline, trades against mis-specified LMSR.

**Recommendation:** Fail closed in production; keeper refuse model_backend == "mock".

---

### F-018 — MEDIUM — Unauthenticated metrics/health bind all interfaces and leak prediction timing

- **File:** `keeper/src/metrics.ts:58`
- **Category:** auth-bypass
- **Confidence:** 0.9 — listen on all interfaces; exposes last_prediction_ms and divergence.

**Description:** Metrics server has no auth and binds all interfaces. Exposes pre-submit prediction timing and ensemble divergence.

**Exploit scenario:** Network peer scrapes metrics and races bets before update_prediction lands.

**Recommendation:** Bind 127.0.0.1; auth; avoid exporting pre-submit timing publicly.

---

### F-019 — LOW — Merkle leaf omits match_id; safety depends entirely on StatRoot PDA binding

- **File:** `programs/txline-mock/src/lib.rs:59`
- **Category:** logic-bug
- **Confidence:** 0.9 — leaf is keccak(stat_type || stat_value_le) only.

**Description:** Leaf is not domain-separated by match_id. Today Tabula checks match_id after CPI.

**Exploit scenario:** Future integration omits match_id check and reuses a proof across markets.

**Recommendation:** Leaf = keccak(match_id || stat_type || stat_value_le).

---

### F-020 — LOW — AdminOnly relies on body checks only; no has_one on pool.authority

- **File:** `programs/tabula-markets/src/lib.rs:559`
- **Category:** auth-bypass
- **Confidence:** 0.9 — fragile pattern; current instructions do require_keys_eq.

**Description:** AdminOnly has no has_one = authority. Current admin instructions check in body; future reuse without the check would be open.

**Exploit scenario:** New admin instruction omits body check; any signer pauses or rotates oracles.

**Recommendation:** Add has_one = authority on AdminOnly.

---

### F-021 — LOW — Unauthenticated /metrics, /model, and /health expose backend and operational state

- **File:** `oracle/tabula_oracle/server.py:155`
- **Category:** information-disclosure
- **Confidence:** 0.9 — open endpoints return backend mode metadata.

**Description:** Unauthenticated health/model/metrics reveal mock vs tabfm and operational metrics. OpenAPI docs enabled by default.

**Exploit scenario:** Attacker learns mock mode and prioritizes front-running.

**Recommendation:** Auth on metrics/model; disable OpenAPI in production.

---

### F-022 — LOW — Untrusted oracle JSON is rendered as authoritative market probabilities and odds

- **File:** `app/src/app/page.tsx:36`
- **Category:** logic-bug
- **Confidence:** 0.9 — no validation; bets are alert-only currently.

**Description:** Oracle JSON drives displayed odds with no integrity check. place_bet not wired yet.

**Exploit scenario:** MITM/compromised oracle shows attractive odds; users act on them when betting is wired.

**Recommendation:** Validate responses; prefer on-chain prices as source of truth.

---

### F-023 — HIGH — fetchStatValidation returns API proofs/stat values with no local verification

- **File:** `keeper/src/txlineClient.ts:138`
- **Category:** crypto-weakness
- **Confidence:** 0.8 — no local verify; settlement wiring to this API is latent.

**Description:** Stat-validation REST response is trusted without local Merkle verification. merkle.ts exists but is unused. Settlement does not call this path yet.

**Exploit scenario:** When wired, malicious REST response induces wrong settlement attestation.

**Recommendation:** Locally verify proofs before any attestation; never attest solely from REST JSON.

---

### F-024 — LOW — shares as i64 truncation when updating market.q

- **File:** `programs/tabula-markets/src/lib.rs:310`
- **Category:** integer-overflow
- **Confidence:** 0.7 — cast can wrap in principle; q unused for pricing today.

**Description:** `shares as i64` truncates without checked conversion. q is write-only currently.

**Exploit scenario:** Future LMSR using q inherits corrupted inventory.

**Recommendation:** Use i128 or try_from before add.

---

### F-025 — LOW — Unbounded score_diff and client-chosen base_b fully steer model outputs

- **File:** `oracle/tabula_oracle/server.py:79`
- **Category:** input-validation
- **Confidence:** 0.7 — score_diff unbounded; base_b is client-chosen but capped at 1e10.

**Description:** score_diff has no bounds; base_b is client-chosen (capped). Combined with F-008, clients can search for adversarial outputs.

**Exploit scenario:** Sweep features against /predict to maximize mass on a chosen bin.

**Recommendation:** Bound features; ignore or allowlist client base_b.

---

### F-026 — LOW — HTTP error bodies embedded in exceptions; log redaction misses opaque API tokens

- **File:** `keeper/src/txlineClient.ts:83`
- **Category:** secrets-in-logs
- **Confidence:** 0.7 — res.text() in errors; redaction misses opaque apiToken.

**Description:** Failed TxLINE calls embed full response bodies in Error strings. log.ts redacts JWTs but not opaque API tokens.

**Exploit scenario:** Error body echoes token; log drain leaks credentials.

**Recommendation:** Log status codes only; extend redaction for apiToken / Bearer / X-Api-Token.
