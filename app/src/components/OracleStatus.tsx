"use client";
import React from "react";

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

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

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-4" aria-live="polite">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-white/50">Oracle</p>
        <span
          className={`text-[10px] px-2 py-0.5 rounded border ${
            error
              ? "border-danger/40 text-danger bg-danger/10"
              : loading
                ? "border-white/20 text-white/60 bg-white/5"
                : hasData
                  ? "border-accent/30 text-accent bg-accent/10"
                  : "border-white/20 text-white/50 bg-white/5"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      {loading && !hasData && !error && (
        <div className="space-y-2 animate-pulse" aria-hidden="true">
          <div className="h-5 w-32 rounded bg-white/10" />
          <div className="h-3 w-full rounded bg-white/10" />
          <div className="h-3 w-3/4 rounded bg-white/10" />
        </div>
      )}

      {!loading || hasData ? (
        <>
          <div className="flex justify-between items-baseline">
            <p className="text-lg font-semibold">
              TabFM{" "}
              <span className="text-accent">{hasData && backend ? backend : "—"}</span>
            </p>
          </div>
          {hasData ? (
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <dt className="text-white/50">latency</dt>
              <dd className="text-right">{latencyMs != null ? `${latencyMs.toFixed(0)} ms` : "—"}</dd>
              <dt className="text-white/50">ensemble div.</dt>
              <dd className="text-right">
                {divergence != null ? divergence.toFixed(3) : "—"}
              </dd>
              <dt className="text-white/50">model</dt>
              <dd className="text-right">google/tabfm-1.0.0</dd>
            </dl>
          ) : !error ? (
            <p className="mt-3 text-xs text-white/40">
              Waiting for the first /predict response from the local oracle.
            </p>
          ) : null}
        </>
      ) : null}

      {error && (
        <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
          <p className="text-xs font-semibold text-danger">Could not fetch odds</p>
          <p className="mt-1 text-xs text-danger/90 break-words">{error}</p>
          <button
            type="button"
            className={`mt-2 text-xs underline text-danger/90 hover:text-danger ${focusRing}`}
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      )}

      {loading && hasData && (
        <p className="mt-2 text-[10px] text-white/40">Updating for minute change…</p>
      )}
    </div>
  );
}
