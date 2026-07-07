"use client";
import React, { useState } from "react";

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * DEMO / UNVERIFIED resolution UI — placeholder receipt data only.
 */
export function ReceiptPanel({ matchId, statType }: { matchId: string; statType: string }) {
  const [receipt, setReceipt] = useState<null | {
    stat_value: number;
    merkle_root: string;
    proof: string[];
    tx_signature: string;
  }>(null);

  function loadDemoReceipt() {
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
          DEMO / UNVERIFIED
        </p>
        <p className="text-[11px] text-amber-200/70 mt-0.5">
          Hardcoded sample data. No RPC read, no Merkle check, no payout.
        </p>
      </div>
      <div className="flex justify-between items-center mb-3 gap-3">
        <div>
          <p className="text-xs text-white/50">Settlement receipt (demo)</p>
          <h2 className="text-lg font-semibold">TxLINE stat receipt</h2>
          <p className="text-[11px] text-white/50 mt-1">
            match: <span className="font-mono">{matchId}</span> · stat:{" "}
            <span className="font-mono">{statType}</span>
          </p>
        </div>
        <button
          type="button"
          className={`text-xs rounded-md bg-accent text-black font-semibold px-3 py-2 hover:opacity-90 shrink-0 ${focusRing}`}
          onClick={loadDemoReceipt}
          aria-label="Load unverified demo settlement receipt"
        >
          Show sample receipt
        </button>
      </div>
      {!receipt ? (
        <p className="text-xs text-white/40">
          No receipt loaded. Use the button above to preview the layout — data is fake.
        </p>
      ) : (
        <div className="text-xs space-y-2 font-mono">
          <p className="text-amber-300/90 font-sans font-semibold">Unverified demo data</p>
          <p>
            stat_value = <span className="text-accent">{receipt.stat_value}</span>
          </p>
          <p>
            merkle_root = <span className="break-all">{receipt.merkle_root}</span>
          </p>
          <details>
            <summary className={`cursor-pointer text-white/70 ${focusRing}`}>
              Merkle proof ({receipt.proof.length} siblings)
            </summary>
            <ul className="mt-2 space-y-1 pl-4 list-disc break-all">
              {receipt.proof.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </details>
          <p className="pt-2 text-white/60">
            settle_via_txline tx: <span className="text-accent">{receipt.tx_signature}</span>
          </p>
          <p className="text-[10px] text-white/40 pt-1">
            Leaf hash and root compare are not run in this panel.
          </p>
        </div>
      )}
    </div>
  );
}
