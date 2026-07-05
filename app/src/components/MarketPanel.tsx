"use client";
import React, { useState } from "react";

interface Props {
  binLabels: string[];
  probs?: number[];
  priceWithFee?: number[];
  b?: number;
  divergence?: number;
  minute: number;
  onMinuteChange: (m: number) => void;
  busy: boolean;
  walletConnected: boolean;
  onBet: (outcomeIdx: number, stakeUsdc: number) => void;
  betting: boolean;
  betStatus: string | null;
}

export function MarketPanel(p: Props) {
  const {
    binLabels, probs, priceWithFee, b, divergence, minute, onMinuteChange, busy,
    walletConnected, onBet, betting, betStatus,
  } = p;
  const [stake, setStake] = useState(10);

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-5">
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-xs text-white/50">Market</p>
          <h2 className="text-lg font-semibold">World Cup R16 · ARG vs FRA</h2>
          <p className="text-xs text-white/60">Corners in H2 · categorical (4 bins)</p>
        </div>
        <div className="text-right text-xs">
          <p className="text-white/50">liquidity b</p>
          <p className="font-mono text-accent">{b ? b.toLocaleString() : "…"}</p>
          <p className="text-white/40 mt-1">divergence {divergence?.toFixed(3) ?? "…"}</p>
        </div>
      </div>

      <div className="mb-4">
        <label className="text-xs text-white/60">
          Live minute: <span className="text-accent">{minute}′</span>
        </label>
        <input
          type="range" min={1} max={90} value={minute}
          onChange={(e) => onMinuteChange(Number(e.target.value))}
          className="w-full accent-emerald-400"
          disabled={busy}
        />
      </div>

      <div className="mb-4 flex items-center gap-2 text-xs">
        <label className="text-white/60" htmlFor="stake">Stake (USDC)</label>
        <input
          id="stake"
          type="number"
          min={0}
          step={1}
          value={stake}
          onChange={(e) => setStake(Number(e.target.value))}
          className="w-24 rounded-md bg-black/40 border border-white/10 px-2 py-1 font-mono text-accent"
          disabled={betting}
        />
        {!walletConnected && (
          <span className="text-amber-300/80">connect a wallet to bet</span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {binLabels.map((lab, i) => {
          const pi = probs?.[i] ?? 0;
          const price = priceWithFee?.[i] ?? 0;
          const decimalOdds = price > 0 ? (1 / price) : 0;
          return (
            <button
              key={lab}
              className="text-left rounded-lg border border-white/10 bg-black/30 hover:bg-black/50 transition p-3 disabled:opacity-50"
              disabled={busy || betting}
              onClick={() => onBet(i, stake)}
            >
              <p className="text-xs text-white/60">{lab}</p>
              <p className="text-2xl font-bold text-accent">{decimalOdds ? decimalOdds.toFixed(2) : "—"}</p>
              <p className="text-[10px] text-white/40">
                p={pi.toFixed(3)} · price={price.toFixed(3)}
              </p>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-white/40 mt-3">
        Decimal odds shown include the 2% AMM spread. Slippage tightens as ensemble divergence rises.
      </p>

      {betStatus && (
        <p className="mt-3 text-[11px] font-mono break-all text-white/70">
          {betting ? "⏳ " : ""}{betStatus}
        </p>
      )}
    </div>
  );
}
