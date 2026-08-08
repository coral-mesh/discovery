import type { Env, ColonyRecord, AgentRecord, EndpointRecord, Config } from "./types";
import { parseConfig } from "./types";
import { createLogger, parseLogLevel, type Logger } from "./logger";
import { base64ToBytes, sha256Hex, constantTimeEqualHex, generateRecordID } from "./bytes";
import { probeReachability, splitHostPort } from "./probe";
import { acquireProbeQuota, releaseProbeQuota } from "./quota";

/**
 * SQL schema for the registry.
 */
const SCHEMA = `
-- Colonies table.
CREATE TABLE IF NOT EXISTS colonies (
  mesh_id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  endpoints TEXT NOT NULL,
  mesh_ipv4 TEXT,
  mesh_ipv6 TEXT,
  connect_port INTEGER,
  public_port INTEGER,
  metadata TEXT,
  observed_endpoint TEXT,
  public_endpoint TEXT,
  nat_hint INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Agents table.
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  pubkey TEXT NOT NULL,
  endpoints TEXT NOT NULL,
  observed_endpoint TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Bootstrap rendezvous records (RFD 108 - PSK-Encrypted Rendezvous for
-- NAT-Traversing Agent Bootstrap). Opaque to this service: ciphertext and
-- gcm_nonce are AEAD output this service cannot decrypt, keyed only by the
-- already-public mesh_id. write_token_hash is the only thing checked here;
-- the raw write_token is never persisted.
CREATE TABLE IF NOT EXISTS bootstrap_rendezvous (
  record_id TEXT PRIMARY KEY,
  mesh_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  gcm_nonce TEXT NOT NULL,
  write_token_hash TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Indexes for efficient queries.
CREATE INDEX IF NOT EXISTS idx_agents_mesh_id ON agents(mesh_id);
CREATE INDEX IF NOT EXISTS idx_colonies_expires ON colonies(expires_at);
CREATE INDEX IF NOT EXISTS idx_agents_expires ON agents(expires_at);
CREATE INDEX IF NOT EXISTS idx_rendezvous_mesh_id ON bootstrap_rendezvous(mesh_id);
CREATE INDEX IF NOT EXISTS idx_rendezvous_expires ON bootstrap_rendezvous(expires_at);
`;

/** Rendezvous publish: max TTL Discovery will honor, in seconds. */
const RENDEZVOUS_MAX_TTL_SECONDS = 90;
/** Rendezvous publish: max long-poll wait Discovery will honor, in seconds. */
const RENDEZVOUS_MAX_POLL_WAIT_SECONDS = 25;
/** Per-mesh_id token bucket for PublishBootstrapRendezvous. */
const RENDEZVOUS_PUBLISH_RATE_PER_MINUTE = 5;
const RENDEZVOUS_PUBLISH_BURST = 10;
/** Per-mesh_id token bucket for PollBootstrapRendezvous — generous, since a
 * legitimate long-poll loop reissues roughly once per wait window, but
 * still bounds a tight client retry loop on disconnect. */
const RENDEZVOUS_POLL_RATE_PER_MINUTE = 30;
const RENDEZVOUS_POLL_BURST = 10;

/**
 * Error codes for Connect protocol.
 */
export const ConnectErrorCode = {
  InvalidArgument: 3,
  NotFound: 5,
  AlreadyExists: 6,
  PermissionDenied: 7,
  ResourceExhausted: 8,
  Unimplemented: 12,
  Internal: 13,
} as const;

/**
 * Custom error for Connect protocol.
 */
export class ConnectError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    /** Seconds to wait before retrying, surfaced as Retry-After on 429s. */
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ConnectError";
  }
}

/**
 * ColonyRegistry Durable Object.
 * Manages colony and agent registrations using SQLite storage.
 */
export class ColonyRegistry implements DurableObject {
  private sql: SqlStorage;
  private config: Config;
  private startTime: number;
  private log: Logger;
  private colonyCache = new Map<string, { data: any; expiresAt: number }>();
  private agentCache = new Map<string, { data: any; expiresAt: number }>();

  // RFD 108: resolvers waiting on a rendezvous publish for a given mesh_id.
  // Since every request for a given mesh_id lands on this same DO instance
  // (sharded by mesh_id), in-memory event coordination is exact — no
  // separate pub/sub or polling loop needed.
  private rendezvousWaiters = new Map<string, Array<() => void>>();
  // RFD 108: per-mesh_id token buckets for publish/poll rate limiting.
  private rendezvousRateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private ctx: DurableObjectState,
    private env: Env
  ) {
    this.sql = ctx.storage.sql;
    this.config = parseConfig(env);
    this.startTime = Date.now();
    this.log = createLogger(parseLogLevel(env.LOG_LEVEL));

    // Initialize schema.
    this.initSchema();

    // Schedule initial cleanup alarm.
    ctx.blockConcurrencyWhile(async () => {
      const alarm = await ctx.storage.getAlarm();
      if (alarm === null) {
        await ctx.storage.setAlarm(Date.now() + this.config.cleanupIntervalMs);
      }
    });
  }

  /**
   * Initialize the database schema.
   */
  private initSchema(): void {
    this.sql.exec(SCHEMA);
  }

  /**
   * Handle incoming requests.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route internal API calls.
      if (path === "/register-colony") {
        return await this.handleRegisterColony(request);
      } else if (path === "/lookup-colony") {
        return await this.handleLookupColony(request);
      } else if (path === "/register-agent") {
        return await this.handleRegisterAgent(request);
      } else if (path === "/lookup-agent") {
        return await this.handleLookupAgent(request);
      } else if (path === "/health") {
        return this.handleHealth();
      } else if (path === "/count") {
        return this.handleCount();
      } else if (path === "/publish-bootstrap-rendezvous") {
        return await this.handlePublishBootstrapRendezvous(request);
      } else if (path === "/poll-bootstrap-rendezvous") {
        return await this.handlePollBootstrapRendezvous(request);
      } else if (path === "/ack-bootstrap-rendezvous") {
        return await this.handleAckBootstrapRendezvous(request);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      if (err instanceof ConnectError) {
        return Response.json(
          { error: err.message, code: err.code, retryAfterSeconds: err.retryAfterSeconds },
          { status: 400 }
        );
      }
      this.log.error("Registry error:", err);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  }

  /**
   * Alarm handler for periodic cleanup.
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    // Delete expired entries and get counts via changes().
    this.sql.exec(`DELETE FROM colonies WHERE expires_at < ?`, now);
    const coloniesDeleted = this.sql.exec<{ c: number }>(`SELECT changes() as c`).toArray()[0]?.c || 0;
    this.sql.exec(`DELETE FROM agents WHERE expires_at < ?`, now);
    const agentsDeleted = this.sql.exec<{ c: number }>(`SELECT changes() as c`).toArray()[0]?.c || 0;
    this.sql.exec(`DELETE FROM bootstrap_rendezvous WHERE expires_at < ?`, now);
    const rendezvousDeleted = this.sql.exec<{ c: number }>(`SELECT changes() as c`).toArray()[0]?.c || 0;

    if (coloniesDeleted > 0 || agentsDeleted > 0 || rendezvousDeleted > 0) {
      this.log.info(
        `[Registry] Cleanup: expired colonies=${coloniesDeleted}, expired agents=${agentsDeleted}, expired rendezvous=${rendezvousDeleted}`
      );
      // Invalidate caches on cleanup.
      this.colonyCache.clear();
      this.agentCache.clear();
    }

    // Emit metrics to the global metrics DO.
    try {
      if (this.env.DISCOVERY_METRICS) {
        const metricsId = this.env.DISCOVERY_METRICS.idFromName("global");
        const metrics = this.env.DISCOVERY_METRICS.get(metricsId);
        await metrics.fetch(
          new Request("http://internal/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-DO-Id": this.ctx.id.toString() },
            body: JSON.stringify({
              expiredColonies: coloniesDeleted,
              expiredAgents: agentsDeleted,
            }),
          })
        );
      }
    } catch (err) {
      this.log.warn("[Registry] Failed to report metrics:", err);
    }

    // Schedule next cleanup.
    await this.ctx.storage.setAlarm(Date.now() + this.config.cleanupIntervalMs);
  }

  /**
   * Register a colony.
   */
  private async handleRegisterColony(request: Request): Promise<Response> {
    const body = await request.json() as {
      meshId: string;
      pubkey: string;
      endpoints: string[];
      meshIpv4?: string;
      meshIpv6?: string;
      connectPort?: number;
      publicPort?: number;
      metadata?: Record<string, string>;
      observedEndpoint?: EndpointRecord;
      publicEndpoint?: {
        enabled: boolean;
        url?: string;
        caCert?: string;
        caFingerprint?: { algorithm: number; value: string };
        updatedAt?: number;
      };
      observedIP?: string;
    };

    this.log.info(`[Registry] RegisterColony: meshId=${body.meshId}, endpoints=${body.endpoints?.length || 0}, publicPort=${body.publicPort}`);

    // Validate required fields.
    if (!body.meshId) {
      throw new ConnectError("mesh_id is required", ConnectErrorCode.InvalidArgument);
    }
    if (!body.pubkey) {
      throw new ConnectError("pubkey is required", ConnectErrorCode.InvalidArgument);
    }
    if ((!body.endpoints || body.endpoints.length === 0) && !body.observedEndpoint) {
      throw new ConnectError("at least one endpoint or observed_endpoint is required", ConnectErrorCode.InvalidArgument);
    }

    const now = Date.now();
    const expiresAt = now + this.config.defaultTTLSeconds * 1000;

    // Check for split-brain (existing registration with different pubkey).
    // This uses the PRIMARY KEY index on mesh_id, so it's a single-row lookup.
    const existingPubkey = this.sql
      .exec<{ pubkey: string }>(
        `SELECT pubkey FROM colonies WHERE mesh_id = ? LIMIT 1`,
        body.meshId
      )
      .toArray();

    if (existingPubkey.length > 0 && existingPubkey[0].pubkey !== body.pubkey) {
      throw new ConnectError(
        `mesh_id ${body.meshId} already registered with different pubkey`,
        ConnectErrorCode.AlreadyExists
      );
    }

    // Determine observed endpoint.
    let observedEndpoint = body.observedEndpoint;
    if (body.observedIP && (!observedEndpoint || isPrivateIP(observedEndpoint.ip))) {
      observedEndpoint = {
        ip: body.observedIP,
        port: observedEndpoint?.port || 0,
        protocol: "udp",
      };
    }

    // Upsert colony using INSERT OR REPLACE to avoid extra SELECT.
    this.sql.exec(
      `INSERT OR REPLACE INTO colonies (
        mesh_id, pubkey, endpoints, mesh_ipv4, mesh_ipv6,
        connect_port, public_port, metadata, observed_endpoint,
        public_endpoint, nat_hint, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT created_at FROM colonies WHERE mesh_id = ?), ?),
        ?, ?)`,
      body.meshId,
      body.pubkey,
      JSON.stringify(body.endpoints || []),
      body.meshIpv4 || null,
      body.meshIpv6 || null,
      body.connectPort || null,
      body.publicPort || null,
      body.metadata ? JSON.stringify(body.metadata) : null,
      observedEndpoint ? JSON.stringify(observedEndpoint) : null,
      body.publicEndpoint ? JSON.stringify(body.publicEndpoint) : null,
      0, // nat_hint
      body.meshId, // for COALESCE subquery
      now, // fallback created_at
      now, // updated_at
      expiresAt
    );

    // Update cache.
    this.colonyCache.delete(body.meshId);

    this.log.info(`[Registry] RegisterColony SUCCESS: meshId=${body.meshId}, expiresAt=${new Date(expiresAt).toISOString()}`);

    return Response.json({
      success: true,
      ttl: this.config.defaultTTLSeconds,
      expiresAt: Math.floor(expiresAt / 1000),
      observedEndpoint: observedEndpoint,
    });
  }

  /**
   * Lookup a colony.
   */
  private async handleLookupColony(request: Request): Promise<Response> {
    const body = await request.json() as { meshId: string };

    this.log.info(`[Registry] LookupColony: meshId=${body.meshId}`);

    if (!body.meshId) {
      throw new ConnectError("mesh_id is required", ConnectErrorCode.InvalidArgument);
    }

    const now = Date.now();

    // Check in-memory cache first.
    const cached = this.colonyCache.get(body.meshId);
    if (cached && cached.expiresAt >= now) {
      this.log.info(`[Registry] LookupColony: meshId=${body.meshId}, found=true (cached)`);
      return Response.json(cached.data);
    }

    const rows = this.sql
      .exec<{
        mesh_id: string;
        pubkey: string;
        endpoints: string;
        mesh_ipv4: string | null;
        mesh_ipv6: string | null;
        connect_port: number | null;
        public_port: number | null;
        metadata: string | null;
        observed_endpoint: string | null;
        public_endpoint: string | null;
        nat_hint: number;
        updated_at: number;
        expires_at: number;
      }>(
        `SELECT mesh_id, pubkey, endpoints, mesh_ipv4, mesh_ipv6, connect_port, public_port, metadata, observed_endpoint, public_endpoint, nat_hint, updated_at, expires_at FROM colonies WHERE mesh_id = ? AND expires_at >= ? LIMIT 1`,
        body.meshId,
        now
      )
      .toArray();

    this.log.info(`[Registry] LookupColony: meshId=${body.meshId}, found=${rows.length > 0}`);

    if (rows.length === 0) {
      throw new ConnectError(`colony ${body.meshId} not found`, ConnectErrorCode.NotFound);
    }

    const row = rows[0];
    const observedEndpoints: EndpointRecord[] = [];
    if (row.observed_endpoint) {
      observedEndpoints.push(JSON.parse(row.observed_endpoint));
    }

    const response = {
      meshId: row.mesh_id,
      pubkey: row.pubkey,
      endpoints: JSON.parse(row.endpoints),
      meshIpv4: row.mesh_ipv4 || undefined,
      meshIpv6: row.mesh_ipv6 || undefined,
      connectPort: row.connect_port || undefined,
      publicPort: row.public_port || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      lastSeen: Math.floor(row.updated_at / 1000),
      observedEndpoints,
      nat: row.nat_hint,
      publicEndpoint: row.public_endpoint ? JSON.parse(row.public_endpoint) : undefined,
    };

    // Cache the result.
    this.colonyCache.set(body.meshId, { data: response, expiresAt: row.expires_at });

    return Response.json(response);
  }

  /**
   * Register an agent.
   */
  private async handleRegisterAgent(request: Request): Promise<Response> {
    const body = await request.json() as {
      agentId: string;
      meshId: string;
      pubkey: string;
      endpoints: string[];
      observedEndpoint?: EndpointRecord;
      metadata?: Record<string, string>;
      observedIP?: string;
    };

    this.log.info(`[Registry] RegisterAgent: agentId=${body.agentId}, meshId=${body.meshId}, endpoints=${body.endpoints?.length || 0}`);

    // Validate required fields.
    if (!body.agentId) {
      throw new ConnectError("agent_id is required", ConnectErrorCode.InvalidArgument);
    }
    if (!body.meshId) {
      throw new ConnectError("mesh_id is required", ConnectErrorCode.InvalidArgument);
    }
    if (!body.pubkey) {
      throw new ConnectError("pubkey is required", ConnectErrorCode.InvalidArgument);
    }
    if ((!body.endpoints || body.endpoints.length === 0) && !body.observedEndpoint) {
      throw new ConnectError("at least one endpoint or observed_endpoint is required", ConnectErrorCode.InvalidArgument);
    }

    const now = Date.now();
    const expiresAt = now + this.config.defaultTTLSeconds * 1000;

    // Determine observed endpoint.
    let observedEndpoint = body.observedEndpoint;
    if (body.observedIP && (!observedEndpoint || isPrivateIP(observedEndpoint.ip))) {
      observedEndpoint = {
        ip: body.observedIP,
        port: observedEndpoint?.port || 0,
        protocol: "udp",
      };
    }

    // Upsert agent.
    this.sql.exec(
      `INSERT OR REPLACE INTO agents (
        agent_id, mesh_id, pubkey, endpoints, observed_endpoint,
        metadata, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM agents WHERE agent_id = ?), ?), ?, ?)`,
      body.agentId,
      body.meshId,
      body.pubkey,
      JSON.stringify(body.endpoints || []),
      observedEndpoint ? JSON.stringify(observedEndpoint) : null,
      body.metadata ? JSON.stringify(body.metadata) : null,
      body.agentId,
      now,
      now,
      expiresAt
    );

    // Invalidate cache.
    this.agentCache.delete(body.agentId);

    this.log.info(`[Registry] RegisterAgent SUCCESS: agentId=${body.agentId}, meshId=${body.meshId}, expiresAt=${new Date(expiresAt).toISOString()}`);

    return Response.json({
      success: true,
      ttl: this.config.defaultTTLSeconds,
      expiresAt: Math.floor(expiresAt / 1000),
      observedEndpoint: observedEndpoint,
    });
  }

  /**
   * Lookup an agent.
   */
  private async handleLookupAgent(request: Request): Promise<Response> {
    const body = await request.json() as { agentId: string };

    this.log.info(`[Registry] LookupAgent: agentId=${body.agentId}`);

    if (!body.agentId) {
      throw new ConnectError("agent_id is required", ConnectErrorCode.InvalidArgument);
    }

    const now = Date.now();

    // Check in-memory cache first.
    const cached = this.agentCache.get(body.agentId);
    if (cached && cached.expiresAt >= now) {
      this.log.info(`[Registry] LookupAgent: agentId=${body.agentId}, found=true (cached)`);
      return Response.json(cached.data);
    }

    const rows = this.sql
      .exec<{
        agent_id: string;
        mesh_id: string;
        pubkey: string;
        endpoints: string;
        observed_endpoint: string | null;
        metadata: string | null;
        updated_at: number;
        expires_at: number;
      }>(
        `SELECT agent_id, mesh_id, pubkey, endpoints, observed_endpoint, metadata, updated_at, expires_at FROM agents WHERE agent_id = ? AND expires_at >= ? LIMIT 1`,
        body.agentId,
        now
      )
      .toArray();

    if (rows.length === 0) {
      throw new ConnectError(`agent ${body.agentId} not found`, ConnectErrorCode.NotFound);
    }

    const row = rows[0];
    const observedEndpoints: EndpointRecord[] = [];
    if (row.observed_endpoint) {
      observedEndpoints.push(JSON.parse(row.observed_endpoint));
    }

    const response = {
      agentId: row.agent_id,
      meshId: row.mesh_id,
      pubkey: row.pubkey,
      endpoints: JSON.parse(row.endpoints),
      observedEndpoints,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      lastSeen: Math.floor(row.updated_at / 1000),
    };

    // Cache the result.
    this.agentCache.set(body.agentId, { data: response, expiresAt: row.expires_at });

    return Response.json(response);
  }

  /**
   * Check and consume one token from a per-key token bucket, throwing
   * ResourceExhausted if none are available. Buckets live in memory on this
   * DO instance, which is exactly right here: every request for a given
   * mesh_id already lands on this same instance, so no cross-instance
   * consistency is needed.
   */
  private checkRendezvousRateLimit(key: string, ratePerMinute: number, burst: number): void {
    const now = Date.now();
    let bucket = this.rendezvousRateBuckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, lastRefill: now };
      this.rendezvousRateBuckets.set(key, bucket);
    }
    const elapsedMinutes = (now - bucket.lastRefill) / 60_000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedMinutes * ratePerMinute);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / (ratePerMinute / 60)));
      throw new ConnectError("rate limit exceeded", ConnectErrorCode.ResourceExhausted, retryAfterSeconds);
    }
    bucket.tokens -= 1;
  }

  /**
   * Wake any PollBootstrapRendezvous calls currently long-polling this
   * mesh_id.
   */
  private notifyRendezvousWaiters(meshId: string): void {
    const waiters = this.rendezvousWaiters.get(meshId);
    if (!waiters) return;
    this.rendezvousWaiters.delete(meshId);
    for (const resolve of waiters) resolve();
  }

  /**
   * Query all non-expired rendezvous records for a mesh_id, in
   * ProtoJSON-shaped form. Never includes write_token or its hash.
   */
  private queryRendezvousRecords(meshId: string): Array<{
    recordId: string;
    ciphertext: string;
    gcmNonce: string;
    publishedAt: string;
  }> {
    const rows = this.sql
      .exec<{ record_id: string; ciphertext: string; gcm_nonce: string; published_at: number }>(
        `SELECT record_id, ciphertext, gcm_nonce, published_at FROM bootstrap_rendezvous WHERE mesh_id = ? AND expires_at > ?`,
        meshId,
        Date.now()
      )
      .toArray();

    return rows.map((row) => ({
      recordId: row.record_id,
      ciphertext: row.ciphertext,
      gcmNonce: row.gcm_nonce,
      publishedAt: new Date(row.published_at).toISOString(),
    }));
  }

  /**
   * Handle PublishBootstrapRendezvous RPC (RFD 108).
   */
  private async handlePublishBootstrapRendezvous(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      meshId: string;
      ciphertext: string; // base64
      gcmNonce: string; // base64
      ttlSeconds?: number;
      probeEndpoint?: string;
      recordId?: string;
      writeToken: string; // base64
      verifyReachability?: boolean;
      clientIP?: string;
    };

    this.log.info(
      `[Registry] PublishBootstrapRendezvous: meshId=${body.meshId}, recordId=${body.recordId || "(new)"}, verifyReachability=${!!body.verifyReachability}`
    );

    if (!body.meshId) {
      throw new ConnectError("mesh_id is required", ConnectErrorCode.InvalidArgument);
    }
    if (!body.ciphertext) {
      throw new ConnectError("ciphertext is required", ConnectErrorCode.InvalidArgument);
    }
    if (!body.gcmNonce) {
      throw new ConnectError("gcm_nonce is required", ConnectErrorCode.InvalidArgument);
    }
    if (!body.writeToken) {
      throw new ConnectError("write_token is required", ConnectErrorCode.InvalidArgument);
    }

    // Covers both storage writes and probe attempts, when probing is requested.
    this.checkRendezvousRateLimit(
      `publish:${body.meshId}`,
      RENDEZVOUS_PUBLISH_RATE_PER_MINUTE,
      RENDEZVOUS_PUBLISH_BURST
    );

    // Opt-in reachability probe. Discovery never gates publish on this by
    // default — see probe.ts and RFD 108 Security Model item 9.
    if (body.verifyReachability) {
      const target = body.probeEndpoint || "";
      const clientIP = body.clientIP || "unknown";

      const quota = await acquireProbeQuota(this.env, clientIP, target);
      if (!quota.allowed) {
        throw new ConnectError(
          `reachability probe quota exceeded (${quota.reason})`,
          ConnectErrorCode.ResourceExhausted,
          60
        );
      }
      let reachable: boolean;
      try {
        reachable = await probeReachability(target);
      } finally {
        await releaseProbeQuota(this.env);
      }
      if (!reachable) {
        return Response.json({ success: false, probeFailed: true, recordId: "" });
      }
    }

    const writeTokenHash = await sha256Hex(base64ToBytes(body.writeToken));
    const now = Date.now();
    const ttlSeconds = Math.min(Math.max(body.ttlSeconds ?? RENDEZVOUS_MAX_TTL_SECONDS, 1), RENDEZVOUS_MAX_TTL_SECONDS);
    const expiresAt = now + ttlSeconds * 1000;

    let recordId = body.recordId;
    if (recordId) {
      // Republish (upsert): require the same write_token that authorized
      // the original publish.
      const existing = this.sql
        .exec<{ write_token_hash: string }>(
          `SELECT write_token_hash FROM bootstrap_rendezvous WHERE record_id = ? AND mesh_id = ?`,
          recordId,
          body.meshId
        )
        .toArray();

      if (existing.length === 0) {
        // The named record doesn't exist (expired, or never existed) — not
        // a write-capability question, just nothing to upsert.
        return Response.json({ success: false, probeFailed: false, recordId: "" });
      }
      if (!constantTimeEqualHex(existing[0].write_token_hash, writeTokenHash)) {
        throw new ConnectError("write_token mismatch", ConnectErrorCode.PermissionDenied);
      }

      this.sql.exec(
        `UPDATE bootstrap_rendezvous SET ciphertext = ?, gcm_nonce = ?, published_at = ?, expires_at = ? WHERE record_id = ?`,
        body.ciphertext,
        body.gcmNonce,
        now,
        expiresAt,
        recordId
      );
    } else {
      recordId = generateRecordID();
      this.sql.exec(
        `INSERT INTO bootstrap_rendezvous (record_id, mesh_id, ciphertext, gcm_nonce, write_token_hash, published_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        recordId,
        body.meshId,
        body.ciphertext,
        body.gcmNonce,
        writeTokenHash,
        now,
        expiresAt
      );
    }

    this.notifyRendezvousWaiters(body.meshId);

    this.log.info(`[Registry] PublishBootstrapRendezvous SUCCESS: meshId=${body.meshId}, recordId=${recordId}`);

    return Response.json({
      success: true,
      expiresAt: Math.floor(expiresAt / 1000),
      probeFailed: false,
      recordId,
    });
  }

  /**
   * Handle PollBootstrapRendezvous RPC (RFD 108): a long-poll that returns
   * immediately if a record already exists for mesh_id, otherwise holds
   * the request open (capped server-side) and resolves as soon as a
   * matching publish lands.
   */
  private async handlePollBootstrapRendezvous(request: Request): Promise<Response> {
    const body = (await request.json()) as { meshId: string; waitSeconds?: number };

    if (!body.meshId) {
      throw new ConnectError("mesh_id is required", ConnectErrorCode.InvalidArgument);
    }

    // A tight client retry loop on disconnect shouldn't be free — rate
    // limited separately from publish.
    this.checkRendezvousRateLimit(`poll:${body.meshId}`, RENDEZVOUS_POLL_RATE_PER_MINUTE, RENDEZVOUS_POLL_BURST);

    const waitSeconds = Math.max(0, Math.min(body.waitSeconds ?? RENDEZVOUS_MAX_POLL_WAIT_SECONDS, RENDEZVOUS_MAX_POLL_WAIT_SECONDS));

    // An existing record is always returned immediately, with no wait — the
    // caller's own backoff/dedup is what prevents this from becoming a
    // busy-loop, not Discovery withholding data it already has.
    const existing = this.queryRendezvousRecords(body.meshId);
    if (existing.length > 0) {
      return Response.json({ records: existing, timedOut: false });
    }

    if (waitSeconds === 0) {
      return Response.json({ records: [], timedOut: true });
    }

    const publishedWhileWaiting = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), waitSeconds * 1000);
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const list = this.rendezvousWaiters.get(body.meshId) || [];
      list.push(waiter);
      this.rendezvousWaiters.set(body.meshId, list);
    });

    const records = this.queryRendezvousRecords(body.meshId);
    return Response.json({ records, timedOut: !publishedWhileWaiting || records.length === 0 });
  }

  /**
   * Handle AckBootstrapRendezvous RPC (RFD 108): a hash-checked, idempotent
   * delete-by-record_id.
   */
  private async handleAckBootstrapRendezvous(request: Request): Promise<Response> {
    const body = (await request.json()) as { meshId: string; recordId: string; writeToken: string };

    if (!body.meshId) {
      throw new ConnectError("mesh_id is required", ConnectErrorCode.InvalidArgument);
    }
    if (!body.recordId) {
      throw new ConnectError("record_id is required", ConnectErrorCode.InvalidArgument);
    }

    const existing = this.sql
      .exec<{ write_token_hash: string }>(
        `SELECT write_token_hash FROM bootstrap_rendezvous WHERE record_id = ? AND mesh_id = ?`,
        body.recordId,
        body.meshId
      )
      .toArray();

    if (existing.length === 0) {
      // Idempotent: already gone (expired or already acked). write_token
      // isn't checked in that case since there's nothing to authorize
      // deleting.
      return Response.json({ success: true });
    }

    const providedHash = await sha256Hex(base64ToBytes(body.writeToken || ""));
    if (!constantTimeEqualHex(existing[0].write_token_hash, providedHash)) {
      // Rejection, not an idempotent no-op — the record is left in place.
      return Response.json({ success: false });
    }

    this.sql.exec(`DELETE FROM bootstrap_rendezvous WHERE record_id = ?`, body.recordId);
    return Response.json({ success: true });
  }

  /**
   * Health check.
   */
  private handleHealth(): Response {
    const colonyCount = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM colonies WHERE expires_at >= ?`, Date.now())
      .toArray()[0]?.count || 0;

    return Response.json({
      status: "ok",
      version: this.config.serviceVersion,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      registeredColonies: colonyCount,
    });
  }

  /**
   * Count registered entities.
   */
  private handleCount(): Response {
    const now = Date.now();
    const colonyCount = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM colonies WHERE expires_at >= ?`, now)
      .toArray()[0]?.count || 0;
    const agentCount = this.sql
      .exec<{ count: number }>(`SELECT COUNT(*) as count FROM agents WHERE expires_at >= ?`, now)
      .toArray()[0]?.count || 0;

    return Response.json({
      colonies: colonyCount,
      agents: agentCount,
    });
  }
}

/**
 * Check if an IP address is private (RFC 1918).
 */
function isPrivateIP(ip: string): boolean {
  if (!ip) return false;
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("127.") ||
    ip === "::1" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  );
}
