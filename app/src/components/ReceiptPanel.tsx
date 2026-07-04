"use client";
import React, { useState } from "react";

/**
 * DEMO / UNVERIFIED resolution UI.
 *
 * This panel shows placeholder Merkle-proof-shaped data for product demos.
 * It does **not** read on-chain accounts or verify proofs. Do not treat
 * anything rendered here as settlement evidence until a real RPC verify
 * path is wired.
 */
export function ReceiptPanel({ matchId, statType }: { matchId: string; statType: string }) {
  const [receipt, setReceipt] = useState<null | {
    stat_value: number;
    merkle_root: string;
    proof: string[];
    tx_signature: string;
  }>(null);

  function loadDemoReceipt() {
    // Hardcoded demo payload only — not fetched from chain, not verified.
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
    <div className="rounded-xl border border-amber-500/40 bg-panel p-5">
      <div className="mb-3 rounded-md bg-amber-500/15 border border-amber-500/30 px-3 py-2">
        <p className="text-xs font-semibold text-amber-300 tracking-wide">
          DEMO / UNVERIFIED — not on-chain proof
        </p>
        <p className="text-[11px] text-amber-200/70 mt-0.5">
          This UI shows sample receipt-shaped data only. No Merkle verification or
          PDA read is performed. Do not rely on it for payouts or dispute resolution.
        </p>
      </div>
      <div className="flex justify-between items-center mb-3">
        <div>
          <p className="text-xs text-white/50">Resolution receipt (demo)</p>
          <h2 className="text-lg font-semibold">TxLINE data receipt</h2>
          <p className="text-[11px] text-white/50 mt-1">
            match: <span className="font-mono">{matchId}</span> · stat: <span className="font-mono">{statType}</span>
          </p>
        </div>
        <button
          className="text-xs rounded-md bg-accent text-black font-semibold px-3 py-2 hover:opacity-90"
          onClick={loadDemoReceipt}
        >
          Load demo receipt
        </button>
      </div>
      {!receipt ? (
        <p className="text-xs text-white/40">
          Click <span className="text-accent">Load demo receipt</span> to preview the
          receipt layout. Live verification against the StatReceipt PDA is not implemented.
        </p>
      ) : (
        <div className="text-xs space-y-2 font-mono">
          <p className="text-amber-300/90 font-sans font-semibold">Status: unverified demo data</p>
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
            Demo only — leaf hashing and root comparison are not run in this panel.
          </p>
        </div>
      )}
    </div>
  );
}
