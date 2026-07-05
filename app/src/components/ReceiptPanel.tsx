"use client";
import React, { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import {
  encodeFixedBytes,
  readMarket,
  readAttestation,
  attestationPda,
  marketPda,
  MarketState,
  AttestationState,
} from "@/lib/tabula";

/**
 * On-chain resolution panel. Reads the Market status and the settlement
 * TxLineAttestation account directly from the RPC — no mock data. When the
 * market is unresolved (or the attestation has not been posted) the panel
 * says so rather than fabricating a receipt.
 */
export function ReceiptPanel({ matchId, statType }: { matchId: string; statType: string }) {
  const { connection } = useConnection();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarketState] = useState<MarketState | null>(null);
  const [att, setAtt] = useState<AttestationState | null>(null);
  const [loaded, setLoaded] = useState(false);

  const id32 = encodeFixedBytes(matchId, 32);
  const marketAddr = marketPda(id32).toBase58();
  const attAddr = attestationPda(marketPda(id32)).toBase58();

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [m, a] = await Promise.all([
        readMarket(connection, id32),
        readAttestation(connection, id32),
      ]);
      setMarketState(m);
      setAtt(a);
      setLoaded(true);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  const resolved = market?.status === "Resolved";

  return (
    <div className="rounded-xl border border-white/10 bg-panel p-5">
      <div className="flex justify-between items-center mb-3">
        <div>
          <p className="text-xs text-white/50">Resolution receipt (on-chain)</p>
          <h2 className="text-lg font-semibold">TxLINE settlement</h2>
          <p className="text-[11px] text-white/50 mt-1">
            match: <span className="font-mono">{matchId}</span> · stat:{" "}
            <span className="font-mono">{statType}</span>
          </p>
        </div>
        <button
          className="text-xs rounded-md bg-accent text-black font-semibold px-3 py-2 hover:opacity-90 disabled:opacity-50"
          onClick={refresh}
          disabled={loading}
        >
          {loading ? "reading…" : "Read on-chain"}
        </button>
      </div>

      {error && <p className="text-xs text-danger break-all">⚠ {error}</p>}

      {!loaded && !error && (
        <p className="text-xs text-white/40">
          Reads the Market and TxLineAttestation PDAs from{" "}
          <span className="text-accent">devnet</span>. Click{" "}
          <span className="text-accent">Read on-chain</span> to fetch live state.
        </p>
      )}

      {loaded && !market && (
        <p className="text-xs text-white/60">
          No Market account found at{" "}
          <span className="font-mono break-all">{marketAddr}</span>. The market
          has not been created on this cluster.
        </p>
      )}

      {loaded && market && (
        <div className="text-xs space-y-2 font-mono">
          <p className="font-sans">
            Status:{" "}
            <span className={resolved ? "text-accent" : "text-amber-300"}>
              {market.status}
            </span>
            {resolved && market.winningOutcome !== null && (
              <> · winning bin #{market.winningOutcome}</>
            )}
          </p>

          {att ? (
            <>
              <p>stat_value = <span className="text-accent">{att.statValue.toString()}</span></p>
              <p>txodds_fixture_id = {att.txoddsFixtureId.toString()}</p>
              <p>txodds_seq = {att.txoddsSeq} · stat_key = {att.txoddsStatKey}</p>
              <p className="break-all">
                settlement_oracle = {att.settlementOracle.toBase58()}
              </p>
              <p>attested_at = {new Date(Number(att.attestedAt) * 1000).toISOString()}</p>
              <p>consumed = {String(att.used)}</p>
              <p className="text-[10px] text-white/40 pt-1 break-all">
                attestation PDA: {attAddr}
              </p>
            </>
          ) : (
            <p className="text-white/60 font-sans">
              No TxLineAttestation posted yet — the keeper has not settled this
              market.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
