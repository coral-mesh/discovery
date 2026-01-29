import { createLogger, parseLogLevel, type Logger } from "./logger";
import type { Env } from "./types";

/**
 * DiscoveryMetrics Durable Object.
 * Singleton that aggregates metrics from all ColonyRegistry DOs.
 * Uses KV-style storage (not SQLite) for compatibility with vitest-pool-workers.
 */
export class DiscoveryMetrics implements DurableObject {
  private log: Logger;
  private storage: DurableObjectStorage;
  private pendingCounts = new Map<string, number>();
  private flushScheduled = false;

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
    // Flush any pending counts before cleanup.
    await this.flushCounts();

    // Clean up operation count buckets older than 24 hours.
    const cutoff = Date.now() - 24 * 3600_000;
    const counts = await this.storage.list<number>({ prefix: "count:" });
    const toDelete: string[] = [];
    for (const [key] of counts) {
      // key format: "count:RegisterColony:2026-01-29T10"
      const hour = key.split(":").pop()!;
      if (new Date(hour + ":00:00Z").getTime() < cutoff) {
        toDelete.push(key);
      }
    }
    if (toDelete.length > 0) {
      await this.storage.delete(toDelete);
    }

    // Clean up stale cleanup snapshots (no report for 10 minutes).
    const staleThreshold = Date.now() - 10 * 60_000;
    const cleanups = await this.storage.list<{ updatedAt: number }>({ prefix: "cleanup:" });
    const staleKeys: string[] = [];
    for (const [key, entry] of cleanups) {
      if (entry.updatedAt < staleThreshold) {
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
      expiredColonies: number;
      expiredAgents: number;
    };

    const doId = request.headers.get("X-DO-Id") || "unknown";

    // Store cleanup stats for this DO.
    await this.storage.put(`cleanup:${doId}`, {
      expiredColonies: body.expiredColonies,
      expiredAgents: body.expiredAgents,
      updatedAt: Date.now(),
    });

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

    // Accumulate in memory, flush to storage periodically.
    const hour = new Date().toISOString().slice(0, 13);
    const key = `count:${body.operation}:${hour}`;
    this.pendingCounts.set(key, (this.pendingCounts.get(key) || 0) + 1);

    if (!this.flushScheduled) {
      this.flushScheduled = true;
      // Flush after 10 seconds of batching.
      this.ctx.waitUntil(this.scheduleFlush());
    }

    return Response.json({ ok: true });
  }

  private async scheduleFlush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    await this.flushCounts();
  }

  private async flushCounts(): Promise<void> {
    if (this.pendingCounts.size === 0) {
      this.flushScheduled = false;
      return;
    }

    const toFlush = new Map(this.pendingCounts);
    this.pendingCounts.clear();
    this.flushScheduled = false;

    // Batch read all keys, then batch write.
    const keys = [...toFlush.keys()];
    const existing = await this.storage.get<number>(keys);
    const updates: Record<string, number> = {};
    for (const [key, increment] of toFlush) {
      updates[key] = (existing.get(key) || 0) + increment;
    }
    await this.storage.put(updates);

    // Ensure cleanup alarm is scheduled.
    const alarm = await this.storage.getAlarm();
    if (alarm === null) {
      await this.storage.setAlarm(Date.now() + 3600_000);
    }
  }

  /**
   * Return aggregated stats.
   */
  private async handleStats(): Promise<Response> {
    const now = Date.now();
    const oneHourAgo = now - 3600_000;

    // Count operations in last hour from hourly buckets.
    const counts = await this.storage.list<number>({ prefix: "count:" });
    const operationCounts: Record<string, number> = {};

    for (const [key, count] of counts) {
      // key format: "count:RegisterColony:2026-01-29T10"
      const parts = key.split(":");
      const hour = parts.pop()!;
      const operation = parts.slice(1).join(":");
      if (new Date(hour + ":00:00Z").getTime() >= oneHourAgo) {
        operationCounts[operation] = (operationCounts[operation] || 0) + count;
      }
    }

    return Response.json({
      operationsLastHour: operationCounts,
      timestamp: new Date(now).toISOString(),
    });
  }
}
