import type { Env, ColonyRecord, AgentRecord, EndpointRecord, Config } from "./types";
import { parseConfig } from "./types";
import { createLogger, parseLogLevel, type Logger } from "./logger";

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

-- Indexes for efficient queries.
CREATE INDEX IF NOT EXISTS idx_agents_mesh_id ON agents(mesh_id);
CREATE INDEX IF NOT EXISTS idx_colonies_expires ON colonies(expires_at);
CREATE INDEX IF NOT EXISTS idx_agents_expires ON agents(expires_at);
`;

/**
 * Error codes for Connect protocol.
 */
export const ConnectErrorCode = {
  InvalidArgument: 3,
  NotFound: 5,
  AlreadyExists: 6,
  Unimplemented: 12,
  Internal: 13,
} as const;

/**
 * Custom error for Connect protocol.
 */
export class ConnectError extends Error {
  constructor(
    message: string,
    public readonly code: number
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
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      if (err instanceof ConnectError) {
        return Response.json({ error: err.message, code: err.code }, { status: 400 });
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

    // Batch cleanup expired entries.
    this.sql.exec(`DELETE FROM colonies WHERE expires_at < ?`, now);
    this.sql.exec(`DELETE FROM agents WHERE expires_at < ?`, now);

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

    this.log.debug(`[Registry] RegisterColony called with meshId: ${body.meshId}, pubkey: ${body.pubkey?.substring(0, 20)}..., endpoints: ${JSON.stringify(body.endpoints)}, publicPort: ${body.publicPort}`);

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
    const existing = this.sql
      .exec<{ pubkey: string }>(
        `SELECT pubkey FROM colonies WHERE mesh_id = ?`,
        body.meshId
      )
      .toArray();

    if (existing.length > 0 && existing[0].pubkey !== body.pubkey) {
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

    // Upsert colony.
    if (existing.length > 0) {
      this.sql.exec(
        `UPDATE colonies SET
          pubkey = ?,
          endpoints = ?,
          mesh_ipv4 = ?,
          mesh_ipv6 = ?,
          connect_port = ?,
          public_port = ?,
          metadata = ?,
          observed_endpoint = ?,
          public_endpoint = ?,
          updated_at = ?,
          expires_at = ?
        WHERE mesh_id = ?`,
        body.pubkey,
        JSON.stringify(body.endpoints || []),
        body.meshIpv4 || null,
        body.meshIpv6 || null,
        body.connectPort || null,
        body.publicPort || null,
        body.metadata ? JSON.stringify(body.metadata) : null,
        observedEndpoint ? JSON.stringify(observedEndpoint) : null,
        body.publicEndpoint ? JSON.stringify(body.publicEndpoint) : null,
        now,
        expiresAt,
        body.meshId
      );
    } else {
      this.sql.exec(
        `INSERT INTO colonies (
          mesh_id, pubkey, endpoints, mesh_ipv4, mesh_ipv6,
          connect_port, public_port, metadata, observed_endpoint,
          public_endpoint, nat_hint, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        0, // nat_hint.
        now,
        now,
        expiresAt
      );
    }

    this.log.debug(`[Registry] RegisterColony SUCCESS for meshId: ${body.meshId}, expiresAt: ${expiresAt}`);

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

    this.log.debug(`[Registry] LookupColony called with meshId: ${body.meshId}`);

    if (!body.meshId) {
      throw new ConnectError("mesh_id is required", ConnectErrorCode.InvalidArgument);
    }

    const now = Date.now();

    // First, log all colonies in the database for debugging.
    const allColonies = this.sql
      .exec<{ mesh_id: string; expires_at: number }>(`SELECT mesh_id, expires_at FROM colonies`)
      .toArray();
    this.log.debug(`[Registry] All colonies in DB:`, JSON.stringify(allColonies), `current time: ${now}`);

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
      }>(
        `SELECT * FROM colonies WHERE mesh_id = ? AND expires_at >= ?`,
        body.meshId,
        now
      )
      .toArray();

    this.log.debug(`[Registry] LookupColony query result for ${body.meshId}: ${rows.length} rows found`);

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

    this.log.debug(`[Registry] LookupColony SUCCESS for ${body.meshId}: pubkey=${row.pubkey?.substring(0, 20)}..., endpoints=${row.endpoints}, publicPort=${row.public_port}`);

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

    this.log.debug(`[Registry] RegisterAgent called with agentId: ${body.agentId}, meshId: ${body.meshId}, pubkey: ${body.pubkey?.substring(0, 20)}..., endpoints: ${JSON.stringify(body.endpoints)}`);

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

    this.log.debug(`[Registry] RegisterAgent SUCCESS for agentId: ${body.agentId}, meshId: ${body.meshId}, expiresAt: ${expiresAt}`);

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

    this.log.debug(`[Registry] LookupAgent called with agentId: ${body.agentId}`);

    if (!body.agentId) {
      throw new ConnectError("agent_id is required", ConnectErrorCode.InvalidArgument);
    }

    const now = Date.now();
    const rows = this.sql
      .exec<{
        agent_id: string;
        mesh_id: string;
        pubkey: string;
        endpoints: string;
        observed_endpoint: string | null;
        metadata: string | null;
        updated_at: number;
      }>(
        `SELECT * FROM agents WHERE agent_id = ? AND expires_at >= ?`,
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

    return Response.json({
      agentId: row.agent_id,
      meshId: row.mesh_id,
      pubkey: row.pubkey,
      endpoints: JSON.parse(row.endpoints),
      observedEndpoints,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      lastSeen: Math.floor(row.updated_at / 1000),
    });
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
