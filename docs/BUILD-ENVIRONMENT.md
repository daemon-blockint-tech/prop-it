# Build Environment (Anchor 0.30.1 + Solana 1.18.26)

Catatan hasil investigasi build di sandbox — dipakai untuk resume `anchor build` di
mesin lokal (macOS/Linux) tanpa mengulang trial-and-error.

## Toolchain versions

| Komponen        | Versi         | Catatan                                                       |
| --------------- | ------------- | ------------------------------------------------------------- |
| rustc (host)    | `1.85.0`      | Untuk `cargo test` host. Boleh lebih baru.                    |
| solana-cli      | `1.18.26`     | `cargo-build-sbf` menembak platform-tools v1.41 (Rust 1.75).  |
| anchor-cli      | `0.30.1`      | Install via `avm install 0.30.1 && avm use 0.30.1`.           |
| node            | `>= 18`       | Untuk `yarn`/`ts-mocha` test harness.                         |

**Catatan penting**: `cargo-build-sbf` Solana 1.18.26 menggunakan Rust 1.75 internal
yang **belum stabilize `edition2024`**. Banyak transitive dep terbaru (blake3 1.8,
zeroize_derive 1.5, indexmap 2.14, toml_datetime 1.1, wit-bindgen 0.57) sudah
migrasi ke edition2024, jadi resolve otomatis akan gagal.

Ada dua jalur:

### Jalur A — Pinning transitives (compatible dengan Solana 1.18.26)

Setelah `anchor build` pertama gagal, jalankan cargo update precise berikut untuk
memaksa versi transitives yang masih kompat dengan cargo 1.75:

```bash
cargo update -p blake3 --precise 1.5.5
cargo update -p jobserver --precise 0.1.32
cargo update -p proc-macro-crate@3.5.0 --precise 3.2.0
cargo update -p zeroize_derive --precise 1.4.2
cargo update -p indexmap --precise 2.7.1        # sebelum 2.14 (butuh edition2024)
# ... ulangi untuk setiap crate baru yang error dengan pesan `edition2024`
```

Kemudian pastikan `Cargo.lock` version = 3 (bukan 4):

```bash
sed -i.bak 's/^version = 4$/version = 3/' Cargo.lock
```

Ini reliable tapi memakan waktu karena banyak crate yang perlu di-pin.

### Jalur B — Upgrade Solana ke Agave 2.1+ (recommended)

Agave 2.1+ mem-bundle platform-tools terbaru dengan Rust modern yang mendukung
edition2024 native:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
solana --version   # solana-cli 2.1.0
```

Perhatian: Anchor 0.30.1 masih support Solana 2.x untuk build. Untuk deploy ke
devnet, gunakan `solana program deploy` seperti biasa.

Update `Anchor.toml`:

```toml
[toolchain]
anchor_version = "0.30.1"
solana_version = "2.1.0"
```

## Program keypairs

Program IDs sudah ditanam di `declare_id!` dan `Anchor.toml`:

| Program          | Pubkey                                          |
| ---------------- | ----------------------------------------------- |
| `tabula_markets` | `Fd6fiHspckMKwwSDPkJHmnp69sQewApDVd7kQc4zUboR`  |
| `txline_mock`    | `Cx7NL2thRV167d1PaMUgiARvTwLua34KQ7S5qkTBH4oE`  |

Keypair files **tidak di-commit** (ada di `.gitignore`). Regenerate lokal:

```bash
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase --outfile target/deploy/tabula_markets-keypair.json --force
solana-keygen new --no-bip39-passphrase --outfile target/deploy/txline_mock-keypair.json --force
```

Setelah generate, **update `declare_id!` dan `Anchor.toml` dengan pubkey baru**,
karena keypair yang ada di dokumen ini adalah kunci publik dari keypair yang
di-generate di sandbox — bukan yang seharusnya dipakai untuk deploy produksi.

Untuk deployment yang deterministic (mempertahankan pubkey lintas rebuild),
simpan keypair `target/deploy/*-keypair.json` di secret manager (bukan git) dan
restore sebelum `anchor deploy`.

## Deploy ke devnet

```bash
solana config set --url devnet
solana-keygen new --outfile ~/.config/solana/id.json  # jika belum ada
solana airdrop 5

anchor build
anchor deploy --provider.cluster devnet

# Verify
solana program show <TABULA_PROGRAM_ID> --url devnet
```

Lalu update `keeper/.env`:

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
TABULA_PROGRAM_ID=<hasil anchor deploy>
TXLINE_PROGRAM_ID=6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J  # TxLINE devnet
TXL_MINT=4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG           # TxL devnet
TXLINE_API_BASE=https://txline-dev.txodds.com/api
```

## Smoke test setelah deploy

```bash
# 1. Initialize pool
yarn ts-node scripts/initialize-pool.ts --cluster devnet

# 2. Create market (dari keeper atau CLI)
yarn ts-node scripts/create-market.ts --event-id <TXLINE_EVENT_ID>

# 3. LP deposit
yarn ts-node scripts/lp-deposit.ts --amount 1000

# 4. Place bet
yarn ts-node scripts/place-bet.ts --outcome 0 --amount 10

# 5. Attest (keeper)
docker compose up keeper  # atau: yarn ts-node keeper/src/index.ts

# 6. Settle & claim
yarn ts-node scripts/settle.ts --market <MARKET_PDA>
yarn ts-node scripts/claim.ts --market <MARKET_PDA>
```

Note: script files (`initialize-pool.ts`, dll) belum dibuat — perlu ditambahkan
sebagai bagian dari smoke-test tooling.
