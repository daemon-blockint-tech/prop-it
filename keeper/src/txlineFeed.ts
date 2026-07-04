/**
 * txlineFeed
 * ----------
 * Ingests low-latency (8–10ms target) match tick payloads from TxLINE.
 * For the hackathon MVP we ship a local emulator that mimics the shape of
 * the real TxLINE WebSocket feed so the whole pipeline is exercised.
 */

import { EventEmitter } from "node:events";
import { LiveState } from "./oracle.js";

export interface MatchTick {
  match_id: string;
  status: "live" | "half_time" | "full_time";
  live: LiveState;
  timestamp_ms: number;
}

/**
 * Deterministic in-process emulator: 90 simulated minutes in 90s wall clock.
 * Emits `tick` events every ~1s and a final `full_time` event with the
 * definitive `corners_h2` count so keeper can trigger settlement.
 */
export class LocalTxLineEmulator extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private minute = 0;
  public matchId: string;
  public finalCornersH2: number;

  constructor(matchId: string, finalCornersH2: number) {
    super();
    this.matchId = matchId;
    this.finalCornersH2 = finalCornersH2;
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.minute = Math.min(90, this.minute + 1);
    // Simulate H2 corners linearly accumulating from minute 46 onward.
    const cornersH2Now = this.minute <= 45
      ? 0
      : Math.min(this.finalCornersH2, Math.round((this.minute - 45) / 45 * this.finalCornersH2));

    const live: LiveState = {
      minute: this.minute,
      score_diff: this.minute > 60 ? 1 : 0,
      shots_on_target: 3 + Math.floor(this.minute / 15),
      possession: 55 + (this.minute % 10),
      corners_so_far: cornersH2Now + (this.minute > 20 ? 3 : 1),
    };

    const status = this.minute >= 90
      ? "full_time"
      : this.minute === 45 ? "half_time" : "live";

    const t: MatchTick = {
      match_id: this.matchId,
      status,
      live,
      timestamp_ms: Date.now(),
    };
    this.emit("tick", t);

    if (this.minute >= 90) {
      this.emit("full_time", {
        match_id: this.matchId,
        corners_h2: this.finalCornersH2,
      });
      this.stop();
    }
  }
}
