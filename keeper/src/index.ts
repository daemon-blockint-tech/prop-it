/**
 * Tabula keeper bot
 * -----------------
 * Ties together three data sources into one on-chain effect:
 *
 *   1. TxLINE  — via TxLineClient (guest JWT / apiToken) OR the local
 *                emulator on localnet.
 *   2. TabFM   — the FastAPI oracle at ORACLE_URL.
 *   3. Solana  — signs update_prediction / settle_via_txline txs.
 *
 * Observability: structured JSON logging + Prometheus /metrics on
 * METRICS_PORT + /healthz /readyz probes.
 */

import { cfg } from "./config.js";
import { callOracle, oracleHealth } from "./oracle.js";
import { LocalTxLineEmulator, MatchTick } from "./txlineFeed.js";
import { TxLineClient } from "./txlineClient.js";
import { syntheticHistory } from "./history.js";
import { log } from "./log.js";
import { metrics, setHealth, startMetricsServer } from "./metrics.js";

const MATCH_ID          = process.env.MATCH_ID  ?? "world-cup-2026-r16-arg-vs-fra";
const STAT_TYPE         = "corners_h2";
const BIN_EDGES         = [0, 3, 6, 9, 999];
const FINAL_CORNERS_H2  = Number(process.env.FINAL_CORNERS_H2 ?? 5);
const BASE_B            = 5_000_000;
const USE_REAL_FEED     = (process.env.USE_REAL_TXLINE ?? "0") === "1";
const TXODDS_FIXTURE_ID = Number(process.env.TXODDS_FIXTURE_ID ?? 0);

async function main() {
  log.info({
    cluster:     cfg.cluster,
    oracleUrl:   cfg.oracleUrl,
    rpcUrl:      cfg.rpcUrl,
    metricsPort: cfg.metricsPort,
    realTxline:  USE_REAL_FEED,
  }, "keeper.start");

  startMetricsServer();

  try {
    const h = await oracleHealth();
    log.info({ backend: h.backend }, "oracle.health.ok");
    setHealth("oracle", true);
  } catch (e) {
    log.warn({ err: String(e) }, "oracle.health.fail");
  }

  const history = syntheticHistory(BIN_EDGES, 200, 42);
  log.info({ rows: history.length }, "history.loaded");

  if (USE_REAL_FEED) {
    await runRealFeed(history);
  } else {
    await runLocalEmulator(history);
  }
}

// ------------------------------------------------------------------
// Real TxLINE feed (devnet/mainnet)
// ------------------------------------------------------------------
async function runRealFeed(history: any[]) {
  if (TXODDS_FIXTURE_ID === 0) {
    throw new Error("USE_REAL_TXLINE=1 requires TXODDS_FIXTURE_ID env var");
  }
  const client = new TxLineClient();
  await client.startGuestSession();
  setHealth("txline", true);
  log.info({ fixtureId: TXODDS_FIXTURE_ID }, "txline.session.ready");

  let lastProbs: number[] | null = null;
  let lastUpdate = 0;

  for await (const raw of client.streamScores()) {
    metrics.txlineFetches.inc({ fixture: String(TXODDS_FIXTURE_ID) });
    if (Date.now() - lastUpdate < cfg.updateIntervalMs) continue;
    lastUpdate = Date.now();

    // The real SSE payload includes per-fixture updates. We filter to our
    // fixture and extract the live-state features the oracle expects.
    const payload = raw as any;
    if (payload?.fixtureId !== TXODDS_FIXTURE_ID) continue;

    const live = {
      minute:           payload.minute          ?? 0,
      score_diff:       payload.scoreDiff       ?? 0,
      shots_on_target:  payload.shotsOnTarget   ?? 0,
      possession:       payload.possession      ?? 50,
      corners_so_far:   payload.cornersSoFar    ?? 0,
    };

    try {
      const p = await callOracle({
        match_id:  MATCH_ID,
        stat_type: STAT_TYPE,
        bin_edges: BIN_EDGES,
        history,
        live,
        base_b:    BASE_B,
      });
      metrics.oracleCalls.inc({ match: MATCH_ID });
      metrics.lastPredictionMs.set({ match: MATCH_ID }, Date.now());
      metrics.ensembleDivergence.set({ match: MATCH_ID }, p.ensemble_divergence);

      const drift = lastProbs ? maxAbsDrift(lastProbs, p.probs_float) : Infinity;
      log.info({
        minute: live.minute, drift, div: p.ensemble_divergence,
        b: p.liquidity_b, backend: p.model_backend,
      }, "tick");

      if (drift > cfg.divergenceThreshold) {
        // TODO: wire real Anchor call — omitted here so the demo runs
        // without a deployed program. See docs/DEPLOYMENT.md for the
        // production wire-up recipe.
        metrics.predictionsSent.inc({ match: MATCH_ID });
        log.info({ new_b: p.liquidity_b }, "would.submit.update_prediction");
        lastProbs = p.probs_float;
      }
    } catch (e) {
      metrics.oracleErrors.inc();
      log.error({ err: String(e) }, "oracle.call.fail");
    }
  }
}

// ------------------------------------------------------------------
// Local emulator (localnet, hackathon demo)
// ------------------------------------------------------------------
async function runLocalEmulator(history: any[]) {
  const feed = new LocalTxLineEmulator(MATCH_ID, FINAL_CORNERS_H2);
  let lastProbs: number[] | null = null;
  let lastUpdate = 0;

  feed.on("tick", async (t: MatchTick) => {
    if (t.status !== "live" && t.status !== "half_time") return;
    if (Date.now() - lastUpdate < cfg.updateIntervalMs) return;
    lastUpdate = Date.now();

    try {
      const p = await callOracle({
        match_id:  t.match_id,
        stat_type: STAT_TYPE,
        bin_edges: BIN_EDGES,
        history,
        live:      t.live,
        base_b:    BASE_B,
      });
      metrics.oracleCalls.inc({ match: t.match_id });
      metrics.lastPredictionMs.set({ match: t.match_id }, Date.now());
      metrics.ensembleDivergence.set({ match: t.match_id }, p.ensemble_divergence);

      const drift = lastProbs ? maxAbsDrift(lastProbs, p.probs_float) : Infinity;
      log.info({
        minute: t.live.minute, drift, div: p.ensemble_divergence,
        b: p.liquidity_b, backend: p.model_backend, latency_ms: p.latency_ms,
      }, "tick");

      if (drift > cfg.divergenceThreshold) {
        metrics.predictionsSent.inc({ match: t.match_id });
        log.info({ new_b: p.liquidity_b }, "would.submit.update_prediction");
        lastProbs = p.probs_float;
      }
    } catch (e) {
      metrics.oracleErrors.inc();
      log.error({ err: String(e) }, "oracle.call.fail");
    }
  });

  feed.on("full_time", (e) => {
    metrics.settlementsSent.inc({ match: e.match_id });
    log.info({
      match_id: e.match_id, corners_h2: e.corners_h2,
    }, "full_time.settle");
  });

  feed.start(1_000);
}

function maxAbsDrift(a: number[], b: number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

process.on("uncaughtException", (e) => log.error({ err: String(e) }, "uncaughtException"));
process.on("unhandledRejection", (e) => log.error({ err: String(e) }, "unhandledRejection"));

main().catch((e) => {
  log.error({ err: String(e) }, "keeper.fatal");
  process.exit(1);
});
