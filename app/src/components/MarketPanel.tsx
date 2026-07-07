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
  hasData: boolean;
}

const outcomeTints = [
  "bg-blush/50 hover:bg-blush",
  "bg-sun/40 hover:bg-sun/80",
  "bg-sky/40 hover:bg-sky/80",
  "bg-mint/20 hover:bg-mint/50",
];

export function MarketPanel(p: Props) {
  const { binLabels, probs, priceWithFee, b, divergence, minute, onMinuteChange, busy, hasData } = p;
  const showSkeleton = busy && !hasData;
  const isEmpty = !busy && !hasData;
  const fillPct = ((minute - 1) / 89) * 100;

  // Demo bets are not wired to the chain. Instead of a blocking alert(), we
  // surface a labelled, screen-reader-announced notice inline.
  const [demoBet, setDemoBet] = useState<{ idx: number; label: string } | null>(null);

  return (
    <div className="rounded-blob bg-card p-6 shadow-pop-lg border-2 border-ink/10">
      <div className="flex justify-between items-start mb-5 gap-4">
        <div>
          <span className="inline-block rounded-full bg-lavender/40 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-lavender-deep mb-2">
            Live market
          </span>
          <h2 className="font-display text-2xl font-extrabold leading-tight">
            World Cup R16 · ARG vs FRA
          </h2>
          <p className="text-sm font-medium text-ink/60">2nd-half corners · 4 outcomes</p>
        </div>
        <div className="text-right shrink-0 rounded-2xl bg-cream border-2 border-ink/10 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-ink/50">Liquidity b</p>
          <p className="font-mono font-bold text-lavender-deep" aria-live="polite">
            {showSkeleton ? (
              <span
                className="inline-block h-4 w-16 rounded bg-ink/10 animate-pulse align-middle"
                aria-hidden="true"
              />
            ) : b != null ? (
              b.toLocaleString()
            ) : (
              "—"
            )}
          </p>
          <p className="text-[11px] text-ink/40 mt-1">
            divergence {showSkeleton ? "…" : divergence != null ? divergence.toFixed(3) : "—"}
          </p>
        </div>
      </div>

      <div className="mb-6 rounded-2xl bg-cream border-2 border-ink/10 p-4">
        <label htmlFor="live-minute" className="flex items-center justify-between text-sm font-bold mb-2">
          <span>Live minute</span>
          <span className="rounded-full bg-ink text-sun px-3 py-0.5 font-mono">{minute}′</span>
        </label>
        <input
          id="live-minute"
          type="range"
          min={1}
          max={90}
          value={minute}
          onChange={(e) => onMinuteChange(Number(e.target.value))}
          className="phantom-range"
          style={{ ["--fill" as string]: `${fillPct}%` }}
          disabled={busy}
          aria-busy={busy}
          aria-label="Match minute, re-prices the market when changed"
          aria-valuetext={`Minute ${minute}`}
        />
        <div className="flex justify-between text-[10px] font-semibold text-ink/40 mt-1" aria-hidden="true">
          <span>Kickoff</span>
          <span>Half-time</span>
          <span>Full-time</span>
        </div>
      </div>

      <div
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
        aria-busy={showSkeleton}
        role="group"
        aria-label="Outcome odds (demo bets only)"
      >
        {binLabels.map((lab, i) => {
          const pi = probs?.[i] ?? 0;
          const price = priceWithFee?.[i] ?? 0;
          const decimalOdds = price > 0 ? 1 / price : 0;
          return (
            <button
              key={lab}
              type="button"
              className={`text-left rounded-2xl border-2 border-ink/15 ${outcomeTints[i % outcomeTints.length]} disabled:opacity-60 disabled:cursor-not-allowed transition-all duration-150 p-4 hover:-translate-y-1 hover:shadow-pop active:translate-y-0`}
              disabled={busy || !hasData}
              aria-label={`${lab}: decimal odds ${decimalOdds ? decimalOdds.toFixed(2) : "unavailable"}. Demo bet, not sent to chain.`}
              onClick={() => setDemoBet({ idx: i, label: lab })}
            >
              {showSkeleton ? (
                <div className="space-y-2 animate-pulse" aria-hidden="true">
                  <div className="h-3 w-16 rounded bg-ink/10" />
                  <div className="h-7 w-12 rounded bg-ink/10" />
                  <div className="h-2 w-full rounded bg-ink/10" />
                </div>
              ) : (
                <>
                  <p className="text-xs font-bold text-ink/60">{lab}</p>
                  <p className="font-display text-3xl font-extrabold text-ink mt-1">
                    {decimalOdds ? decimalOdds.toFixed(2) : "—"}
                  </p>
                  <div className="mt-2 h-1.5 rounded-full bg-ink/10 overflow-hidden" aria-hidden="true">
                    <div
                      className="h-full rounded-full bg-ink/60 transition-all duration-300"
                      style={{ width: `${Math.min(100, pi * 100)}%` }}
                    />
                  </div>
                  <p className="text-[10px] font-semibold text-ink/50 mt-1.5">
                    p={hasData ? pi.toFixed(3) : "—"} · price={hasData ? price.toFixed(3) : "—"}
                  </p>
                </>
              )}
            </button>
          );
        })}
      </div>

      {isEmpty && (
        <p className="mt-4 rounded-2xl bg-cream border-2 border-dashed border-ink/15 px-4 py-3 text-sm font-semibold text-ink/50">
          No odds loaded. Check oracle status on the right, then move the minute slider to fetch again.
        </p>
      )}

      {demoBet && (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 rounded-2xl border-2 border-peach bg-peach/10 px-4 py-3 flex items-start justify-between gap-3"
        >
          <div>
            <p className="text-sm font-extrabold text-peach">Demo only: no transaction sent</p>
            <p className="text-xs font-medium text-ink/70 mt-0.5">
              On devnet this would submit a bet on <span className="font-bold">{demoBet.label}</span>{" "}
              (outcome_idx={demoBet.idx}). Wallet and{" "}
              <code className="font-mono">place_bet</code> are not wired here.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDemoBet(null)}
            aria-label="Dismiss demo bet notice"
            className="shrink-0 rounded-full bg-ink text-cream text-xs font-bold px-3 py-1.5 hover:opacity-90 transition"
          >
            Got it
          </button>
        </div>
      )}

      <p className="text-xs font-medium text-ink/50 mt-4">
        Odds include a 2% spread. Liquidity <code className="font-mono">b</code> drops when the
        ensemble models disagree.
      </p>
      <p className="text-xs font-semibold text-peach mt-1">
        Outcome buttons are demo-only. No wallet transaction is sent.
      </p>
    </div>
  );
}
