/**
 * Tabula keeper bot
 * -----------------
 * Ties together three data sources into one on-chain effect:
 *
 *   1. TxLINE  — via TxLineClient (guest JWT / apiToken) OR the local
 *                emulator on localnet.
 *   2. TabFM   — the FastAPI oracle at ORACLE_URL.
 *   3. Solana  — signs and submits update_prediction / settlement txs via
 *                TabulaClient.
 *
 * Submission is real by default. `npm run simulate` sets KEEPER_DRY_RUN=1 to
 * drive the oracle loop without a validator for local visualisation; that is
 * an explicit simulator, not a silent no-op — the production entrypoints
 * (`npm start`, `npm run dev`) always submit and fail closed if the RPC or
 * keeper wallet is unavailable.
 *
 * Observability: structured JSON logging + Prometheus /metrics on
 * METRICS_PORT + /healthz /readyz probes.
 */

import { cfg, connection, keeperKeypair } from "./config.js";
import { callOracle, oracleHealth } from "./oracle.js";
import { LocalTxLineEmulator, MatchTick } from "./txlineFeed.js";
import { TxLineClient } from "./txlineClient.js";
import { TabulaClient, encodeFixedBytes } from "./tabulaClient.js";
import { syntheticHistory } from "./history.js";
import { log } from "./log.js";
import { metrics, setHealth, startMetricsServer } from "./metrics.js";

const MATCH_ID          = process.env.MATCH_ID  ?? "world-cup-2026-r16-arg-vs-fra";
const STAT_TYPE         = "corners_h2";
const BIN_EDGES         = [0, 3, 6, 9, 999];
const FINAL_CORNERS_H2  = Number(process.env.FINAL_CORNERS_H2 ?? 5);
const BASE_B            = 5_000_000;
const USE_REAL_FEED     = (process.env.USE_REAL_TXLINE ?? "0") === "1";
const DRY_RUN           = (process.env.KEEPER_DRY_RUN ?? "0") === "1";
const TXODDS_FIXTURE_ID = Number(process.env.TXODDS_FIXTURE_ID ?? 0);
const TXODDS_SEQ        = Number(process.env.TXODDS_SEQ ?? 0);
const TXODDS_STAT_KEY   = Number(process.env.TXODDS_STAT_KEY ?? 0);

// On-chain [u8;32] / [u8;16] encodings must match those used at create_market.
const MATCH_ID_BYTES  = encodeFixedBytes(MATCH_ID, 32);
const STAT_TYPE_BYTES = encodeFixedBytes(STAT_TYPE, 16);

/**
 * Build the on-chain client unless we are in explicit dry-run (offline
 * simulator) mode. Fails closed: a missing keeper wallet or RPC is a hard
 * error in production, never a silent skip.
 */
function buildTabula(): TabulaClient | null {
  if (DRY_RUN) {
    log.warn({}, "KEEPER_DRY_RUN=1 — offline simulator, no on-chain submission");
    return null;
  }
  const wallet = keeperKeypair();
  const client = new TabulaClient({
    connection: connection(),
    programId:  cfg.tabulaProgramId,
    usdcMint:   cfg.usdcMint,
    wallet,
  });
  log.info(
    { programId: cfg.tabulaProgramId.toBase58(), keeper: wallet.publicKey.toBase58(), pool: client.poolPda.toBase58() },
    "tabula.client.ready",
  );
  return client;
}

async function main() {
  log.info({
    cluster:     cfg.cluster,
    oracleUrl:   cfg.oracleUrl,
    rpcUrl:      cfg.rpcUrl,
    metricsPort: cfg.metricsPort,
    realTxline:  USE_REAL_FEED,
    dryRun:      DRY_RUN,
  }, "keeper.start");

  startMetricsServer();

  const tabula = buildTabula();

  try {
    const h = await oracleHealth();
    log.info({ ok: h.ok }, "oracle.health.ok");
    setHealth("oracle", true);
  } catch (e) {
    log.warn({ err: String(e) }, "oracle.health.fail");
  }

  const history = syntheticHistory(BIN_EDGES, 200, 42);
  log.info({ rows: history.length }, "history.loaded");

  if (USE_REAL_FEED) {
    await runRealFeed(history, tabula);
  } else {
    await runLocalEmulator(history, tabula);
  }
}

// ------------------------------------------------------------------
// Submit helpers (real on-chain effect)
// ------------------------------------------------------------------
async function submitPrediction(
  tabula: TabulaClient | null,
  probsQ6: number[],
  newB: number,
): Promise<void> {
  metrics.predictionsSent.inc({ match: MATCH_ID });
  if (!tabula) {
    log.info({ new_b: newB }, "dry_run.update_prediction");
    return;
  }
  const sig = await tabula.submitUpdatePrediction(MATCH_ID_BYTES, probsQ6, newB);
  log.info({ new_b: newB, sig }, "submitted.update_prediction");
}

async function submitSettlement(
  tabula: TabulaClient | null,
  statValue: number,
): Promise<void> {
  metrics.settlementsSent.inc({ match: MATCH_ID });
  if (!tabula) {
    log.info({ stat_value: statValue }, "dry_run.settle");
    return;
  }
  const sig = await tabula.settleWithAttestation({
    matchId:         MATCH_ID_BYTES,
    statType:        STAT_TYPE_BYTES,
    statValue,
    txoddsFixtureId: TXODDS_FIXTURE_ID,
    txoddsSeq:       TXODDS_SEQ,
    txoddsStatKey:   TXODDS_STAT_KEY,
  });
  log.info({ stat_value: statValue, sig }, "submitted.settle");
}

// ------------------------------------------------------------------
// Real TxLINE feed (devnet/mainnet)
// ------------------------------------------------------------------
async function runRealFeed(history: any[], tabula: TabulaClient | null) {
  if (TXODDS_FIXTURE_ID === 0) {
    throw new Error("USE_REAL_TXLINE=1 requires TXODDS_FIXTURE_ID env var");
  }
  const client = new TxLineClient();
  await client.startGuestSession();
  setHealth("txline", true);
  log.info({ fixtureId: TXODDS_FIXTURE_ID }, "txline.session.ready");

  let lastProbs: number[] | null = null;
  let lastUpdate = 0;
  let settled = false;

  for await (const raw of client.streamScores()) {
    metrics.txlineFetches.inc({ fixture: String(TXODDS_FIXTURE_ID) });
    const payload = raw as any;
    if (payload?.fixtureId !== TXODDS_FIXTURE_ID) continue;

    // Settle once the fixture reaches full time using the TxLINE-validated
    // stat value (fail closed: only settle on a value we could validate).
    const finished = payload.status === "finished" || Number(payload.minute ?? 0) >= 90;
    if (finished && !settled) {
      try {
        const statValue = await resolveFinalStat(client, payload);
        await submitSettlement(tabula, statValue);
        settled = true;
      } catch (e) {
        metrics.txlineErrors.inc();
        log.error({ err: String(e) }, "settle.fail");
      }
      continue;
    }

    if (Date.now() - lastUpdate < cfg.updateIntervalMs) continue;
    lastUpdate = Date.now();

    const live = {
      minute:           Number(payload.minute          ?? 0),
      score_diff:       Number(payload.scoreDiff       ?? 0),
      shots_on_target:  Number(payload.shotsOnTarget   ?? 0),
      possession:       Number(payload.possession      ?? 50),
      corners_so_far:   Number(payload.cornersSoFar    ?? 0),
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
        await submitPrediction(tabula, p.probs_q6, p.liquidity_b);
        lastProbs = p.probs_float;
      }
    } catch (e) {
      metrics.oracleErrors.inc();
      log.error({ err: String(e) }, "oracle.call.fail");
    }
  }
}

/**
 * Resolve the definitive full-time stat value from TxLINE. Prefers the
 * validated stat-validation endpoint (Merkle-backed) and falls back to the
 * live payload's final count when a seq/statKey are not configured.
 */
async function resolveFinalStat(client: TxLineClient, payload: any): Promise<number> {
  if (TXODDS_SEQ > 0 && TXODDS_STAT_KEY > 0) {
    const v = await client.fetchStatValidation({
      fixtureId: TXODDS_FIXTURE_ID,
      seq:       TXODDS_SEQ,
      statKey:   TXODDS_STAT_KEY,
    });
    return Number(v.statToProve.statValue);
  }
  const fallback = Number(payload.cornersH2 ?? payload.cornersSoFar);
  if (!Number.isFinite(fallback)) {
    throw new Error("no validated stat and no fallback value in payload");
  }
  return fallback;
}

// ------------------------------------------------------------------
// Local emulator (localnet)
// ------------------------------------------------------------------
async function runLocalEmulator(history: any[], tabula: TabulaClient | null) {
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
        await submitPrediction(tabula, p.probs_q6, p.liquidity_b);
        lastProbs = p.probs_float;
      }
    } catch (e) {
      metrics.oracleErrors.inc();
      log.error({ err: String(e) }, "oracle.call.fail");
    }
  });

  feed.on("full_time", async (e) => {
    try {
      await submitSettlement(tabula, e.corners_h2);
      log.info({ match_id: e.match_id, corners_h2: e.corners_h2 }, "full_time.settled");
    } catch (err) {
      log.error({ err: String(err) }, "settle.fail");
    }
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
