# Solana Vulnerability Scan — prop-it programs

**Date:** 2026-07-04  
**Scope:** `programs/tabula-markets/src/lib.rs`, `programs/txline-mock/src/lib.rs`  
**Patterns:** Arbitrary CPI, Improper PDA Validation, Missing Ownership Check, Missing Signer Check, Sysvar Account Check, Improper Instruction Introspection  
**Method:** Static review of post-security-fix account structs and handlers; `rg` for invoke/CPI/deserialize/seeds/sysvar/introspection APIs.

## Dependency versions

| Crate | Declared | Locked |
|-------|----------|--------|
| `anchor-lang` | `0.30.1` (`init-if-needed`) | `0.30.1` |
| `anchor-spl` | `0.30.1` | (via workspace lock) |
| `solana-program` | (transitive via Anchor) | **`1.18.26`** |

Workspace note (`Cargo.toml`): pinned for Solana 1.18 / `cargo-build-sbf`. Sysvar spoofing class (pre-1.8.1) does not apply at this runtime.

Features: `tabula-markets` defaults to `mock-txline` (CPI into `txline-mock`); `real-txline` uses keeper-posted `TxLineAttestation` PDAs (no on-chain TxODDS CPI).

---

## Findings

### [LOW] Manual receipt deserialize omits owner check (defense-in-depth) — **FIXED**

**Location**: `programs/tabula-markets/src/lib.rs` (`settle_via_txline` / `SettleViaTxLineMock`)  
**Classification**: (a) was open — residual hardening gap; now closed  
**Description**: Settlement previously read the receipt via `MockStatReceipt::try_deserialize` on an `UncheckedAccount` (discriminator only). Caller now binds the receipt PDA with `seeds` / `seeds::program = txline_program`, and after CPI asserts `require_keys_eq!(*receipt.owner, txline_mock::ID)` before deserialize.

**Fix**: PDA seeds on `receipt`; post-CPI explicit owner check then `try_deserialize`. Receipt stays `UncheckedAccount` because `validate_stat` may `init_if_needed` it in the same instruction.

**Pattern**: Missing Ownership Check — **fixed**

---

### [LOW] Mock settlement leaves `stat_root` / `receipt` as unconstrained `UncheckedAccount` — **FIXED**

**Location**: `programs/tabula-markets/src/lib.rs` (`SettleViaTxLineMock`)  
**Classification**: (a) was open — account-validation gap; now closed  
**Description**: `stat_root` and `receipt` were `UncheckedAccount` with only `mut`. Caller now mirrors `txline-mock` constraints:

- `stat_root`: `Account<'info, MockStatRoot>` with `seeds = [b"stat-root", market.match_id]`, `bump = stat_root.bump`, `seeds::program = txline_program.key()` (owner via typed account).
- `receipt`: `UncheckedAccount` with `seeds = [b"receipt", stat_root.key(), market.match_id]`, `bump`, `seeds::program = txline_program.key()`; `require_keys_eq!(owner, txline_mock::ID)` after CPI.

**Pattern**: Improper PDA Validation / Missing Ownership Check — **fixed**

---

### [INFO] Real-txline settlement trusts `settlement_oracle` (by design, F-004)

**Location**: `programs/tabula-markets/src/lib.rs` (`SettleViaTxLineReal` / `PostTxLineAttestation`)  
**Classification**: (b) residual by design — **not** Missing Signer  
**Description**: `post_tx_line_attestation` and `settle_via_tx_line_real` require `settlement_oracle: Signer<'info>` and `require_keys_eq!(…, pool.settlement_oracle)`. Signer checks are present and correct. Residual risk is **trust**: a compromised keeper can post a false one-shot attestation (freshness + one-shot `used` still apply) because there is no on-chain TxODDS / Merkle CPI on the real path. Documented in `SECURITY.md` as F-004. No code change in this pass (defense-in-depth already has signer + one-shot + freshness).

**Attack Scenario**: Compromised keeper key posts `stat_value` that resolves the market to an attacker-favored outcome within `MAX_RECEIPT_AGE_SEC`.

**Recommendation**: Operational controls (HSM/multisig keeper) until on-chain TxODDS verification; do not treat as a missing `Signer` bug.

**Pattern**: Missing Signer Check — **false positive if flagged**; residual is oracle/keeper trust, not absent signer validation.

---

## Clean patterns

| # | Pattern | Result |
|---|---------|--------|
| 1 | **Arbitrary CPI** | **Clean.** All CPIs use typed `Program<'info, Token>`, `Program<'info, System>`, and (mock path) `Program<'info, TxlineMock>`. No user-controlled program id in `invoke` / `invoke_signed` / `CpiContext` program account. Token transfers use `anchor_spl::token::transfer`. |
| 2 | **Improper PDA Validation** | **Clean.** Global, pool, vault, vault-auth, market, position, attestation, config, stat-root, and receipt (caller + `txline-mock`) use Anchor `seeds` + canonical `bump` / `bump = account.bump`. No instruction-arg bumps; no `create_program_address` without canonical bump. |
| 3 | **Missing Ownership Check** | **Clean.** State accounts use `Account<'info, T>` (owner + discriminator). SPL accounts use `Account<'info, TokenAccount>` / `Mint` with mint/owner constraints. Mock receipt uses post-CPI `require_keys_eq!(owner, txline_mock::ID)` then deserialize. `vault_authority` as `UncheckedAccount` is PDA-only (seeds enforced; no data ownership required). |
| 4 | **Missing Signer Check** | **Clean.** Admin (`authority`), oracles (`oracle`, `settlement_oracle`), bettors, LPs, and init payers are `Signer<'info>` with key equality checks against stored authorities where required. |
| 5 | **Sysvar Account Check** | **Clean.** Time uses `Clock::get()` (no spoofable account). `InitializePool` uses `Sysvar<'info, Rent>`; Anchor binds the Rent sysvar address. Runtime is `solana-program 1.18.26` (post-1.8.1). |
| 6 | **Improper Instruction Introspection** | **Clean.** No `load_instruction_at`, `load_instruction_at_checked`, or `load_current_index_checked` usage. |

---

## False positives / Anchor already validates

- **`bump = pool.bump` / `market.bump` / etc.** — Stored bumps written from `ctx.bumps.*` at `init`; Anchor re-derives PDA with that bump. Not user-supplied instruction bumps.
- **`vault_authority: UncheckedAccount` + seeds** — Intentional PDA signer; address validated by seeds constraint; used only as token authority in `invoke_signed`-style `CpiContext::new_with_signer`.
- **`real-txline` keeper trust** — Signer present; trust model is intentional (see INFO / F-004).
- **Token CPI program account** — `Program<'info, Token>` rejects arbitrary program ids.

---

## Related notes (outside the six patterns, for context)

- **Global / TxLINE config front-run:** `initialize_global` / `txline_mock::initialize` are permissionless one-shot inits (first signer becomes admin/authority). Operational deploy risk; documented in `SECURITY.md`.
- **`init-if-needed` on `Position` and `StatReceipt`:** Enabled via Cargo feature; positions are seed-bound to `(market, bettor)`; receipts are overwritten only by successful `validate_stat` and re-written in the same settle CPI.

---

## Summary

| Severity | Count |
|----------|------:|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 0 |
| LOW (open) | 0 |
| LOW (fixed) | 2 |
| INFO (by design) | 1 |

**Top issues:** Both LOW findings (mock-path receipt owner check; unconstrained `stat_root`/`receipt` on caller) are **fixed**. Residual: F-004 keeper trust on `real-txline` (INFO, by design).

**Clean:** Arbitrary CPI, signer checks, sysvars (`Clock::get` / Rent address binding on 1.18), instruction introspection, and PDA seeds/bumps on program-owned state accounts (including caller-side mock settlement accounts).
