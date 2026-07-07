"use client";
import React from "react";

export function OracleStatus({
  backend,
  latencyMs,
  divergence,
  error,
  loading,
  hasData,
}: {
  backend?: string;
  latencyMs?: number;
  divergence?: number;
  error: string | null;
  loading: boolean;
  hasData: boolean;
}) {
  const statusLabel = error
    ? "Oracle error"
    : loading && !hasData
      ? "Fetching prediction"
      : hasData
        ? "Oracle ready"
        : "No prediction yet";

  const badgeStyle = error
    ? "bg-danger/10 text-danger-deep border-danger/30"
    : loading
      ? "bg-ink/5 text-ink/60 border-ink/15"
      : hasData
        ? "bg-mint/15 text-mint-deep border-mint/40"
        : "bg-ink/5 text-ink/50 border-ink/15";

  return (
    <div
      className="rounded-blob bg-card p-5 shadow-pop border-2 border-ink/10"
      aria-live="polite"
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-ink/50">
          Oracle
        </p>
        <span className={`text-[11px] font-bold px-3 py-1 rounded-full border-2 ${badgeStyle}`}>
          {statusLabel}
        </span>
      </div>

      {loading && !hasData && !error && (
        <div className="space-y-2 animate-pulse" aria-hidden="true">
          <div className="h-5 w-32 rounded-full bg-ink/10" />
          <div className="h-3 w-full rounded-full bg-ink/10" />
          <div className="h-3 w-3/4 rounded-full bg-ink/10" />
        </div>
      )}

      {!loading || hasData ? (
        <>
          <p className="font-display text-xl font-extrabold">
            TabFM{" "}
            <span className="text-lavender-deep">{hasData && backend ? backend : "—"}</span>
          </p>
          {hasData ? (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between items-center rounded-xl bg-cream border border-ink/10 px-3 py-2">
                <dt className="font-semibold text-ink/50">latency</dt>
                <dd className="font-mono font-bold">
                  {latencyMs != null ? `${latencyMs.toFixed(0)} ms` : "—"}
                </dd>
              </div>
              <div className="flex justify-between items-center rounded-xl bg-cream border border-ink/10 px-3 py-2">
                <dt className="font-semibold text-ink/50">ensemble div.</dt>
                <dd className="font-mono font-bold">
                  {divergence != null ? divergence.toFixed(3) : "—"}
                </dd>
              </div>
              <div className="flex justify-between items-center rounded-xl bg-cream border border-ink/10 px-3 py-2">
                <dt className="font-semibold text-ink/50">model</dt>
                <dd className="font-mono text-xs font-bold">google/tabfm-1.0.0</dd>
              </div>
            </dl>
          ) : !error ? (
            <p className="mt-3 text-sm text-ink/50">
              Waiting for the first response from the local oracle.
            </p>
          ) : null}
        </>
      ) : null}

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-2xl border-2 border-danger/30 bg-danger/10 px-4 py-3"
        >
          <p className="text-sm font-bold text-danger-deep">Could not fetch odds</p>
          <p className="mt-1 text-xs font-medium text-danger-deep break-words">{error}</p>
          <button
            type="button"
            className="mt-3 rounded-full bg-danger text-white text-xs font-bold px-4 py-2 hover:opacity-90 transition"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      )}

      {loading && hasData && (
        <p className="mt-3 text-xs font-semibold text-ink/40">Updating for minute change…</p>
      )}
    </div>
  );
}
