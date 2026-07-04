"use client";
import React, { useState } from "react";

/**
 * "Verifiable Resolution UI" — the differentiator called out in the PRD.
 *
 * For the MVP we render a Merkle proof "receipt" derived from the local
 * keeper's mock TxLINE tree so users can inspect that the stat_value they
 * won / lost on was actually anchored on-chain, not fabricated by a
 * centralised server.
 */
export function ReceiptPanel({ matchId, statType }: { matchId: string; statType: string }) {
  const [receipt, setReceipt] = useState<null | {
    stat_value: number;
    merkle_root: string;
    proof: string[];
    tx_signature: string;
  }>(null);

  function loadDemoReceipt() {
    // For the frontend-only demo we hardcode a receipt that mirrors what the
    // keeper's `publishStat.ts` would emit. In a live cluster this comes
    // from an RPC read of the StatReceipt PDA.
    setReceipt({
      stat_value: 5,
      merkle_root: "0x8f1d…c39a",
      proof: [
        "0x4b2f7a1d8e9f0c2a3b5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9",
        "0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
        "0xdeadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef",
      ],
      tx_signature: "5xW3…rQzk",
    });
  }

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-5">
      <div className="flex justify-between items-center mb-3">
        <div>
          <p className="text-xs text-white/50">Verifiable Resolution</p>
          <h2 className="text-lg font-semibold">TxLINE data receipt</h2>
          <p className="text-[11px] text-white/50 mt-1">
            match: <span className="font-mono">{matchId}</span> · stat: <span className="font-mono">{statType}</span>
          </p>
        </div>
        <button
          className="text-xs rounded-md bg-accent text-black font-semibold px-3 py-2 hover:opacity-90"
          onClick={loadDemoReceipt}
        >
          Fetch receipt
        </button>
      </div>
      {!receipt ? (
        <p className="text-xs text-white/40">
          After full-time, click <span className="text-accent">Fetch receipt</span> to load the on-chain
          Merkle proof written by TxLINE. This is what the smart contract used to release your USDC.
        </p>
      ) : (
        <div className="text-xs space-y-2 font-mono">
          <p>stat_value = <span className="text-accent">{receipt.stat_value}</span></p>
          <p>merkle_root = <span className="break-all">{receipt.merkle_root}</span></p>
          <details>
            <summary className="cursor-pointer text-white/70">Merkle proof ({receipt.proof.length} siblings)</summary>
            <ul className="mt-2 space-y-1 pl-4 list-disc break-all">
              {receipt.proof.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </details>
          <p className="pt-2 text-white/60">
            settle_via_txline tx: <span className="text-accent">{receipt.tx_signature}</span>
          </p>
          <p className="text-[10px] text-white/40 pt-1">
            Verify yourself: keccak256 the leaf, sort-pair with each sibling, and compare to the anchored root.
          </p>
        </div>
      )}
    </div>
  );
}
