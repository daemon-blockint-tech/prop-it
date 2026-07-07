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

function oracleErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.code === "ERR_NETWORK" || err.message === "Network Error") {
      return `Oracle not reachable at ${ORACLE_URL}. Start the oracle service, then refresh.`;
    }
    if (err.response?.status === 404) {
      return "Oracle returned 404. Check NEXT_PUBLIC_ORACLE_URL and the /predict route.";
    }
    if (err.response?.status === 500) {
      return "Oracle failed on /predict (500). Check oracle logs for model or input errors.";
    }
    if (err.response?.status) {
      return `Oracle error ${err.response.status}: ${err.response.statusText || "request failed"}.`;
    }
    return err.message || "Oracle request failed.";
  }
  if (err instanceof Error) return err.message;
  return "Oracle request failed.";
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
    setBusy(true);
    setError(null);
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
    } catch (e) {
      setError(oracleErrorMessage(e));
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
          hasData={!!snap}
        />
        <ReceiptPanel
          matchId="world-cup-2026-r16-arg-vs-fra"
          statType="corners_h2"
        />
      </section>
      <aside className="space-y-6">
        <OracleStatus
          backend={snap?.backend}
          latencyMs={snap?.latencyMs}
          divergence={snap?.divergence}
          error={error}
          loading={busy}
          hasData={!!snap}
        />
        <div className="rounded-blob bg-ink text-cream p-5 shadow-pop border-2 border-ink text-sm leading-relaxed">
          <p className="mb-3 font-display font-extrabold text-base">How the demo works</p>
          <ol className="list-decimal ml-4 space-y-2 text-cream/80">
            <li>An oracle feeds live match ticks (target latency ~8–10 ms).</li>
            <li>TabFM scores tabular history plus live state; a keeper calls <code className="font-mono text-sun">update_prediction</code>.</li>
            <li>LMSR reprices the market. Liquidity <code className="font-mono">b</code> shrinks when the ensemble models disagree.</li>
            <li>At full time, <code className="font-mono text-sun">settle_via_txline</code> checks the Merkle proof and pays out USDC.</li>
          </ol>
          <p className="mt-4 text-xs text-cream/50">
            This page only runs steps 2–3, against a local oracle. Bets and settlement are stubbed.
          </p>
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
