import axios from "axios";
import { cfg } from "./config.js";

const Q_SCALE = 1_000_000;
const PROB_SUM_TOLERANCE = 10; // allow tiny rounding drift

export interface HistoryRow {
  minute: number;
  score_diff: number;
  shots_on_target: number;
  possession: number;
  corners_so_far: number;
  outcome_bin: number;
}

export interface LiveState {
  minute: number;
  score_diff: number;
  shots_on_target: number;
  possession: number;
  corners_so_far: number;
}

export interface PredictRequest {
  match_id: string;
  stat_type: string;
  bin_edges: number[];
  history: HistoryRow[];
  live: LiveState;
  base_b?: number;
}

export interface PredictResponse {
  match_id: string;
  probs_q6: number[];
  probs_float: number[];
  liquidity_b: number;
  ensemble_divergence: number;
  latency_ms: number;
  model_backend: string;
  n_classes: number;
}

/** Validate live tick fields before sending to the oracle. */
export function validateLiveState(live: LiveState): void {
  if (!Number.isFinite(live.minute) || live.minute < 0 || live.minute > 180) {
    throw new Error(`invalid live.minute: ${live.minute}`);
  }
  if (!Number.isFinite(live.score_diff) || live.score_diff < -20 || live.score_diff > 20) {
    throw new Error(`invalid live.score_diff: ${live.score_diff}`);
  }
  if (!Number.isFinite(live.shots_on_target) || live.shots_on_target < 0) {
    throw new Error(`invalid live.shots_on_target: ${live.shots_on_target}`);
  }
  if (!Number.isFinite(live.possession) || live.possession < 0 || live.possession > 100) {
    throw new Error(`invalid live.possession: ${live.possession}`);
  }
  if (!Number.isFinite(live.corners_so_far) || live.corners_so_far < 0) {
    throw new Error(`invalid live.corners_so_far: ${live.corners_so_far}`);
  }
}

/** Validate oracle /predict response shape and probability invariants. */
export function validatePredictResponse(
  data: PredictResponse,
  expectedClasses: number,
): PredictResponse {
  if (!data || typeof data !== "object") {
    throw new Error("oracle response: empty body");
  }
  if (!Array.isArray(data.probs_q6) || data.probs_q6.length !== expectedClasses) {
    throw new Error(
      `oracle response: probs_q6 length ${data.probs_q6?.length} != ${expectedClasses}`,
    );
  }
  for (const p of data.probs_q6) {
    if (!Number.isInteger(p) || p < 0) {
      throw new Error(`oracle response: non-negative int probs required, got ${p}`);
    }
  }
  const sum = data.probs_q6.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - Q_SCALE) > PROB_SUM_TOLERANCE) {
    throw new Error(`oracle response: probs_q6 sum ${sum} != ${Q_SCALE}`);
  }
  if (!Number.isFinite(data.liquidity_b) || data.liquidity_b <= 0) {
    throw new Error(`oracle response: liquidity_b must be > 0, got ${data.liquidity_b}`);
  }
  if (data.n_classes !== expectedClasses) {
    throw new Error(`oracle response: n_classes ${data.n_classes} != ${expectedClasses}`);
  }
  return data;
}

export async function callOracle(req: PredictRequest): Promise<PredictResponse> {
  validateLiveState(req.live);
  const expectedClasses = req.bin_edges.length - 1;
  const headers: Record<string, string> = {};
  if (cfg.oracleApiKey) {
    headers.Authorization = `Bearer ${cfg.oracleApiKey}`;
  }
  const { data } = await axios.post(`${cfg.oracleUrl}/predict`, req, {
    timeout: 15_000,
    headers,
  });
  return validatePredictResponse(data as PredictResponse, expectedClasses);
}

export async function oracleHealth(): Promise<{ ok: boolean }> {
  const { data } = await axios.get(`${cfg.oracleUrl}/healthz`, { timeout: 2_000 });
  return data;
}
