/**
 * Anchor integration tests for TabulaMarkets.
 *
 * Run against a local validator:
 *   solana-test-validator --reset
 *   NO_DNA=1 anchor build && anchor deploy
 *   NO_DNA=1 anchor test --skip-local-validator
 *
 * The full lifecycle is:
 *   initialize_global → initialize_pool → deposit_liquidity → create_market
 *     → update_prediction → place_bet
 *     → txline.initialize → publish_stat_root → settle_via_txline
 *     → claim_winnings
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash } from "crypto";
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
  let globalPda: PublicKey;
  let poolPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultAuth: PublicKey;
  let marketPda: PublicKey;
  let txlineConfigPda: PublicKey;
  let lpAta: PublicKey;
  const matchId  = Buffer.alloc(32); matchId.write("wc-r16-arg-fra");
  const statType = utf8Bytes("corners_h2", 16);
  // All probs >= MIN_PROB (1_000); sum = Q_SCALE.
  const binEdges = [new BN(0), new BN(3), new BN(6), new BN(9), new BN(999)];
  const initialProbs = [new BN(120_000), new BN(480_000), new BN(300_000), new BN(100_000)];

  it("initializes pool + market lifecycle", async () => {
    // 0. Global config (admin gate for pool creation)
    [globalPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global")], tabula.programId);

    await tabula.methods.initializeGlobal()
      .accounts({
        admin: authority.publicKey,
        globalConfig: globalPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // 1. USDC-like mint
    usdcMint = await createMint(provider.connection, authority, authority.publicKey, null, 6);

    [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), usdcMint.toBuffer()], tabula.programId);
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), poolPda.toBuffer()], tabula.programId);
    [vaultAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault-auth"), poolPda.toBuffer()], tabula.programId);

    await tabula.methods.initializePool(oracleKey.publicKey, keeperKey.publicKey)
      .accounts({
        admin: authority.publicKey,
        globalConfig: globalPda,
        pool: poolPda,
        usdcMint,
        vault: vaultPda,
        vaultAuthority: vaultAuth,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // 2. Fund an LP and deposit liquidity
    lpAta = await createAssociatedTokenAccount(
      provider.connection, authority, usdcMint, authority.publicKey);
    await mintTo(provider.connection, authority, usdcMint, lpAta, authority, 10_000_000_000);

    await tabula.methods.depositLiquidity(new BN(5_000_000_000))
      .accounts({
        lp: authority.publicKey, pool: poolPda,
        lpTokenAccount: lpAta, vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    // 3. Create market (seeds include pool)
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), poolPda.toBuffer(), matchId], tabula.programId);
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
    expect(mkt.pool.toBase58()).to.equal(poolPda.toBase58());
  });

  it("settles via TxLINE CPI", async () => {
    // Initialize txline-mock config (authority-gated publish)
    [txlineConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")], txline.programId);

    await txline.methods.initialize()
      .accounts({
        authority: authority.publicKey,
        config: txlineConfigPda,
        systemProgram: SystemProgram.programId,
      }).rpc();

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
        config: txlineConfigPda,
        statRoot: statRootPda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), statRootPda.toBuffer(), matchId], txline.programId);

    const proof = [leaves[1], Buffer.from(l23)].map((b) => Array.from(b));

    await tabula.methods.settleViaTxline(
        Array.from(statType), new BN(5), proof)
      .accounts({
        payer: authority.publicKey,
        settlementOracle: keeperKey.publicKey,
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

  // ------------------------------------------------------------------
  // Real (keeper-attested) settlement path. Exercises exactly the
  // instructions the keeper (TabulaClient) and frontend (place_bet) now
  // submit: update_prediction → place_bet → post_tx_line_attestation →
  // settle_via_tx_line_real → claim_winnings. Uses a fresh market on the
  // same pool so it is independent of the mock-CPI test above.
  // ------------------------------------------------------------------
  const matchId2 = Buffer.alloc(32); matchId2.write("wc-r16-real-path");

  it("real path: update_prediction → place_bet → attest → settle → claim", async () => {
    const [market2] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), poolPda.toBuffer(), matchId2], tabula.programId);

    await tabula.methods.createMarket(
        Array.from(matchId2), Array.from(statType), 4,
        binEdges, initialProbs, new BN(5_000_000))
      .accounts({
        creator: authority.publicKey,
        pool: poolPda, market: market2,
        systemProgram: SystemProgram.programId,
      }).rpc();

    // Oracle pushes a fresh ensemble prediction (oracle_authority signs).
    const newProbs = [new BN(100_000), new BN(500_000), new BN(300_000), new BN(100_000)];
    await tabula.methods.updatePrediction(newProbs, new BN(4_000_000))
      .accounts({ oracle: oracleKey.publicKey, pool: poolPda, market: market2 })
      .rpc();

    const mktAfterPred = await tabula.account.market.fetch(market2);
    expect(mktAfterPred.probs[1].toNumber()).to.equal(500_000);
    expect(mktAfterPred.liquidityB.toNumber()).to.equal(4_000_000);

    // Bettor stakes 100 USDC on outcome 1 (the bin that 5 corners resolves to).
    const [position2] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), market2.toBuffer(), authority.publicKey.toBuffer()],
      tabula.programId);
    await tabula.methods.placeBet(1, new BN(100_000_000))
      .accounts({
        bettor: authority.publicKey,
        pool: poolPda, market: market2, position: position2,
        bettorTokenAccount: lpAta, vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const pos = await tabula.account.position.fetch(position2);
    expect(pos.outcomeIdx).to.equal(1);
    expect(pos.shares.toNumber()).to.be.greaterThan(0);

    // Keeper posts a one-shot attestation, then settles atomically.
    const [attestationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("attestation"), poolPda.toBuffer(), market2.toBuffer()],
      tabula.programId);
    const statValue = new BN(5);
    const fixtureId  = new BN(998877);
    const seq        = 7;
    const statKey    = 42;

    await tabula.methods.postTxLineAttestation(
        Array.from(matchId2), Array.from(statType), statValue, fixtureId, seq, statKey)
      .accounts({
        payer: authority.publicKey,
        settlementOracle: keeperKey.publicKey,
        pool: poolPda, market: market2, attestation: attestationPda,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const att = await tabula.account.txLineAttestation.fetch(attestationPda);
    expect(att.statValue.toNumber()).to.equal(5);
    expect(att.used).to.equal(false);

    await tabula.methods.settleViaTxLineReal(statValue, fixtureId, seq, statKey)
      .accounts({
        payer: authority.publicKey,
        settlementOracle: keeperKey.publicKey,
        pool: poolPda, market: market2, attestation: attestationPda,
      }).rpc();

    const settled = await tabula.account.market.fetch(market2);
    expect(settled.status).to.equal(1);            // Resolved
    expect(settled.winningOutcome).to.equal(1);    // 5 corners → bin [3, 6)
    const attUsed = await tabula.account.txLineAttestation.fetch(attestationPda);
    expect(attUsed.used).to.equal(true);           // one-shot consumed

    // Winner claims — position is on the winning outcome, so payout > 0.
    const balBefore = (await provider.connection.getTokenAccountBalance(lpAta)).value.amount;
    await tabula.methods.claimWinnings()
      .accounts({
        bettor: authority.publicKey,
        pool: poolPda, market: market2, position: position2,
        bettorTokenAccount: lpAta, vault: vaultPda, vaultAuthority: vaultAuth,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const claimed = await tabula.account.position.fetch(position2);
    expect(claimed.claimed).to.equal(true);
    const balAfter = (await provider.connection.getTokenAccountBalance(lpAta)).value.amount;
    expect(Number(balAfter)).to.be.greaterThan(Number(balBefore)); // received payout
  });

  it("keeper raw encoding matches Anchor for update_prediction", async () => {
    // Guards the keeper's hand-built instruction (keeper/src/tabulaClient.ts)
    // against Anchor's canonical encoding: 8-byte discriminator + Borsh
    // Vec<u64> + u64, and the oracle · pool · market account order.
    const probs = [120_000, 480_000, 300_000, 100_000];
    const newB  = 4_200_000;

    const anchorIx = await tabula.methods
      .updatePrediction(probs.map((p) => new BN(p)), new BN(newB))
      .accounts({ oracle: oracleKey.publicKey, pool: poolPda, market: marketPda })
      .instruction();

    const disc = createHash("sha256").update("global:update_prediction").digest().subarray(0, 8);
    const vecLen = Buffer.alloc(4); vecLen.writeUInt32LE(probs.length, 0);
    const probsBuf = Buffer.concat(probs.map((p) => {
      const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(p), 0); return b;
    }));
    const bBuf = Buffer.alloc(8); bBuf.writeBigUInt64LE(BigInt(newB), 0);
    const rawData = Buffer.concat([disc, vecLen, probsBuf, bBuf]);

    expect(Buffer.from(anchorIx.data).equals(rawData)).to.equal(true);
    expect(anchorIx.keys.map((k) => k.pubkey.toBase58())).to.deep.equal(
      [oracleKey.publicKey, poolPda, marketPda].map((k) => k.toBase58()));
    expect(anchorIx.keys.map((k) => [k.isSigner, k.isWritable])).to.deep.equal(
      [[true, false], [false, false], [false, true]]);
  });

  // ------------------------------------------------------------------
  // Emergency cancel + refund: governance voids an unsettleable market
  // and the bettor reclaims their full stake.
  // ------------------------------------------------------------------
  const matchId3 = Buffer.alloc(32); matchId3.write("wc-r16-cancelled");

  it("cancel_market → claim_refund returns the full stake", async () => {
    const [market3] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), poolPda.toBuffer(), matchId3], tabula.programId);

    await tabula.methods.createMarket(
        Array.from(matchId3), Array.from(statType), 4,
        binEdges, initialProbs, new BN(5_000_000))
      .accounts({
        creator: authority.publicKey,
        pool: poolPda, market: market3,
        systemProgram: SystemProgram.programId,
      }).rpc();

    const [position3] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), market3.toBuffer(), authority.publicKey.toBuffer()],
      tabula.programId);

    const balBeforeBet = (await provider.connection.getTokenAccountBalance(lpAta)).value.amount;

    await tabula.methods.placeBet(2, new BN(50_000_000))
      .accounts({
        bettor: authority.publicKey,
        pool: poolPda, market: market3, position: position3,
        bettorTokenAccount: lpAta, vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();

    // Admin cancels the still-Trading market.
    await tabula.methods.cancelMarket()
      .accounts({ authority: authority.publicKey, pool: poolPda, market: market3 })
      .rpc();
    const cancelled = await tabula.account.market.fetch(market3);
    expect(cancelled.status).to.equal(2); // Cancelled

    // Settlement of a cancelled market is not possible.
    let settleRejected = false;
    try {
      await tabula.methods.updatePrediction(
          [new BN(250_000), new BN(250_000), new BN(250_000), new BN(250_000)], new BN(4_000_000))
        .accounts({ oracle: oracleKey.publicKey, pool: poolPda, market: market3 })
        .rpc();
    } catch { settleRejected = true; }
    expect(settleRejected).to.equal(true); // NotTrading

    // Bettor reclaims the full 50 USDC stake.
    await tabula.methods.claimRefund()
      .accounts({
        bettor: authority.publicKey,
        pool: poolPda, market: market3, position: position3,
        bettorTokenAccount: lpAta, vault: vaultPda, vaultAuthority: vaultAuth,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const refunded = await tabula.account.position.fetch(position3);
    expect(refunded.claimed).to.equal(true);
    const balAfterRefund = (await provider.connection.getTokenAccountBalance(lpAta)).value.amount;
    expect(balAfterRefund).to.equal(balBeforeBet); // stake fully returned

    // Double-refund is rejected.
    let doubleRejected = false;
    try {
      await tabula.methods.claimRefund()
        .accounts({
          bettor: authority.publicKey,
          pool: poolPda, market: market3, position: position3,
          bettorTokenAccount: lpAta, vault: vaultPda, vaultAuthority: vaultAuth,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
    } catch { doubleRejected = true; }
    expect(doubleRejected).to.equal(true); // AlreadyClaimed
  });
});
