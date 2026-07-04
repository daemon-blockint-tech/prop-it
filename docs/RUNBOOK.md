# Operational Runbook

Quick-reference for the on-call engineer. Every section is scoped to one
symptom → root causes → immediate mitigations → follow-up actions.

## 0. Emergency Contacts

- **On-call:** protocoldaemon@gmail.com (Daemon Protocol)
- **Solana explorer (devnet):** https://explorer.solana.com/?cluster=devnet
- **TxLINE status:** https://txline.txodds.com (check landing page)

## 1. Kill Switch

If ANY suspicious activity is observed:

```bash
anchor run set-paused -- --paused true
```

This blocks `deposit_liquidity`, `place_bet`, `settle_via_txline`, and
`claim_winnings`. Existing positions are preserved; nothing is destroyed.

Recovery:

```bash
anchor run set-paused -- --paused false
```

## 2. Symptom: Oracle backend flipped to "mock" in prod

**Detection:** `tabula_oracle_backend_up{backend="mock"} == 1` while the
deployment expects `tabfm-pytorch`.

**Likely causes:**
1. HuggingFace Hub outage — model download failed.
2. Torch/CUDA missing after image rebuild.
3. OOM during `TabFMClassifier.ensemble(...)`.

**Fix:**
```bash
# Confirm cause in the container logs
docker logs tabula-oracle-1 | grep -iE "tabfm|torch|cuda|oom" | tail -20

# Retry HF download with an authenticated token if rate-limited
docker exec -it tabula-oracle-1 huggingface-cli login

# If OOM — reduce ensemble size
export TABULA_ENSEMBLE_SIZE=8
docker compose up -d oracle
```

## 3. Symptom: Keeper stops submitting `update_prediction`

**Detection:** `rate(tabula_predictions_sent_total[10m]) == 0` while
`rate(tabula_oracle_calls_total[10m]) > 0`.

**Likely causes:**
1. `divergenceThreshold` too high — real drift never crosses it.
2. RPC provider throttling.
3. Keeper wallet out of SOL.

**Fix:**
```bash
# Check balance
solana balance -k ~/.config/solana/keeper.json --url devnet

# Airdrop 1 SOL on devnet
solana airdrop 1 -k ~/.config/solana/keeper.json --url devnet

# Lower the threshold temporarily
DIVERGENCE_THRESHOLD=0.005 docker compose up -d keeper
```

## 4. Symptom: `settle_via_txline` reverts with `AttestationExpired`

**Detection:** Keeper logs `AttestationExpired (0x1810)`.

**Cause:** `MAX_RECEIPT_AGE_SEC = 900s`. The attestation account was
posted more than 15 min before the settle instruction landed.

**Fix:** Re-run the settlement pipeline. The keeper will fetch fresh
proofs from TxLINE, call `validateStat.view()`, post a new
`TxLineAttestation`, then invoke `settle_via_txline` — all within the
15-min window.

## 5. Symptom: `settle_via_txline` reverts with `StatValueOutOfBins`

**Cause:** The final stat value from TxLINE fell below `bin_edges[0]` or
at/above `bin_edges[outcome_count]`.

**Fix:**
1. Confirm the observed value on the TxLINE snapshot endpoint.
2. If the market's `bin_edges` were mis-specified at creation, the market
   is un-settleable and must be **cancelled**. `cancel_market` is not yet
   implemented — plan the emergency-cancel instruction from `SECURITY.md`
   before mainnet.

## 6. Symptom: TabFM predictions look degenerate (all mass on one bin)

**Detection:** `tabula_ensemble_divergence < 0.01` for many consecutive
ticks.

**Likely causes:**
1. `history` payload contains constant `outcome_bin` — TabFM overfit.
2. Live features are all zeros (feed lag).

**Fix:**
```bash
# Verify keeper sees non-trivial ticks
curl -s http://localhost:9464/metrics | grep tabula_txline_fetch_total

# Inspect a real oracle payload
curl -s -X POST http://localhost:8787/predict -H "content-type: application/json" \
  -d @/tmp/latest-request.json | jq
```

If the history is clearly broken, pause the pool, regenerate the training
history, and resume.

## 7. Symptom: Suspected keeper key compromise

1. `anchor run set-paused -- --paused true`
2. Generate a new keypair, transfer SOL, register it as the new
   `settlement_oracle`:
   ```bash
   solana-keygen new -o ~/.config/solana/keeper-new.json
   anchor run rotate-oracle -- \
     --prediction=$(solana address -k ~/.config/solana/oracle.json) \
     --settlement=$(solana address -k ~/.config/solana/keeper-new.json)
   ```
3. `KEEPER_WALLET=~/.config/solana/keeper-new.json docker compose up -d keeper`
4. `anchor run set-paused -- --paused false`
5. File an incident report, rotate the leaked key's `X-Api-Token` at
   TxLINE (`POST /api/token/revoke`).

## 8. Symptom: TxLINE guest JWT expired

**Detection:** `401 Unauthorized` on TxLINE calls.

**Fix:** The keeper caches its JWT with a 30-day expiry. Restart the
container to re-run `startGuestSession`, or force refresh by clearing the
in-memory cache (the client refreshes on first `startGuestSession`).

```bash
docker compose restart keeper
```

## 9. Backups

- Solana state is on-chain; no local backup required.
- `Anchor.toml`, `keeper/.env`, and the `target/idl/*.json` are the
  authoritative deploy manifest. Commit `Anchor.toml` and the IDLs to
  git; **never** commit `keeper/.env`.
- Wallet files live under `~/.config/solana/`. Back these up **encrypted
  and offline** (e.g. Age or Password Manager Recovery). Losing them
  means losing pool `authority`.

## 10. Chaos Drills (quarterly)

1. Kill the oracle container mid-match — keeper should log
   `oracle.call.fail`, no on-chain effect. Restart, verify recovery.
2. Kill the keeper container mid-match — restart, verify no duplicate
   `update_prediction` from the resurrected process.
3. Point the keeper at a stale RPC — confirm `tabula_txline_errors_total`
   climbs and Prometheus alerts fire.
4. Trigger `set_paused(true)` from a wrong signer — expect
   `AdminUnauthorized`.
