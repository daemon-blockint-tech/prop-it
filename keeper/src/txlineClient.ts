/**
 * txlineClient
 * ------------
 * Real client for the TxLINE REST + SSE API published by TxODDS.
 *
 * Auth flow (per https://txline.txodds.com/documentation/quickstart):
 *   1. POST /auth/guest/start                      -> guest JWT (30-day)
 *   2. On-chain `subscribe(service_level, weeks)`  -> pays TxL, obtains signature
 *   3. POST /api/token/activate {txSig, walletSignature, leagues}
 *                                                  -> API token (X-Api-Token)
 *
 * For the hackathon devnet flow we default to the free World Cup service
 * levels (1 or 12) which do not require a subscribe transaction. In that
 * case we skip step 2 and directly hit /api/scores/... with the guest JWT.
 */
import { cfg } from "./config.js";
import { log } from "./log.js";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------
export interface GuestSessionResponse {
  jwt: string;
  expiresAt: string; // ISO
}

export interface StatValidationResponse {
  summary: {
    fixtureId: number;
    updateStats: {
      updateCount: number;
      minTimestamp: number;
      maxTimestamp: number;
    };
    eventStatsSubTreeRoot: string;
  };
  subTreeProof:  Array<{ hash: string; isRightSibling: boolean }>;
  mainTreeProof: Array<{ hash: string; isRightSibling: boolean }>;
  eventStatRoot: string;
  statProof:     Array<{ hash: string; isRightSibling: boolean }>;
  statToProve: {
    seq:        number;
    statKey:    number;
    statValue:  number;
    timestamp:  number;
  };
}

export interface ScoresSnapshot {
  fixtureId: number;
  updates: Array<{
    seq:       number;
    timestamp: number;
    stats: Record<string, number>;
  }>;
}

// ------------------------------------------------------------------
// TxLineClient
// ------------------------------------------------------------------
export class TxLineClient {
  private jwt:      string | null = null;
  private apiToken: string | null = null;
  private jwtExpiry = 0;

  constructor(
    public readonly apiBase:      string = cfg.txlineApiBase,
    public readonly guestAuthUrl: string = cfg.txlineGuestAuth,
    public readonly walletName:   string = cfg.txlineWalletName,
  ) {}

  // ------------------------------------------------------------------
  // Auth
  // ------------------------------------------------------------------
  async startGuestSession(): Promise<GuestSessionResponse> {
    log.info({ url: this.guestAuthUrl }, "txline.guest.start");
    const res = await fetch(this.guestAuthUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ wallet_name: this.walletName }),
    });
    if (!res.ok) {
      throw new Error(`TxLINE guest-start failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json() as GuestSessionResponse;
    this.jwt       = body.jwt;
    this.jwtExpiry = Date.parse(body.expiresAt);
    return body;
  }

  /**
   * Activate an API token AFTER an on-chain `subscribe` transaction has
   * confirmed on the TxLINE `txoracle` program. Only required for paid
   * service levels — free tiers (World Cup levels 1 / 12) work with the
   * guest JWT alone.
   */
  async activateApiToken(params: {
    txSig:            string;
    walletSignature: string;
    leagues:          string[];
  }): Promise<string> {
    if (!this.jwt) throw new Error("Call startGuestSession() first");
    const res = await fetch(`${this.apiBase}/token/activate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.jwt}`,
      },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      throw new Error(`TxLINE activate failed: ${res.status} ${await res.text()}`);
    }
    const { apiToken } = await res.json() as { apiToken: string };
    this.apiToken = apiToken;
    return apiToken;
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  private authHeaders(): Record<string, string> {
    if (!this.jwt) throw new Error("Not authenticated (call startGuestSession)");
    const h: Record<string, string> = { "Authorization": `Bearer ${this.jwt}` };
    if (this.apiToken) h["X-Api-Token"] = this.apiToken;
    return h;
  }

  async fetchScoresSnapshot(fixtureId: number, asOf: number = Date.now()): Promise<ScoresSnapshot> {
    const url = `${this.apiBase}/scores/snapshot/${fixtureId}?asOf=${asOf}`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`Snapshot fetch failed (${fixtureId}): ${res.status}`);
    }
    return await res.json() as ScoresSnapshot;
  }

  async fetchStatValidation(params: {
    fixtureId: number;
    seq:       number;
    statKey:   number;
    statKey2?: number;
  }): Promise<StatValidationResponse> {
    const q = new URLSearchParams();
    q.set("fixtureId", String(params.fixtureId));
    q.set("seq",       String(params.seq));
    q.set("statKey",   String(params.statKey));
    if (params.statKey2 != null) q.set("statKey2", String(params.statKey2));

    const url = `${this.apiBase}/scores/stat-validation?${q.toString()}`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`stat-validation failed: ${res.status} ${await res.text()}`);
    }
    return await res.json() as StatValidationResponse;
  }

  /**
   * Stream real-time score updates for the connected leagues.
   * Returns an async iterator that yields raw SSE payloads.
   */
  async *streamScores(): AsyncGenerator<unknown> {
    const url = `${this.apiBase}/scores/stream`;
    const res = await fetch(url, {
      headers: {
        ...this.authHeaders(),
        Accept:          "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
    if (!res.ok || !res.body) {
      throw new Error(`stream failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = raw.split("\n").find(l => l.startsWith("data:"));
        if (dataLine) {
          try { yield JSON.parse(dataLine.slice(5).trim()); }
          catch { /* keep-alive or malformed */ }
        }
      }
    }
  }
}
