import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/types";
import worker from "../src/index";

describe("ColonyRegistry", () => {
  describe("RegisterColony", () => {
    it("should register a new colony", async () => {
      const request = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/RegisterColony",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "1.2.3.4",
          },
          body: JSON.stringify({
            meshId: "test-mesh-1",
            pubkey: "dGVzdC1wdWJrZXktMTIzNDU2Nzg5MA==",
            endpoints: ["1.2.3.4:51820"],
            meshIpv4: "10.42.0.1",
            connectPort: 9000,
          }),
        }
      );

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; ttl: number };
      expect(body.success).toBe(true);
      expect(body.ttl).toBeGreaterThan(0);
    });

    it("should reject registration without mesh_id", async () => {
      const request = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/RegisterColony",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey: "dGVzdC1wdWJrZXk=",
            endpoints: ["1.2.3.4:51820"],
          }),
        }
      );

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(400);
      const body = await response.json() as { code: string; message: string };
      expect(body.code).toBe("invalid_argument");
    });

    it("should reject split-brain registration", async () => {
      const meshId = "split-brain-test-" + Date.now();

      // First registration.
      const request1 = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/RegisterColony",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meshId,
            pubkey: "cHVia2V5MQ==",
            endpoints: ["1.2.3.4:51820"],
          }),
        }
      );

      const ctx1 = createExecutionContext();
      const response1 = await worker.fetch(request1, env as Env, ctx1);
      await waitOnExecutionContext(ctx1);
      expect(response1.status).toBe(200);

      // Second registration with different pubkey.
      const request2 = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/RegisterColony",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meshId,
            pubkey: "cHVia2V5Mg==",
            endpoints: ["5.6.7.8:51820"],
          }),
        }
      );

      const ctx2 = createExecutionContext();
      const response2 = await worker.fetch(request2, env as Env, ctx2);
      await waitOnExecutionContext(ctx2);

      expect(response2.status).toBe(409);
      const body = await response2.json() as { code: string; message: string };
      expect(body.code).toBe("already_exists");
    });
  });

  describe("LookupColony", () => {
    it("should lookup a registered colony", async () => {
      const meshId = "lookup-test-" + Date.now();

      // Register first.
      const registerRequest = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/RegisterColony",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            meshId,
            pubkey: "bG9va3VwLXB1YmtleQ==",
            endpoints: ["10.0.0.1:51820"],
            meshIpv4: "10.42.0.1",
            metadata: { region: "us-east" },
          }),
        }
      );

      const ctx1 = createExecutionContext();
      await worker.fetch(registerRequest, env as Env, ctx1);
      await waitOnExecutionContext(ctx1);

      // Lookup.
      const lookupRequest = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/LookupColony",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ meshId }),
        }
      );

      const ctx2 = createExecutionContext();
      const response = await worker.fetch(lookupRequest, env as Env, ctx2);
      await waitOnExecutionContext(ctx2);

      expect(response.status).toBe(200);
      const body = await response.json() as {
        meshId: string;
        pubkey: string;
        endpoints: string[];
        meshIpv4: string;
        metadata: Record<string, string>;
      };
      expect(body.meshId).toBe(meshId);
      expect(body.pubkey).toBe("bG9va3VwLXB1YmtleQ==");
      expect(body.meshIpv4).toBe("10.42.0.1");
      expect(body.metadata).toEqual({ region: "us-east" });
    });

    it("should return not found for unknown colony", async () => {
      const request = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/LookupColony",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ meshId: "nonexistent-mesh" }),
        }
      );

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(404);
      const body = await response.json() as { code: string };
      expect(body.code).toBe("not_found");
    });
  });

  describe("Health", () => {
    it("should return health status", async () => {
      const request = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/Health",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      const body = await response.json() as {
        status: string;
        version: string;
      };
      expect(body.status).toBe("ok");
    });
  });

  describe("Unimplemented RPCs", () => {
    it("should return unimplemented for RequestRelay", async () => {
      const request = new Request(
        "http://localhost/coral.discovery.v1.DiscoveryService/RequestRelay",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, env as Env, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(501);
      const body = await response.json() as { code: string };
      expect(body.code).toBe("unimplemented");
    });
  });
});
