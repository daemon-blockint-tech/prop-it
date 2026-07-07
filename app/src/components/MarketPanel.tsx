"use client";
import React from "react";

interface Props {
  binLabels: string[];
  probs?: number[];
  priceWithFee?: number[];
  b?: number;
  divergence?: number;
  minute: number;
  onMinuteChange: (m: number) => void;
  busy: boolean;
  hasData: boolean;
}

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function MarketPanel(p: Props) {
  const { binLabels, probs, priceWithFee, b, divergence, minute, onMinuteChange, busy, hasData } = p;
  const showSkeleton = busy && !hasData;

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-5">
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-xs text-white/50">Market</p>
          <h2 className="text-lg font-semibold">World Cup R16 · ARG vs FRA</h2>
          <p className="text-xs text-white/60">H2 corners · 4 bins</p>
        </div>
        <div className="text-right text-xs">
          <p className="text-white/50">liquidity b</p>
          <p className="font-mono text-accent" aria-live="polite">
            {showSkeleton ? (
              <span className="inline-block h-4 w-16 rounded bg-white/10 animate-pulse align-middle" />
            ) : b != null ? (
              b.toLocaleString()
            ) : (
              "—"
            )}
          </p>
          <p className="text-white/40 mt-1">
            divergence{" "}
            {showSkeleton ? "…" : divergence != null ? divergence.toFixed(3) : "—"}
          </p>
        </div>
      </div>

      <div className="mb-4">
        <label htmlFor="live-minute" className="text-xs text-white/60">
          Live minute: <span className="text-accent">{minute}′</span>
        </label>
        <input
          id="live-minute"
          type="range"
          min={1}
          max={90}
          value={minute}
          onChange={(e) => onMinuteChange(Number(e.target.value))}
          className={`w-full accent-emerald-400 ${focusRing}`}
          disabled={busy}
          aria-valuemin={1}
          aria-valuemax={90}
          aria-valuenow={minute}
          aria-busy={busy}
          aria-label="Live match minute"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-busy={showSkeleton}>
        {binLabels.map((lab, i) => {
          const pi = probs?.[i] ?? 0;
          const price = priceWithFee?.[i] ?? 0;
          const decimalOdds = price > 0 ? 1 / price : 0;
          return (
            <button
              key={lab}
              type="button"
              className={`text-left rounded-lg border border-white/10 bg-black/30 hover:bg-black/50 disabled:opacity-60 disabled:cursor-wait transition p-3 ${focusRing}`}
              disabled={busy || !hasData}
              aria-label={`${lab}: demo bet only, not sent to chain`}
              onClick={() =>
                alert(
                  `Demo only — not connected to place_bet.\n\nWould submit: outcome_idx=${i}, usdc_amount (devnet).`,
                )
              }
            >
              {showSkeleton ? (
                <div className="space-y-2 animate-pulse" aria-hidden="true">
                  <div className="h-3 w-16 rounded bg-white/10" />
                  <div className="h-7 w-12 rounded bg-white/10" />
                  <div className="h-2 w-full rounded bg-white/10" />
                </div>
              ) : (
                <>
                  <p className="text-xs text-white/60">{lab}</p>
                  <p className="text-2xl font-bold text-accent">
                    {decimalOdds ? decimalOdds.toFixed(2) : "—"}
                  </p>
                  <p className="text-[10px] text-white/40">
                    p={hasData ? pi.toFixed(3) : "—"} · price={hasData ? price.toFixed(3) : "—"}
                  </p>
                </>
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-white/40 mt-3">
        Odds include 2% spread. Liquidity <code>b</code> drops when ensemble models disagree.
      </p>
      <p className="text-[11px] text-amber-300/80 mt-1">
        Outcome buttons are demo-only — alert stub, no wallet transaction.
      </p>
    </div>
  );
}
