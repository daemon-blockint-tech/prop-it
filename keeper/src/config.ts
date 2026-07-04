import "dotenv/config";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";

// ---------------------------------------------------------------
// Real TxLINE program addresses published by TxODDS.
// Ref: https://txline.txodds.com/documentation/programs/addresses
// ---------------------------------------------------------------
export const TXLINE_ADDRESSES = {
  "mainnet-beta": {
    programId:    new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
    txlMint:      new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
    usdtMint:     new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    apiOrigin:    "https://txline.txodds.com",
    apiBase:      "https://txline.txodds.com/api",
    guestAuthUrl: "https://txline.txodds.com/auth/guest/start",
  },
  devnet: {
    programId:    new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
    txlMint:      new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
    usdtMint:     new PublicKey("ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh"),
    apiOrigin:    "https://txline-dev.txodds.com",
    apiBase:      "https://txline-dev.txodds.com/api",
    guestAuthUrl: "https://txline-dev.txodds.com/auth/guest/start",
  },
} as const;

export type Cluster = keyof typeof TXLINE_ADDRESSES | "localnet";

function loadKeypair(p: string): Keypair {
  const raw = fs.readFileSync(p.replace("~", os.homedir()), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optionalPubkey(name: string, fallback?: string): PublicKey | null {
  const raw = process.env[name] ?? fallback;
  if (!raw) return null;
  try { return new PublicKey(raw); }
  catch (e) { throw new Error(`Env ${name}='${raw}' is not a valid Solana pubkey: ${e}`); }
}

const cluster = (process.env.CLUSTER ?? "localnet") as Cluster;
const txlineCluster = cluster === "localnet" ? "devnet" : cluster;
const txlineDefaults = TXLINE_ADDRESSES[txlineCluster];

// TabulaMarkets program id — must be set once you deploy. On localnet the
// declare_id! placeholder is fine; on devnet/mainnet you MUST override.
const tabulaProgramId = optionalPubkey(
  "TABULA_PROGRAM_ID",
  "573udr4SsUoFYV5H9o9Mj3wWrhPyT4K8YVRkXsdyWyjH",
)!;

// TxLINE program id — defaults to the canonical devnet/mainnet address
// published by TxODDS. On localnet the txline-mock declared_id is used.
const txlineProgramId = optionalPubkey(
  "TXLINE_PROGRAM_ID",
  cluster === "localnet"
    ? "Bi9Q6ovkrnBHHauZctkTkQ9PoFj8xTpswNBGDCe9mW3t"
    : txlineDefaults.programId.toBase58(),
)!;

const usdcMintDefault = cluster === "mainnet-beta"
  ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  // devnet USDC faucet mint (Circle) — publicly documented placeholder
  : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const cfg = {
  cluster,
  txlineCluster,

  rpcUrl: process.env.RPC_URL ?? (
    cluster === "localnet"     ? "http://127.0.0.1:8899" :
    cluster === "devnet"       ? "https://api.devnet.solana.com" :
                                 "https://api.mainnet-beta.solana.com"
  ),
  oracleUrl: process.env.ORACLE_URL ?? "http://127.0.0.1:8787",

  // TxLINE REST/SSE
  txlineApiBase:    process.env.TXLINE_API_BASE    ?? txlineDefaults.apiBase,
  txlineGuestAuth:  process.env.TXLINE_GUEST_AUTH  ?? txlineDefaults.guestAuthUrl,
  txlineWalletName: process.env.TXLINE_WALLET_NAME ?? "TabulaKeeper",

  // Local WebSocket emulator (localnet only)
  txlineWsUrl: process.env.TXLINE_WS_URL ?? "ws://127.0.0.1:9001/feed",

  // Wallets. NEVER commit these files.
  keeperWalletPath: process.env.KEEPER_WALLET ?? "~/.config/solana/id.json",

  // Program IDs.
  tabulaProgramId,
  txlineProgramId,
  txlTokenMint:  txlineDefaults.txlMint,
  usdtMint:      txlineDefaults.usdtMint,
  usdcMint:      new PublicKey(process.env.USDC_MINT ?? usdcMintDefault),

  // Runtime knobs.
  updateIntervalMs:     Number(process.env.UPDATE_INTERVAL_MS     ?? 3_000),
  divergenceThreshold:  Number(process.env.DIVERGENCE_THRESHOLD   ?? 0.02),

  // Prometheus / health server.
  metricsPort:  Number(process.env.METRICS_PORT ?? 9464),

  // Enable structured JSON logging (production).
  jsonLogs: (process.env.JSON_LOGS ?? "0") === "1",
} as const;

export function connection(): Connection {
  return new Connection(cfg.rpcUrl, "confirmed");
}
export function keeperKeypair(): Keypair {
  return loadKeypair(cfg.keeperWalletPath);
}
// Defer requireEnv until secrets are actually needed. This lets tests and
// dry-run modes bootstrap without leaking placeholders.
export function requireSecret(name: string): string {
  return requireEnv(name);
}
