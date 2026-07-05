/**
 * tabulaClient
 * ------------
 * Real on-chain client for the `tabula_markets` program. Builds and submits
 * the instructions the keeper is responsible for:
 *
 *   - update_prediction        (oracle_authority signs)
 *   - post_tx_line_attestation (settlement_oracle signs)
 *   - settle_via_tx_line_real  (settlement_oracle signs)
 *
 * Instructions are assembled by hand (Anchor 8-byte discriminator +
 * Borsh-encoded args) so the keeper does not depend on a checked-in IDL
 * artifact staying in lockstep with the program. Account orders and
 * writability mirror the `#[derive(Accounts)]` structs in
 * `programs/tabula-markets/src/lib.rs` exactly.
 *
 * The keeper wallet must be registered on-chain as BOTH the pool's
 * `oracle_authority` and `settlement_oracle` (see initialize_pool /
 * rotate_oracle). If prediction and settlement duties are split across two
 * keys in your deployment, pass a separate settlement signer to the
 * settlement calls.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

const SYSTEM_PROGRAM_ID = SystemProgram.programId;

// ------------------------------------------------------------------
// Encoding primitives
// ------------------------------------------------------------------

/** Anchor instruction discriminator: first 8 bytes of sha256("global:<name>"). */
function discriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

/** Encode an ASCII/utf8 string into a fixed-width, zero-padded byte array. */
export function encodeFixedBytes(s: string, len: number): Buffer {
  const b = Buffer.alloc(len);
  const src = Buffer.from(s, "utf8");
  if (src.length > len) {
    throw new Error(`value "${s}" does not fit in ${len} bytes`);
  }
  src.copy(b, 0);
  return b;
}

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}
/** Borsh Vec<u64>: 4-byte LE length prefix then each element LE. */
function vecU64(values: Array<bigint | number>): Buffer {
  return Buffer.concat([u32le(values.length), ...values.map((v) => u64le(v))]);
}

// ------------------------------------------------------------------
// Client
// ------------------------------------------------------------------

export interface TabulaClientOpts {
  connection: Connection;
  programId: PublicKey;
  usdcMint: PublicKey;
  /** Keeper wallet — must equal the pool's oracle_authority + settlement_oracle. */
  wallet: Keypair;
}

export class TabulaClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly usdcMint: PublicKey;
  readonly wallet: Keypair;
  readonly poolPda: PublicKey;

  constructor(opts: TabulaClientOpts) {
    this.connection = opts.connection;
    this.programId = opts.programId;
    this.usdcMint = opts.usdcMint;
    this.wallet = opts.wallet;
    [this.poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), this.usdcMint.toBuffer()],
      this.programId,
    );
  }

  // ---- PDA derivation -------------------------------------------------

  marketPda(matchId: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), this.poolPda.toBuffer(), matchId],
      this.programId,
    );
    return pda;
  }

  attestationPda(marketPda: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("attestation"), this.poolPda.toBuffer(), marketPda.toBuffer()],
      this.programId,
    );
    return pda;
  }

  // ---- Instructions ---------------------------------------------------

  /**
   * update_prediction(new_probs: Vec<u64>, new_b: u64)
   * Accounts: oracle(signer) · pool · market(mut)
   */
  updatePredictionIx(matchId: Buffer, newProbsQ6: number[], newB: number): TransactionInstruction {
    const market = this.marketPda(matchId);
    const data = Buffer.concat([
      discriminator("update_prediction"),
      vecU64(newProbsQ6.map((p) => BigInt(Math.round(p)))),
      u64le(Math.round(newB)),
    ]);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false }, // oracle
        { pubkey: this.poolPda, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
      ],
      data,
    });
  }

  /**
   * post_tx_line_attestation(match_id, stat_type, stat_value, fixture_id, seq, stat_key)
   * Accounts: payer(mut,signer) · settlement_oracle(signer) · pool · market · attestation(mut) · system
   */
  postAttestationIx(params: {
    matchId: Buffer;
    statType: Buffer;
    statValue: number | bigint;
    txoddsFixtureId: number | bigint;
    txoddsSeq: number;
    txoddsStatKey: number;
  }): TransactionInstruction {
    const market = this.marketPda(params.matchId);
    const attestation = this.attestationPda(market);
    const data = Buffer.concat([
      discriminator("post_tx_line_attestation"),
      params.matchId,
      params.statType,
      u64le(params.statValue),
      u64le(params.txoddsFixtureId),
      u32le(params.txoddsSeq),
      u16le(params.txoddsStatKey),
    ]);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true }, // payer
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false }, // settlement_oracle
        { pubkey: this.poolPda, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: false },
        { pubkey: attestation, isSigner: false, isWritable: true },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * settle_via_tx_line_real(stat_value, fixture_id, seq, stat_key)
   * Accounts: payer(mut,signer) · settlement_oracle(signer) · pool · market(mut) · attestation(mut)
   */
  settleRealIx(params: {
    matchId: Buffer;
    statValue: number | bigint;
    txoddsFixtureId: number | bigint;
    txoddsSeq: number;
    txoddsStatKey: number;
  }): TransactionInstruction {
    const market = this.marketPda(params.matchId);
    const attestation = this.attestationPda(market);
    const data = Buffer.concat([
      discriminator("settle_via_tx_line_real"),
      u64le(params.statValue),
      u64le(params.txoddsFixtureId),
      u32le(params.txoddsSeq),
      u16le(params.txoddsStatKey),
    ]);
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true }, // payer
        { pubkey: this.wallet.publicKey, isSigner: true, isWritable: false }, // settlement_oracle
        { pubkey: this.poolPda, isSigner: false, isWritable: false },
        { pubkey: market, isSigner: false, isWritable: true },
        { pubkey: attestation, isSigner: false, isWritable: true },
      ],
      data,
    });
  }

  // ---- Send helpers ---------------------------------------------------

  private async send(ixs: TransactionInstruction[]): Promise<string> {
    const tx = new Transaction().add(...ixs);
    return sendAndConfirmTransaction(this.connection, tx, [this.wallet], {
      commitment: "confirmed",
      skipPreflight: false,
    });
  }

  /** Submit a fresh ensemble prediction to the market. Returns the tx signature. */
  async submitUpdatePrediction(matchId: Buffer, newProbsQ6: number[], newB: number): Promise<string> {
    return this.send([this.updatePredictionIx(matchId, newProbsQ6, newB)]);
  }

  /**
   * Post the keeper-signed TxLINE attestation and settle the market in one
   * atomic transaction. Returns the tx signature.
   */
  async settleWithAttestation(params: {
    matchId: Buffer;
    statType: Buffer;
    statValue: number | bigint;
    txoddsFixtureId: number | bigint;
    txoddsSeq: number;
    txoddsStatKey: number;
  }): Promise<string> {
    return this.send([this.postAttestationIx(params), this.settleRealIx(params)]);
  }
}
