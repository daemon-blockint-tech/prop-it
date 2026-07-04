/**
 * Prometheus-style /metrics + /healthz endpoint. Zero dependencies so the
 * keeper stays a lean single-process binary.
 */
import http from "node:http";
import { cfg } from "./config.js";
import { log } from "./log.js";

type Labels = Record<string, string>;

class Counter {
  private m = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  inc(labels: Labels = {}, n = 1) {
    const k = JSON.stringify(labels);
    this.m.set(k, (this.m.get(k) ?? 0) + n);
  }
  render(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.m) {
      const labels = JSON.parse(k) as Labels;
      const l = Object.entries(labels).map(([k2, v2]) => `${k2}="${v2}"`).join(",");
      out.push(`${this.name}${l ? `{${l}}` : ""} ${v}`);
    }
    return out.join("\n");
  }
}

class Gauge {
  private m = new Map<string, number>();
  constructor(public name: string, public help: string) {}
  set(labels: Labels, v: number) { this.m.set(JSON.stringify(labels), v); }
  render(): string {
    const out: string[] = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [k, v] of this.m) {
      const labels = JSON.parse(k) as Labels;
      const l = Object.entries(labels).map(([k2, v2]) => `${k2}="${v2}"`).join(",");
      out.push(`${this.name}${l ? `{${l}}` : ""} ${v}`);
    }
    return out.join("\n");
  }
}

export const metrics = {
  oracleCalls:     new Counter("tabula_oracle_calls_total",     "Number of oracle /predict calls"),
  oracleErrors:    new Counter("tabula_oracle_errors_total",    "Number of oracle call errors"),
  predictionsSent: new Counter("tabula_predictions_sent_total", "update_prediction tx sent"),
  settlementsSent: new Counter("tabula_settlements_sent_total", "settle_via_txline tx sent"),
  txlineFetches:   new Counter("tabula_txline_fetch_total",     "TxLINE REST/SSE fetches"),
  txlineErrors:    new Counter("tabula_txline_errors_total",    "TxLINE REST/SSE errors"),
  lastPredictionMs: new Gauge("tabula_last_prediction_ms",      "Timestamp (ms) of last oracle prediction"),
  ensembleDivergence: new Gauge("tabula_ensemble_divergence",   "Latest TabFM ensemble divergence, per market"),
} as const;

let health = { oracle: false, rpc: false, txline: false };
export function setHealth(k: keyof typeof health, v: boolean) { health[k] = v; }

export function startMetricsServer() {
  const srv = http.createServer((req, res) => {
    if (req.url === "/metrics") {
      const body = [
        metrics.oracleCalls,
        metrics.oracleErrors,
        metrics.predictionsSent,
        metrics.settlementsSent,
        metrics.txlineFetches,
        metrics.txlineErrors,
        metrics.lastPredictionMs,
        metrics.ensembleDivergence,
      ].map(m => m.render()).join("\n\n");
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(body + "\n");
      return;
    }
    if (req.url === "/healthz" || req.url === "/livez") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (req.url === "/readyz") {
      const ok = health.oracle && health.rpc;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ready: ok, ...health }));
      return;
    }
    res.writeHead(404).end();
  });
  srv.listen(cfg.metricsPort, () => {
    log.info({ port: cfg.metricsPort }, "metrics.server.up");
  });
  return srv;
}
