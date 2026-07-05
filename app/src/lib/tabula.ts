/**
 * tabula (frontend on-chain client)
 * ---------------------------------
 * Real client for the `tabula_markets` program used by the browser UI to
 * place bets and read settlement state. Instructions are assembled by hand
 * (Anchor 8-byte discriminator + Borsh args) and account orders mirror the
 * `#[derive(Accounts)]` structs in `programs/tabula-markets/src/lib.rs`.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";

// ------------------------------------------------------------------
// Network configuration (public, safe to expose)
// ------------------------------------------------------------------
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_TABULA_PROGRAM_ID ??
    "GZ6F2Q5DWQopyxcyTQk7Jko58Fc9jPdEdGdfiSZS7Z9T",
);

export const USDC_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_USDC_MINT ??
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet USDC faucet mint
);

// ------------------------------------------------------------------
// Encoding primitives
// ------------------------------------------------------------------
function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Anchor discriminator: first 8 bytes of sha256("global:<name>"). */
function discriminator(ixName: string): Uint8Array {
  return sha256(`global:${ixName}`).subarray(0, 8);
}

/** Fixed-width, zero-padded byte array (matches on-chain [u8; len]). */
export function encodeFixedBytes(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const src = textToBytes(s);
  if (src.length > len) throw new Error(`value "${s}" exceeds ${len} bytes`);
  out.set(src.subarray(0, len), 0);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Buffer {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = Buffer.alloc(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u8(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff);
}
function u64le(n: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

// ------------------------------------------------------------------
// PDA derivation
// ------------------------------------------------------------------
export function poolPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textToBytes("pool"), USDC_MINT.toBytes()],
    PROGRAM_ID,
  )[0];
}

export function marketPda(matchId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textToBytes("market"), poolPda().toBytes(), matchId],
    PROGRAM_ID,
  )[0];
}

export function positionPda(market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textToBytes("position"), market.toBytes(), bettor.toBytes()],
    PROGRAM_ID,
  )[0];
}

export function vaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textToBytes("vault"), poolPda().toBytes()],
    PROGRAM_ID,
  )[0];
}

export function attestationPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [textToBytes("attestation"), poolPda().toBytes(), market.toBytes()],
    PROGRAM_ID,
  )[0];
}

// ------------------------------------------------------------------
// Instructions
// ------------------------------------------------------------------

/**
 * place_bet(outcome_idx: u8, usdc_amount: u64)
 * Accounts: bettor(mut,signer) · pool(mut) · market(mut) · position(mut) ·
 *           bettor_token_account(mut) · vault(mut) · token · system
 */
export function placeBetIx(params: {
  bettor: PublicKey;
  matchId: Uint8Array;
  outcomeIdx: number;
  usdcAmount: bigint;
}): TransactionInstruction {
  const pool = poolPda();
  const market = marketPda(params.matchId);
  const position = positionPda(market, params.bettor);
  const vault = vaultPda();
  const bettorAta = getAssociatedTokenAddressSync(USDC_MINT, params.bettor);

  const data = concatBytes(
    discriminator("place_bet"),
    u8(params.outcomeIdx),
    u64le(params.usdcAmount),
  );

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: params.bettor, isSigner: true, isWritable: true },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: bettorAta, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// Re-exported so callers can pre-create the bettor's USDC ATA if needed.
export { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID };

// ------------------------------------------------------------------
// Account readers (real on-chain state, no mock data)
// ------------------------------------------------------------------
const MARKET_STATUS = ["Trading", "Resolved", "Cancelled"] as const;

export interface MarketState {
  status: (typeof MARKET_STATUS)[number] | "Unknown";
  outcomeCount: number;
  winningOutcome: number | null; // null while unresolved (u8::MAX on-chain)
}

export interface AttestationState {
  statValue: bigint;
  txoddsFixtureId: bigint;
  txoddsSeq: number;
  txoddsStatKey: number;
  settlementOracle: PublicKey;
  attestedAt: bigint;
  used: boolean;
}

class Reader {
  constructor(private buf: Uint8Array, public offset = 0) {}
  private dv() {
    return new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }
  skip(n: number) {
    this.offset += n;
    return this;
  }
  u8(): number {
    return this.buf[this.offset++];
  }
  u16(): number {
    const v = this.dv().getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.dv().getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    const v = this.dv().getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    const v = this.dv().getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }
  bool(): boolean {
    return this.buf[this.offset++] !== 0;
  }
  pubkey(): PublicKey {
    const pk = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  }
}

/** Read the on-chain Market account. Returns null if it does not exist. */
export async function readMarket(
  connection: Connection,
  matchId: Uint8Array,
): Promise<MarketState | null> {
  const info = await connection.getAccountInfo(marketPda(matchId));
  if (!info) return null;
  const r = new Reader(info.data);
  // discriminator(8) · pool(32) · match_id(32) · stat_type(16)
  r.skip(8 + 32 + 32 + 16);
  const outcomeCount = r.u8();
  // bin_edges [u64;11] · probs [u64;10] · q [i64;10] · liquidity_b u64
  r.skip(11 * 8 + 10 * 8 + 10 * 8 + 8);
  const statusByte = r.u8();
  const winningByte = r.u8();
  return {
    status: MARKET_STATUS[statusByte] ?? "Unknown",
    outcomeCount,
    winningOutcome: winningByte === 0xff ? null : winningByte,
  };
}

/** Read the on-chain TxLineAttestation account. Returns null if not posted. */
export async function readAttestation(
  connection: Connection,
  matchId: Uint8Array,
): Promise<AttestationState | null> {
  const market = marketPda(matchId);
  const info = await connection.getAccountInfo(attestationPda(market));
  if (!info) return null;
  const r = new Reader(info.data);
  // discriminator(8) · match_id(32) · stat_type(16)
  r.skip(8 + 32 + 16);
  const statValue = r.u64();
  const txoddsFixtureId = r.u64();
  const txoddsSeq = r.u32();
  const txoddsStatKey = r.u16();
  const settlementOracle = r.pubkey();
  const attestedAt = r.i64();
  const used = r.bool();
  return { statValue, txoddsFixtureId, txoddsSeq, txoddsStatKey, settlementOracle, attestedAt, used };
}
