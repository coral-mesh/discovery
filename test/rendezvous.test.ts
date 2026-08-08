import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Env } from "../src/types";
import worker from "../src/index";

function rpc(name: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request(`http://localhost/coral.discovery.v1.DiscoveryService/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function call(request: Request): Promise<{ status: number; body: any }> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as Env, ctx);
  await waitOnExecutionContext(ctx);
  const body = await response.json();
  return { status: response.status, body };
}

const b64 = (s: string) => btoa(s);

describe("PSK-encrypted rendezvous (RFD 108)", () => {
  it("publishes a new record and returns a record_id", async () => {
    const meshId = "rendezvous-publish-" + Date.now();
    const { status, body } = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-bytes"),
        gcmNonce: b64("123456789012"),
        ttlSeconds: 90,
        writeToken: b64("write-token-secret"),
      })
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.recordId).toBeTruthy();
    expect(body.probeFailed).toBe(false);
  });

  it("returns an existing record immediately on poll, with no wait", async () => {
    const meshId = "rendezvous-poll-immediate-" + Date.now();
    const publish = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-bytes"),
        gcmNonce: b64("123456789012"),
        writeToken: b64("write-token-secret"),
      })
    );
    expect(publish.body.success).toBe(true);

    const start = Date.now();
    const poll = await call(rpc("PollBootstrapRendezvous", { meshId, waitSeconds: 20 }));
    const elapsedMs = Date.now() - start;

    expect(poll.status).toBe(200);
    expect(poll.body.timedOut).toBe(false);
    expect(poll.body.records).toHaveLength(1);
    expect(poll.body.records[0].recordId).toBe(publish.body.recordId);
    // Never includes write_token or its hash.
    expect(poll.body.records[0].writeToken).toBeUndefined();
    expect(poll.body.records[0].writeTokenHash).toBeUndefined();
    // Should not have waited out the long-poll window.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("times out with empty records when nothing is published", async () => {
    const meshId = "rendezvous-poll-timeout-" + Date.now();
    const { status, body } = await call(rpc("PollBootstrapRendezvous", { meshId, waitSeconds: 1 }));

    expect(status).toBe(200);
    expect(body.timedOut).toBe(true);
    expect(body.records).toHaveLength(0);
  });

  it("resolves a long-poll as soon as a matching publish lands", async () => {
    const meshId = "rendezvous-poll-resolve-" + Date.now();

    const pollPromise = call(rpc("PollBootstrapRendezvous", { meshId, waitSeconds: 10 }));

    // Give the poll a moment to register as a waiter, then publish.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const publish = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-bytes"),
        gcmNonce: b64("123456789012"),
        writeToken: b64("write-token-secret"),
      })
    );
    expect(publish.body.success).toBe(true);

    const start = Date.now();
    const poll = await pollPromise;
    // Resolved well before the 10s cap, proving it woke on publish rather
    // than timing out.
    expect(Date.now() - start).toBeLessThan(9000);
    expect(poll.body.timedOut).toBe(false);
    expect(poll.body.records).toHaveLength(1);
    expect(poll.body.records[0].recordId).toBe(publish.body.recordId);
  });

  it("upserts on republish with the same record_id and write_token (no duplicate rows)", async () => {
    const meshId = "rendezvous-republish-" + Date.now();
    const writeToken = b64("write-token-secret");

    const first = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-v1"),
        gcmNonce: b64("nonce-v1-12x"),
        writeToken,
      })
    );
    expect(first.body.success).toBe(true);

    const second = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-v2"),
        gcmNonce: b64("nonce-v2-12x"),
        recordId: first.body.recordId,
        writeToken,
      })
    );
    expect(second.body.success).toBe(true);
    expect(second.body.recordId).toBe(first.body.recordId);

    const poll = await call(rpc("PollBootstrapRendezvous", { meshId, waitSeconds: 5 }));
    expect(poll.body.records).toHaveLength(1);
    expect(poll.body.records[0].ciphertext).toBe(b64("ciphertext-v2"));
  });

  it("rejects a republish with the wrong write_token", async () => {
    const meshId = "rendezvous-republish-mismatch-" + Date.now();

    const first = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-v1"),
        gcmNonce: b64("nonce-v1-12x"),
        writeToken: b64("correct-write-token"),
      })
    );
    expect(first.body.success).toBe(true);

    const second = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-attacker"),
        gcmNonce: b64("nonce-atk-123"),
        recordId: first.body.recordId,
        writeToken: b64("wrong-write-token"),
      })
    );
    expect(second.status).toBe(400);
    expect(second.body.code).toBe("permission_denied");

    // The original record must still be intact.
    const poll = await call(rpc("PollBootstrapRendezvous", { meshId, waitSeconds: 5 }));
    expect(poll.body.records).toHaveLength(1);
    expect(poll.body.records[0].ciphertext).toBe(b64("ciphertext-v1"));
  });

  it("acks a record and removes it, idempotently", async () => {
    const meshId = "rendezvous-ack-" + Date.now();
    const writeToken = b64("write-token-secret");

    const publish = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-bytes"),
        gcmNonce: b64("123456789012"),
        writeToken,
      })
    );

    const ack = await call(
      rpc("AckBootstrapRendezvous", { meshId, recordId: publish.body.recordId, writeToken })
    );
    expect(ack.body.success).toBe(true);

    const poll = await call(rpc("PollBootstrapRendezvous", { meshId, waitSeconds: 1 }));
    expect(poll.body.records).toHaveLength(0);
    expect(poll.body.timedOut).toBe(true);

    // Acking an already-gone record is idempotent, not an error.
    const ackAgain = await call(
      rpc("AckBootstrapRendezvous", { meshId, recordId: publish.body.recordId, writeToken })
    );
    expect(ackAgain.body.success).toBe(true);
  });

  it("rejects an ack with the wrong write_token and leaves the record intact", async () => {
    const meshId = "rendezvous-ack-mismatch-" + Date.now();
    const writeToken = b64("correct-write-token");

    const publish = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-bytes"),
        gcmNonce: b64("123456789012"),
        writeToken,
      })
    );

    // A third party that only ever observed record_id (via Poll) tries to
    // ack with a guessed/wrong write_token.
    const ack = await call(
      rpc("AckBootstrapRendezvous", {
        meshId,
        recordId: publish.body.recordId,
        writeToken: b64("guessed-wrong-token"),
      })
    );
    expect(ack.body.success).toBe(false);

    const poll = await call(rpc("PollBootstrapRendezvous", { meshId, waitSeconds: 1 }));
    expect(poll.body.records).toHaveLength(1);
    expect(poll.body.records[0].recordId).toBe(publish.body.recordId);
  });

  it("skips the reachability probe entirely when verify_reachability is false (default)", async () => {
    const meshId = "rendezvous-no-probe-" + Date.now();

    // probe_endpoint points at an address that would fail the deny-list if
    // it were ever dialed (loopback) — publish must still succeed
    // immediately since verify_reachability is not set.
    const { status, body } = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-bytes"),
        gcmNonce: b64("123456789012"),
        writeToken: b64("write-token-secret"),
        probeEndpoint: "127.0.0.1:9999",
      })
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.probeFailed).toBe(false);
  });

  it("rejects a reachability-verified publish against a deny-listed target without dialing out", async () => {
    const meshId = "rendezvous-denylisted-probe-" + Date.now();

    const { body } = await call(
      rpc("PublishBootstrapRendezvous", {
        meshId,
        ciphertext: b64("ciphertext-bytes"),
        gcmNonce: b64("123456789012"),
        writeToken: b64("write-token-secret"),
        probeEndpoint: "127.0.0.1:9999",
        verifyReachability: true,
      })
    );

    expect(body.success).toBe(false);
    expect(body.probeFailed).toBe(true);
  });
});
