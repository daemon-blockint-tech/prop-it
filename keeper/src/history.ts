/**
 * Synthetic historical context for TabFM in-context learning.
 * In production this is served by TxLINE's historical archive
 * (>5M fixtures per the arch doc). Here we generate a stable
 * pseudo-random panel that keeps demos reproducible.
 */

import { HistoryRow } from "./oracle.js";

export function syntheticHistory(binEdges: number[], n = 200, seed = 42): HistoryRow[] {
  const rng = mulberry32(seed);
  const rows: HistoryRow[] = [];
  for (let i = 0; i < n; i++) {
    const corners_h2 = Math.floor(rng() * 11); // 0..10
    const shots_on_target = 3 + Math.floor(rng() * 8);
    const possession = 40 + Math.floor(rng() * 25);
    const score_diff = Math.floor(rng() * 3) - 1;
    const corners_so_far = Math.floor(rng() * 5);
    const bin = binToIdx(corners_h2, binEdges);
    rows.push({
      minute: 45,
      score_diff,
      shots_on_target,
      possession,
      corners_so_far,
      outcome_bin: bin,
    });
  }
  return rows;
}

export function binToIdx(value: number, edges: number[]): number {
  for (let i = 0; i < edges.length - 1; i++) {
    if (value >= edges[i] && value < edges[i + 1]) return i;
  }
  return edges.length - 2;
}

function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
