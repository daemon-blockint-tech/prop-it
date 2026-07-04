import "dotenv/config";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function loadKeypair(p: string): Keypair {
  const raw = fs.readFileSync(p.replace("~", os.homedir()), "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export const cfg = {
  rpcUrl:            process.env.RPC_URL            ?? "http://127.0.0.1:8899",
  oracleUrl:         process.env.ORACLE_URL         ?? "http://127.0.0.1:8787",
  txlineWsUrl:       process.env.TXLINE_WS_URL      ?? "ws://127.0.0.1:9001/feed",
  keeperWalletPath:  process.env.KEEPER_WALLET      ?? "~/.config/solana/id.json",
  tabulaProgramId:   new PublicKey(process.env.TABULA_PROGRAM_ID   ?? "TabuLA11111111111111111111111111111111111111"),
  txlineProgramId:   new PublicKey(process.env.TXLINE_PROGRAM_ID   ?? "TxLiNe11111111111111111111111111111111111111"),
  usdcMint:          new PublicKey(process.env.USDC_MINT           ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  updateIntervalMs:  Number(process.env.UPDATE_INTERVAL_MS         ?? 3_000),
  divergenceThreshold: Number(process.env.DIVERGENCE_THRESHOLD     ?? 0.02),
} as const;

export function connection(): Connection {
  return new Connection(cfg.rpcUrl, "confirmed");
}
export function keeperKeypair(): Keypair {
  return loadKeypair(cfg.keeperWalletPath);
}
