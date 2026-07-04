"use client";
import React from "react";

export function OracleStatus({
  backend, latencyMs, divergence, error,
}: {
  backend: string; latencyMs: number; divergence: number; error: string | null;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-panel p-4">
      <p className="text-xs text-white/50 mb-2">Oracle</p>
      <div className="flex justify-between items-baseline">
        <p className="text-lg font-semibold">
          TabFM <span className="text-accent">{backend}</span>
        </p>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <dt className="text-white/50">latency</dt>
        <dd className="text-right">{latencyMs.toFixed(0)} ms</dd>
        <dt className="text-white/50">ensemble div.</dt>
        <dd className="text-right">{divergence.toFixed(3)}</dd>
        <dt className="text-white/50">model</dt>
        <dd className="text-right">google/tabfm-1.0.0</dd>
      </dl>
      {error && (
        <p className="mt-3 text-xs text-danger break-all">
          ⚠ {error}
        </p>
      )}
    </div>
  );
}
