import { describe, it, expect } from "vitest";
import { isDeniedProbeTarget, splitHostPort, probeReachability } from "../src/probe";

describe("splitHostPort", () => {
  it("parses ip:port", () => {
    expect(splitHostPort("203.0.113.10:8444")).toEqual({ host: "203.0.113.10", port: 8444 });
  });

  it("parses [ipv6]:port", () => {
    expect(splitHostPort("[fe80::1]:8444")).toEqual({ host: "fe80::1", port: 8444 });
  });

  it("returns null for missing port", () => {
    expect(splitHostPort("203.0.113.10")).toBeNull();
  });

  it("returns null for an out-of-range port", () => {
    expect(splitHostPort("203.0.113.10:70000")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(splitHostPort("")).toBeNull();
  });
});

describe("isDeniedProbeTarget", () => {
  it("denies loopback", () => {
    expect(isDeniedProbeTarget("127.0.0.1")).toBe(true);
    expect(isDeniedProbeTarget("localhost")).toBe(true);
    expect(isDeniedProbeTarget("::1")).toBe(true);
  });

  it("denies RFC1918 private ranges", () => {
    expect(isDeniedProbeTarget("10.0.0.5")).toBe(true);
    expect(isDeniedProbeTarget("192.168.1.1")).toBe(true);
    expect(isDeniedProbeTarget("172.16.0.1")).toBe(true);
    expect(isDeniedProbeTarget("172.31.255.255")).toBe(true);
  });

  it("does not treat 172.32.x.x as private (outside the RFC1918 range)", () => {
    expect(isDeniedProbeTarget("172.32.0.1")).toBe(false);
  });

  it("denies link-local and cloud metadata", () => {
    expect(isDeniedProbeTarget("169.254.169.254")).toBe(true);
    expect(isDeniedProbeTarget("169.254.1.1")).toBe(true);
    expect(isDeniedProbeTarget("fe80::1")).toBe(true);
  });

  it("denies IPv6 unique-local addresses", () => {
    expect(isDeniedProbeTarget("fc00::1")).toBe(true);
    expect(isDeniedProbeTarget("fd12:3456::1")).toBe(true);
  });

  it("allows a plausible public address", () => {
    expect(isDeniedProbeTarget("203.0.113.10")).toBe(false);
  });

  it("denies an empty host", () => {
    expect(isDeniedProbeTarget("")).toBe(true);
  });
});

describe("probeReachability", () => {
  it("returns false without dialing out for a deny-listed target", async () => {
    // If this ever attempted a real connect, it would hang/fail in the test
    // sandbox; denying before the dynamic `cloudflare:sockets` import is
    // what's under test here.
    const result = await probeReachability("127.0.0.1:9999");
    expect(result).toBe(false);
  });

  it("returns false for an unparseable endpoint", async () => {
    const result = await probeReachability("not-an-endpoint");
    expect(result).toBe(false);
  });

  it("returns false for an undefined endpoint", async () => {
    const result = await probeReachability(undefined);
    expect(result).toBe(false);
  });
});
