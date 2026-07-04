# Deployment Guide

This guide walks through deploying TabulaMarkets to Solana devnet, wired
against the real TxLINE `txoracle` program published by TxODDS.

## Prerequisites

- Solana CLI ≥ 1.18.26 (`solana --version`)
- Anchor CLI 0.30.1 (`anchor --version`)
- Rust 1.79 stable
- Node 20 + npm
- Python 3.11 + pip
- Docker 24+ (optional, for reproducible builds)
- A funded devnet keypair (`solana-keygen new -o ~/.config/solana/deployer.json`)
- A funded devnet keypair for the keeper (`~/.config/solana/keeper.json`)

## 0. Fund the wallets

```bash
solana config set --url https://api.devnet.solana.com
solana airdrop 5 ~/.config/solana/deployer.json
solana airdrop 5 ~/.config/solana/keeper.json
```

## 1. Build & deploy the Anchor program

Two Cargo features gate the settlement backend:

| Feature      | When to use                                        |
|--------------|----------------------------------------------------|
| `mock-txline` (default) | Local validator, integration tests, hackathon demo |
| `real-txline`           | Devnet / mainnet against `9ExbZjA…` (mainnet) or `6pW64…` (devnet) |

### 1a. Mock backend (recommended first)

```bash
anchor build
anchor deploy --provider.cluster devnet \
  --provider.wallet ~/.config/solana/deployer.json
```

Grab the new program ID from `target/idl/tabula_markets.json` and update
both `Anchor.toml` and `keeper/.env` (`TABULA_PROGRAM_ID=…`).

### 1b. Real backend

```bash
cd programs/tabula-markets
anchor build -- --no-default-features --features real-txline
anchor deploy --provider.cluster devnet
```

Point the keeper at the deployed program **and** the real TxODDS devnet
program:

```
TABULA_PROGRAM_ID=<your new tabula pubkey>
TXLINE_PROGRAM_ID=6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J
CLUSTER=devnet
```

## 2. Initialise the pool

```bash
anchor run initialize \
  --provider.cluster devnet \
  --provider.wallet ~/.config/solana/deployer.json \
  -- --oracle=$(solana address -k ~/.config/solana/oracle.json) \
     --settlement-oracle=$(solana address -k ~/.config/solana/keeper.json) \
     --usdc-mint=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

## 3. Boot the oracle + keeper

### Docker (reproducible)

```bash
cp keeper/.env.example keeper/.env      # fill in the real values
docker compose up --build
```

The oracle will be at `http://localhost:8787` and the keeper's
Prometheus endpoint at `http://localhost:9464/metrics`.

### Bare metal

```bash
# oracle
cd oracle
pip install ".[dev,tabfm]"        # or leave [tabfm] off + set TABULA_ORACLE_MOCK=1
tabula-oracle                     # listens on :8787

# keeper
cd ../keeper
npm install
npm run build
JSON_LOGS=1 CLUSTER=devnet node dist/index.js
```

## 4. Wire TxLINE for real settlement

### 4a. Free tier (World Cup / International friendlies)

Nothing to do — the keeper hits `POST /auth/guest/start`, receives a JWT,
and can consume Service Level 1 or 12 directly.

### 4b. Paid subscription

1. Call the TxLINE `txoracle.subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)`
   instruction from the keeper wallet, paying TxL. `DURATION_WEEKS` must
   be a multiple of 4.
2. Grab the confirmed `txSignature`.
3. Sign the signature bytes with the wallet's ed25519 key.
4. Call `POST /api/token/activate` with `{ txSig, walletSignature, leagues }`.
5. The returned `apiToken` goes into the `X-Api-Token` header on every
   subsequent REST call.

The keeper's `TxLineClient.activateApiToken(...)` implements this exchange.

## 5. Post-deploy verification

```bash
# Solana side
solana account $TABULA_PROGRAM_ID
solana account $POOL_PDA      # verify pool.authority = deployer

# Oracle side
curl -s http://localhost:8787/healthz
curl -s http://localhost:8787/model | jq

# Keeper side
curl -s http://localhost:9464/healthz
curl -s http://localhost:9464/metrics | grep tabula_
```

## 6. Rollback

If you need to freeze the system:

```bash
anchor run set-paused -- --paused true
```

`set_paused(true)` blocks every state-mutating instruction. To resume,
call the same instruction with `--paused false`. Rotating the oracle keys
after a suspected compromise:

```bash
anchor run rotate-oracle \
  -- --prediction=<new-pred-oracle> --settlement=<new-settlement-oracle>
```

## 7. Monitoring

Point Prometheus at both services:

```yaml
scrape_configs:
  - job_name: tabula-oracle
    static_configs: [{ targets: ["oracle:8787"] }]
    metrics_path: /metrics
  - job_name: tabula-keeper
    static_configs: [{ targets: ["keeper:9464"] }]
    metrics_path: /metrics
```

Alert on:

- `rate(tabula_oracle_predict_total{status!="ok"}[5m]) > 0.1`
- `rate(tabula_txline_errors_total[5m]) > 0.05`
- `absent(tabula_last_prediction_ms) or (time() - tabula_last_prediction_ms/1000) > 60`
- `tabula_ensemble_divergence > 0.3` (severe TabFM disagreement → consider pausing)
