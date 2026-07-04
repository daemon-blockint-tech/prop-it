/**
 * Tabula keeper bot
 * -----------------
 * 1. Subscribes to TxLINE (or the local emulator) match ticks.
 * 2. On each tick, asks the TabFM oracle for a fresh probability vector
 *    over the market's outcome bins and computes a dynamic `b`.
 * 3. If the divergence from the last on-chain prediction exceeds the
 *    configured threshold, submits `update_prediction`.
 * 4. When the feed emits `full_time`, publishes the Merkle-anchored stat
 *    root to TxLINE and calls `settle_via_txline` to resolve the market.
 *
 * All Solana signing is deferred to `solana.ts` so this file stays
 * business-logic focused.
 */

import { cfg } from "./config.js";
import { callOracle, oracleHealth } from "./oracle.js";
import { LocalTxLineEmulator, MatchTick } from "./txlineFeed.js";
import { syntheticHistory } from "./history.js";

const MATCH_ID     = process.env.MATCH_ID  ?? "world-cup-2026-r16-arg-vs-fra";
const STAT_TYPE    = "corners_h2";
const BIN_EDGES    = [0, 3, 6, 9, 999];
const FINAL_CORNERS_H2 = Number(process.env.FINAL_CORNERS_H2 ?? 5);
const BASE_B       = 5_000_000;

async function main() {
  console.log("[keeper] Tabula keeper starting …");
  console.log(`[keeper] oracle=${cfg.oracleUrl}  rpc=${cfg.rpcUrl}`);

  try {
    const h = await oracleHealth();
    console.log(`[keeper] oracle backend=${h.backend}`);
  } catch (e) {
    console.warn("[keeper] oracle health check failed — continuing anyway", e);
  }

  const history = syntheticHistory(BIN_EDGES, 200, 42);
  console.log(`[keeper] loaded ${history.length} historical rows`);

  const feed = new LocalTxLineEmulator(MATCH_ID, FINAL_CORNERS_H2);
  let lastProbs: number[] | null = null;
  let lastUpdate = 0;

  feed.on("tick", async (t: MatchTick) => {
    if (t.status !== "live" && t.status !== "half_time") return;
    if (Date.now() - lastUpdate < cfg.updateIntervalMs) return;
    lastUpdate = Date.now();

    try {
      const p = await callOracle({
        match_id: t.match_id,
        stat_type: STAT_TYPE,
        bin_edges: BIN_EDGES,
        history,
        live: t.live,
        base_b: BASE_B,
      });

      const drift = lastProbs
        ? maxAbsDrift(lastProbs, p.probs_float)
        : Infinity;

      const line = `[keeper] min=${t.live.minute}  probs=${p.probs_float.map((x) => x.toFixed(3)).join(",")}  b=${p.liquidity_b}  div=${p.ensemble_divergence.toFixed(3)}  drift=${drift.toFixed(3)}  backend=${p.model_backend}  ${p.latency_ms.toFixed(0)}ms`;
      console.log(line);

      if (drift > cfg.divergenceThreshold) {
        console.log(`[keeper]   ↳ drift > ${cfg.divergenceThreshold} → would submit update_prediction on-chain`);
        // Real Solana call happens in `solana.ts::submitUpdatePrediction(...)`.
        // Kept as a log line so the demo runs without a live validator.
        lastProbs = p.probs_float;
      }
    } catch (e) {
      console.error("[keeper] oracle error", e);
    }
  });

  feed.on("full_time", (e) => {
    console.log(`[keeper] FULL TIME — publishing Merkle stat root + settling market for match ${e.match_id}`);
    console.log(`[keeper]   corners_h2 = ${e.corners_h2}`);
    console.log("[keeper]   (in a live cluster the keeper now: 1) txline.publish_stat_root  2) tabula.settle_via_txline)");
  });

  feed.start(1_000);
}

function maxAbsDrift(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

main().catch((e) => {
  console.error("[keeper] fatal", e);
  process.exit(1);
});
