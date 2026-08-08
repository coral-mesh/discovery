/**
 * ProbeQuota Durable Object — global abuse controls for the opt-in
 * reachability probe (RFD 108, Security Model item 9).
 *
 * `mesh_id` is free to generate and unauthenticated, so a per-`mesh_id`
 * limiter alone caps nothing globally: an attacker can mint unlimited
 * `mesh_id`s and stay under any per-ID threshold while driving unbounded
 * aggregate probe volume against arbitrary public hosts. This is a single,
 * global Durable Object instance (idFromName("global"), mirroring the
 * DiscoveryMetrics pattern) that layers:
 *   - a per-source-IP token bucket,
 *   - a global concurrent-probe cap,
 *   - a per-source-IP distinct-probe_endpoint cap over a rolling window,
 * independent of, and in addition to, the per-mesh_id limiter in
 * registry.ts.
 *
 * The RFD's reference design describes this as ideally implemented via
 * Cloudflare's native, edge-enforced Rate Limiting rules (keyed on
 * CF-Connecting-IP) rather than a hand-rolled Durable Object counter, since
 * the platform already provides that for free. Rate Limiting rules are
 * dashboard/account configuration, not something this codebase can express
 * — this Durable Object is the in-code equivalent so the control exists and
 * is testable, and should be paired with real Cloudflare Rate Limiting
 * rules in production deployment.
 */
export class ProbeQuota implements DurableObject {
  private readonly maxConcurrent = 20;
  private readonly perIPBurst = 5;
  private readonly perIPRatePerHour = 20;
  private readonly maxDistinctTargetsPerWindow = 10;
  private readonly distinctTargetWindowMs = 60 * 60 * 1000;

  private concurrent = 0;
  private ipBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  private distinctTargets = new Map<string, Map<string, number>>(); // ip -> (target -> firstSeenAt)

  constructor(
    private ctx: DurableObjectState,
    private env: unknown
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/acquire" && request.method === "POST") {
      const body = (await request.json()) as { ip: string; target: string };
      return Response.json(this.acquire(body.ip || "unknown", body.target || ""));
    }

    if (url.pathname === "/release" && request.method === "POST") {
      this.concurrent = Math.max(0, this.concurrent - 1);
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  }

  private acquire(ip: string, target: string): { allowed: boolean; reason?: string } {
    if (this.concurrent >= this.maxConcurrent) {
      return { allowed: false, reason: "global_concurrent_cap" };
    }

    const now = Date.now();

    let bucket = this.ipBuckets.get(ip);
    if (!bucket) {
      bucket = { tokens: this.perIPBurst, lastRefill: now };
      this.ipBuckets.set(ip, bucket);
    }
    const elapsedHours = (now - bucket.lastRefill) / 3_600_000;
    bucket.tokens = Math.min(this.perIPBurst, bucket.tokens + elapsedHours * this.perIPRatePerHour);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      return { allowed: false, reason: "per_ip_rate" };
    }

    let targets = this.distinctTargets.get(ip);
    if (!targets) {
      targets = new Map();
      this.distinctTargets.set(ip, targets);
    }
    // Drop targets outside the rolling window.
    for (const [t, seenAt] of targets) {
      if (now - seenAt > this.distinctTargetWindowMs) {
        targets.delete(t);
      }
    }
    if (!targets.has(target) && targets.size >= this.maxDistinctTargetsPerWindow) {
      return { allowed: false, reason: "distinct_target_cap" };
    }

    bucket.tokens -= 1;
    if (!targets.has(target)) {
      targets.set(target, now);
    }
    this.concurrent += 1;
    return { allowed: true };
  }
}

/**
 * Env slice needed to reach the ProbeQuota Durable Object.
 */
export interface ProbeQuotaEnv {
  PROBE_QUOTA: DurableObjectNamespace;
}

/**
 * Acquire probe quota for a source IP + target pair. Must be paired with
 * releaseProbeQuota once the probe attempt completes (success or failure).
 */
export async function acquireProbeQuota(
  env: ProbeQuotaEnv,
  ip: string,
  target: string
): Promise<{ allowed: boolean; reason?: string }> {
  const id = env.PROBE_QUOTA.idFromName("global");
  const stub = env.PROBE_QUOTA.get(id);
  const response = await stub.fetch(
    new Request("http://internal/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, target }),
    })
  );
  return (await response.json()) as { allowed: boolean; reason?: string };
}

/**
 * Release a previously acquired probe quota slot.
 */
export async function releaseProbeQuota(env: ProbeQuotaEnv): Promise<void> {
  const id = env.PROBE_QUOTA.idFromName("global");
  const stub = env.PROBE_QUOTA.get(id);
  await stub.fetch(new Request("http://internal/release", { method: "POST" }));
}
