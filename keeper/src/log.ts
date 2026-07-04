/**
 * Minimal structured logger. Emits pretty text in dev, single-line JSON
 * when JSON_LOGS=1 (production). Redacts values that look like JWTs, API
 * tokens, or Solana secret keys before serializing.
 */
import { cfg } from "./config.js";

const SECRET_RE = /(eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}|sk-[A-Za-z0-9]{20,}|(?:[A-HJ-NP-Za-km-z1-9]{60,})|"secretKey"\s*:\s*\[[^\]]+\]|Bearer\s+[A-Za-z0-9_\-\.]+|apiToken["']?\s*[:=]\s*["']?[A-Za-z0-9_\-\.]+|X-Api-Token["']?\s*[:=]\s*["']?[A-Za-z0-9_\-\.]+)/gi;

function redact(s: string): string {
  return s.replace(SECRET_RE, "[REDACTED]");
}

function emit(level: "info" | "warn" | "error" | "debug", obj: Record<string, unknown>, msg?: string) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    ...(msg ? { msg } : {}),
    ...obj,
  };
  const line = redact(JSON.stringify(payload));
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (cfg.jsonLogs) {
    stream.write(line + "\n");
  } else {
    const prefix = `[${payload.ts}] ${level.toUpperCase().padEnd(5)}`;
    const rest = { ...obj };
    stream.write(`${prefix} ${msg ?? ""} ${Object.keys(rest).length ? redact(JSON.stringify(rest)) : ""}\n`);
  }
}

export const log = {
  info:  (obj: Record<string, unknown> = {}, msg?: string) => emit("info",  obj, msg),
  warn:  (obj: Record<string, unknown> = {}, msg?: string) => emit("warn",  obj, msg),
  error: (obj: Record<string, unknown> = {}, msg?: string) => emit("error", obj, msg),
  debug: (obj: Record<string, unknown> = {}, msg?: string) => {
    if (process.env.LOG_LEVEL === "debug") emit("debug", obj, msg);
  },
};
