/**
 * Anchor integration tests for TabulaMarkets.
 *
 * Run against a local validator:
 *   solana-test-validator --reset
 *   anchor build && anchor deploy
 *   anchor test --skip-local-validator
 *
 * The full lifecycle is:
 *   initialize_pool → deposit_liquidity → create_market
 *     → update_prediction → place_bet
 *     → publish_stat_root (txline-mock) → settle_via_txline
 *     → claim_winnings
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { expect } from "chai";

// Utilities -----------------------------------------------------------

function utf8Bytes(s: string, len: number): Buffer {
  const b = Buffer.alloc(len);
  Buffer.from(s, "utf8").copy(b, 0);
  return b;
}

function hashLeaf(statType: Buffer, statValue: BN): Buffer {
  const v = Buffer.alloc(8);
  v.writeBigUInt64LE(BigInt(statValue.toString()), 0);
  return Buffer.from(keccak_256(Buffer.concat([statType, v])));
}

function sortPair(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0
    ? Buffer.concat([a, b])
    : Buffer.concat([b, a]);
}

describe("tabula-markets", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const tabula  = anchor.workspace.tabulaMarkets as Program<any>;
  const txline  = anchor.workspace.txlineMock    as Program<any>;

  const authority = (provider.wallet as anchor.Wallet).payer;
  const bettor    = Keypair.generate();
  // Prediction oracle and settlement oracle. In production these are
  // different keys held by the keeper bot; for the mock test we reuse
  // `authority` as both to keep the fixture small.
  const oracleKey = authority;
  const keeperKey = authority;
  let usdcMint: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultAuth: PublicKey;
  let marketPda: PublicKey;
  const matchId  = Buffer.alloc(32); matchId.write("wc-r16-arg-fra");
  const statType = utf8Bytes("corners_h2", 16);
  const binEdges = [new BN(0), new BN(3), new BN(6), new BN(9), new BN(999)];
  const initialProbs = [new BN(120_000), new BN(480_000), new BN(300_000), new BN(100_000)];

  it("initializes pool + market lifecycle", async () => {
    // 1. USDC-like mint
    usdcMint = await createMint(provider.connection, authority, authority.publicKey, null, 6);

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), usdcMint.toBuffer()], tabula.programId);
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()], tabula.programId);
    [vaultAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault-auth"), poolPda.toBuffer()], tabula.programId);

    // v0.2 signature: initialize_pool(oracle_authority, settlement_oracle)
    await tabula.methods.initializePool(oracleKey.publicKey, keeperKey.publicKey)
      .accounts({
        authority: authority.publicKey,
        pool: poolPda,
        usdcMint,
        vault: vaultPda,
        vaultAuthority: vaultAuth,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // 2. Fund an LP and deposit liquidity
    const lpAta = await createAssociatedTokenAccount(
      provider.connection, authority, usdcMint, authority.publicKey);
    await mintTo(provider.connection, authority, usdcMint, lpAta, authority, 10_000_000_000);

    await tabula.methods.depositLiquidity(new BN(5_000_000_000))
      .accounts({
        lp: authority.publicKey, pool: poolPda,
        lpTokenAccount: lpAta, vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    // 3. Create market
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), matchId], tabula.programId);
    await tabula.methods.createMarket(
        Array.from(matchId), Array.from(statType), 4,
        binEdges, initialProbs, new BN(5_000_000))
      .accounts({
        creator: authority.publicKey,
        pool: poolPda, market: marketPda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const mkt = await tabula.account.market.fetch(marketPda);
    expect(mkt.outcomeCount).to.equal(4);
    expect(mkt.probs[1].toNumber()).to.equal(480_000);
  });

  it("settles via TxLINE CPI", async () => {
    // Build a 4-leaf Merkle tree over corners_h2 stats for the match.
    const leaves = [
      hashLeaf(statType, new BN(5)),
      hashLeaf(utf8Bytes("goals",     16), new BN(2)),
      hashLeaf(utf8Bytes("yellows",   16), new BN(3)),
      hashLeaf(utf8Bytes("shots_on",  16), new BN(11)),
    ];
    const l01 = keccak_256(sortPair(leaves[0], leaves[1]));
    const l23 = keccak_256(sortPair(leaves[2], leaves[3]));
    const root = keccak_256(sortPair(Buffer.from(l01), Buffer.from(l23)));

    const [statRootPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("stat-root"), matchId], txline.programId);

    await txline.methods.publishStatRoot(Array.from(matchId), Array.from(root))
      .accounts({
        authority: authority.publicKey,
        statRoot: statRootPda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), statRootPda.toBuffer(), matchId], txline.programId);

    const proof = [leaves[1], Buffer.from(l23)].map((b) => Array.from(b));

    await tabula.methods.settleViaTxlineMock(
        Array.from(statType), new BN(5), proof)
      .accounts({
        payer: authority.publicKey,
        pool: poolPda,
        market: marketPda,
        statRoot: statRootPda,
        receipt: receiptPda,
        txlineProgram: txline.programId,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const mkt = await tabula.account.market.fetch(marketPda);
    expect(mkt.status).to.equal(1); // Resolved
    expect(mkt.winningOutcome).to.equal(1); // 5 corners → bin [3, 6)
  });
});
