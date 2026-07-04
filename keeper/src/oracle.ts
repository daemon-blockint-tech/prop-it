import axios from "axios";
import { cfg } from "./config.js";

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

export async function callOracle(req: PredictRequest): Promise<PredictResponse> {
  const { data } = await axios.post(`${cfg.oracleUrl}/predict`, req, { timeout: 15_000 });
  return data as PredictResponse;
}

export async function oracleHealth(): Promise<{ ok: boolean; backend: string }> {
  const { data } = await axios.get(`${cfg.oracleUrl}/health`, { timeout: 2_000 });
  return data;
}
