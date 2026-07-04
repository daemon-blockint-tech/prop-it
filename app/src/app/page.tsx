"use client";

import React, { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { MarketPanel } from "@/components/MarketPanel";
import { ReceiptPanel } from "@/components/ReceiptPanel";
import { OracleStatus } from "@/components/OracleStatus";

const BIN_EDGES = [0, 3, 6, 9, 999];
const BIN_LABELS = ["0–2 corners", "3–5 corners", "6–8 corners", "9+ corners"];
const ORACLE_URL = process.env.NEXT_PUBLIC_ORACLE_URL ?? "http://127.0.0.1:8787";

interface Snapshot {
  probs: number[];
  b: number;
  divergence: number;
  latencyMs: number;
  backend: string;
  minute: number;
}

export default function Page() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [minute, setMinute] = useState(47);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceWithFee = useMemo(() => {
    if (!snap) return [];
    return snap.probs.map((p) => p * 1.02); // 2% spread mirroring FEE_BPS on-chain
  }, [snap]);

  async function fetchPrediction(atMinute: number) {
    setBusy(true); setError(null);
    try {
      const { data } = await axios.post(`${ORACLE_URL}/predict`, {
        match_id: "world-cup-2026-r16-arg-vs-fra",
        stat_type: "corners_h2",
        bin_edges: BIN_EDGES,
        history: syntheticHistory(),
        live: {
          minute: atMinute,
          score_diff: atMinute > 60 ? 1 : 0,
          shots_on_target: 3 + Math.floor(atMinute / 15),
          possession: 55,
          corners_so_far: Math.max(0, atMinute - 45) / 5 | 0,
        },
        base_b: 5_000_000,
      });
      setSnap({
        probs: data.probs_float,
        b: data.liquidity_b,
        divergence: data.ensemble_divergence,
        latencyMs: data.latency_ms,
        backend: data.model_backend,
        minute: atMinute,
      });
    } catch (e: any) {
      setError(e?.message ?? "oracle unavailable");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { fetchPrediction(minute); /* eslint-disable-next-line */ }, []);

  return (
    <div className="grid md:grid-cols-3 gap-6">
      <section className="md:col-span-2 space-y-6">
        <MarketPanel
          binLabels={BIN_LABELS}
          probs={snap?.probs}
          priceWithFee={priceWithFee}
          b={snap?.b}
          divergence={snap?.divergence}
          minute={minute}
          onMinuteChange={(m) => { setMinute(m); fetchPrediction(m); }}
          busy={busy}
        />
        <ReceiptPanel
          matchId="world-cup-2026-r16-arg-vs-fra"
          statType="corners_h2"
        />
      </section>
      <aside className="space-y-6">
        <OracleStatus
          backend={snap?.backend ?? "…"}
          latencyMs={snap?.latencyMs ?? 0}
          divergence={snap?.divergence ?? 0}
          error={error}
        />
        <div className="rounded-xl border border-white/10 bg-panel p-4 text-xs text-white/60 leading-relaxed">
          <p className="mb-2 text-white/80 font-semibold">How it works</p>
          <ol className="list-decimal ml-4 space-y-1">
            <li>TxLINE streams live match ticks (8–10ms latency).</li>
            <li>TabFM ensemble runs zero-shot in-context on tabular history + live state.</li>
            <li>Keeper submits <code className="text-accent">update_prediction</code> on Solana.</li>
            <li>LMSR curve recentres on the new probabilities; <code>b</code> shrinks when the ensemble disagrees.</li>
            <li>At full time, <code className="text-accent">settle_via_txline</code> CPI verifies the Merkle proof and pays winners in USDC.</li>
          </ol>
        </div>
      </aside>
    </div>
  );
}

// Small synthetic history so the demo is standalone.
function syntheticHistory() {
  const rng = mulberry32(42);
  return Array.from({ length: 120 }, () => {
    const corners_h2 = Math.floor(rng() * 11);
    const bin = corners_h2 < 3 ? 0 : corners_h2 < 6 ? 1 : corners_h2 < 9 ? 2 : 3;
    return {
      minute: 45,
      score_diff: Math.floor(rng() * 3) - 1,
      shots_on_target: 3 + Math.floor(rng() * 8),
      possession: 40 + Math.floor(rng() * 25),
      corners_so_far: Math.floor(rng() * 5),
      outcome_bin: bin,
    };
  });
}

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
