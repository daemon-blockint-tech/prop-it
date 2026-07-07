"use client";
import React, { useState } from "react";

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
    <div className="rounded-blob bg-card p-6 shadow-pop border-2 border-ink/10">
      <div className="mb-4 rounded-2xl bg-sun/40 border-2 border-sun px-4 py-3 flex items-start gap-3">
        <span className="text-xl" aria-hidden="true">🚧</span>
        <div>
          <p className="text-sm font-extrabold tracking-wide">DEMO / UNVERIFIED</p>
          <p className="text-xs font-medium text-ink/60 mt-0.5">
            Hardcoded sample data. No RPC read, no Merkle check, no payout.
          </p>
        </div>
      </div>

      <div className="flex justify-between items-center mb-4 gap-3 flex-wrap">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink/50">
            Settlement receipt (demo)
          </p>
          <h2 className="font-display text-xl font-extrabold">TxLINE stat receipt</h2>
          <p className="text-xs font-medium text-ink/50 mt-1">
            match: <span className="font-mono">{matchId}</span> · stat:{" "}
            <span className="font-mono">{statType}</span>
          </p>
        </div>
        <button
          type="button"
          className="rounded-full bg-ink text-cream text-sm font-bold px-5 py-2.5 shrink-0 hover:-translate-y-0.5 hover:shadow-pop active:translate-y-0 transition-all duration-150"
          onClick={loadDemoReceipt}
          aria-label="Load unverified demo settlement receipt"
        >
          Show sample receipt
        </button>
      </div>

      {!receipt ? (
        <div className="rounded-2xl bg-cream border-2 border-dashed border-ink/15 p-6 text-center">
          <p className="text-sm font-semibold text-ink/40">
            No receipt loaded. Use the button above to preview the layout with fake data.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl bg-cream border-2 border-ink/10 p-4 text-sm space-y-3">
          <p className="inline-block rounded-full bg-sun/50 px-3 py-1 text-xs font-bold">
            Unverified demo data
          </p>
          <p className="font-mono">
            stat_value = <span className="font-bold text-lavender-deep">{receipt.stat_value}</span>
          </p>
          <p className="font-mono text-xs">
            merkle_root = <span className="break-all">{receipt.merkle_root}</span>
          </p>
          <details className="rounded-xl bg-white border border-ink/10 px-3 py-2">
            <summary className="cursor-pointer text-sm font-bold text-ink/70">
              Merkle proof ({receipt.proof.length} siblings)
            </summary>
            <ul className="mt-2 space-y-1 pl-4 list-disc break-all font-mono text-xs text-ink/70">
              {receipt.proof.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </details>
          <p className="font-mono text-xs text-ink/60">
            settle_via_txline tx:{" "}
            <span className="font-bold text-lavender-deep">{receipt.tx_signature}</span>
          </p>
          <p className="text-[10px] font-medium text-ink/40">
            Leaf hash and root compare are not run in this panel.
          </p>
        </div>
      )}
    </div>
  );
}
