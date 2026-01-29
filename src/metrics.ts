import { createLogger, parseLogLevel, type Logger } from "./logger";
import type { Env } from "./types";

interface MeshSnapshot {
  colonies: number;
  agents: number;
  updatedAt: number;
}

interface OperationEntry {
  operation: string;
  meshId?: string;
  timestamp: number;
}

/**
 * DiscoveryMetrics Durable Object.
 * Singleton that aggregates metrics from all ColonyRegistry DOs.
 * Uses KV-style storage (not SQLite) for compatibility with vitest-pool-workers.
 */
export class DiscoveryMetrics implements DurableObject {
  private log: Logger;
  private storage: DurableObjectStorage;

  constructor(
    private ctx: DurableObjectState,
    env: Env
  ) {
    this.log = createLogger(parseLogLevel(env.LOG_LEVEL));
    this.storage = ctx.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/report") {
        return await this.handleReport(request);
      } else if (path === "/track") {
        return await this.handleTrack(request);
      } else if (path === "/stats") {
        return await this.handleStats();
      }
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      this.log.error("[Metrics] Error:", err);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    // Clean up operation logs older than 24 hours.
    const cutoff = Date.now() - 24 * 3600_000;
    const ops = await this.storage.list<OperationEntry>({ prefix: "op:" });
    const toDelete: string[] = [];
    for (const [key, entry] of ops) {
      if (entry.timestamp < cutoff) {
        toDelete.push(key);
      }
    }
    if (toDelete.length > 0) {
      await this.storage.delete(toDelete);
    }

    // Clean up stale mesh snapshots (no report for 10 minutes).
    const staleThreshold = Date.now() - 10 * 60_000;
    const snapshots = await this.storage.list<MeshSnapshot>({ prefix: "mesh:" });
    const staleKeys: string[] = [];
    for (const [key, snap] of snapshots) {
      if (snap.updatedAt < staleThreshold) {
        staleKeys.push(key);
      }
    }
    if (staleKeys.length > 0) {
      await this.storage.delete(staleKeys);
    }

    await this.storage.setAlarm(Date.now() + 3600_000);
  }

  /**
   * Receive a snapshot report from a ColonyRegistry DO.
   */
  private async handleReport(request: Request): Promise<Response> {
    const body = await request.json() as {
      colonies: number;
      agents: number;
      expiredColonies: number;
      expiredAgents: number;
    };

    const doId = request.headers.get("X-DO-Id") || "unknown";

    const snapshot: MeshSnapshot = {
      colonies: body.colonies,
      agents: body.agents,
      updatedAt: Date.now(),
    };

    await this.storage.put(`mesh:${doId}`, snapshot);

    // Ensure cleanup alarm is scheduled.
    const alarm = await this.storage.getAlarm();
    if (alarm === null) {
      await this.storage.setAlarm(Date.now() + 3600_000);
    }

    return Response.json({ ok: true });
  }

  /**
   * Track an operation (register, lookup, token creation).
   */
  private async handleTrack(request: Request): Promise<Response> {
    const body = await request.json() as {
      operation: string;
      meshId?: string;
    };

    const entry: OperationEntry = {
      operation: body.operation,
      meshId: body.meshId,
      timestamp: Date.now(),
    };

    // Use a unique key per operation.
    const key = `op:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.storage.put(key, entry);

    return Response.json({ ok: true });
  }

  /**
   * Return aggregated stats.
   */
  private async handleStats(): Promise<Response> {
    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const staleThreshold = now - 5 * 60_000;

    // Aggregate from recent snapshots.
    const snapshots = await this.storage.list<MeshSnapshot>({ prefix: "mesh:" });
    let totalColonies = 0;
    let totalAgents = 0;
    let activeDOs = 0;

    for (const [, snap] of snapshots) {
      if (snap.updatedAt >= staleThreshold) {
        totalColonies += snap.colonies;
        totalAgents += snap.agents;
        activeDOs++;
      }
    }

    // Count operations in last hour.
    const ops = await this.storage.list<OperationEntry>({ prefix: "op:" });
    const operationCounts: Record<string, number> = {};

    for (const [, entry] of ops) {
      if (entry.timestamp >= oneHourAgo) {
        operationCounts[entry.operation] = (operationCounts[entry.operation] || 0) + 1;
      }
    }

    return Response.json({
      activeColonies: totalColonies,
      activeAgents: totalAgents,
      activeDurableObjects: activeDOs,
      operationsLastHour: operationCounts,
      timestamp: new Date(now).toISOString(),
    });
  }
}
