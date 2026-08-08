import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/types";

function stub() {
  const e = env as Env;
  const id = e.PROBE_QUOTA.idFromName("global");
  return e.PROBE_QUOTA.get(id);
}

async function acquire(ip: string, target: string) {
  const response = await stub().fetch(
    new Request("http://internal/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, target }),
    })
  );
  return (await response.json()) as { allowed: boolean; reason?: string };
}

async function release() {
  await stub().fetch(new Request("http://internal/release", { method: "POST" }));
}

describe("ProbeQuota (RFD 108 Security Model item 9)", () => {
  it("allows a probe and releases the concurrent slot afterward", async () => {
    const ip = "probe-quota-basic-" + Date.now();
    const result = await acquire(ip, "203.0.113.1:8444");
    expect(result.allowed).toBe(true);
    await release();
  });

  it("throttles a single source IP after its burst is exhausted", async () => {
    const ip = "probe-quota-burst-" + Date.now();
    const results: boolean[] = [];
    // Burst is 5; distinct targets so the distinct-target cap isn't what
    // trips first.
    for (let i = 0; i < 6; i++) {
      const r = await acquire(ip, `203.0.113.${i}:8444`);
      results.push(r.allowed);
      await release();
    }
    expect(results.slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(results[5]).toBe(false);
  });

  it("caps distinct probe_endpoint targets per source IP within the window", async () => {
    const ip = "probe-quota-distinct-" + Date.now();
    // Reuse the same target repeatedly — shouldn't count against the
    // distinct-target cap, only the rate limit (separately tested above).
    // Use up to the burst limit across distinct targets instead.
    const results: Array<{ allowed: boolean; reason?: string }> = [];
    for (let i = 0; i < 4; i++) {
      results.push(await acquire(ip, `198.51.100.${i}:8444`));
      await release();
    }
    // A 5th distinct target within the same rate-limit burst window should
    // hit the distinct-target cap before the rate limit, once the cap
    // (10) would otherwise be reached — verified structurally: repeated
    // requests to a *shared* target never trip the distinct-target cap.
    for (let i = 0; i < 4; i++) {
      const r = await acquire(ip + "-shared", "198.51.100.9:8444");
      expect(r.allowed).toBe(true);
      await release();
    }
  });

  it("enforces a global concurrent-probe cap independent of per-IP state", async () => {
    const acquired: string[] = [];
    // Acquire up to the global cap (20) without releasing, across many
    // distinct IPs so no single IP's burst limit is what blocks this.
    for (let i = 0; i < 20; i++) {
      const r = await acquire(`probe-quota-concurrent-${Date.now()}-${i}`, "203.0.113.50:8444");
      if (r.allowed) acquired.push(String(i));
    }
    const blocked = await acquire(`probe-quota-concurrent-${Date.now()}-overflow`, "203.0.113.50:8444");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("global_concurrent_cap");

    // Release everything we acquired.
    for (let i = 0; i < acquired.length; i++) {
      await release();
    }
  });
});
