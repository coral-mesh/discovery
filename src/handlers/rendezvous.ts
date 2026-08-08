import type { Env } from "../types";
import { ConnectError, ConnectErrorCode } from "../registry";
import type { Logger } from "../logger";

/**
 * Handle PublishBootstrapRendezvous RPC (RFD 108).
 */
export async function handlePublishBootstrapRendezvous(
  env: Env,
  request: {
    meshId: string;
    ciphertext: string; // base64
    gcmNonce: string; // base64
    ttlSeconds?: number;
    probeEndpoint?: string;
    recordId?: string;
    writeToken: string; // base64
    verifyReachability?: boolean;
  },
  clientIP?: string,
  log?: Logger
): Promise<{
  success: boolean;
  expiresAt?: string; // RFC 3339 string for ProtoJSON compatibility.
  probeFailed: boolean;
  recordId: string;
}> {
  log?.debug(
    `[Handler] PublishBootstrapRendezvous: meshId=${request.meshId}, recordId=${request.recordId || "(new)"}, verifyReachability=${!!request.verifyReachability}, clientIP=${clientIP}`
  );

  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
  const registry = env.COLONY_REGISTRY.get(registryId);

  const response = await registry.fetch(
    new Request("http://internal/publish-bootstrap-rendezvous", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, clientIP }),
    })
  );

  if (!response.ok) {
    const error = (await response.json()) as { error: string; code: number; retryAfterSeconds?: number };
    throw new ConnectError(error.error, error.code, error.retryAfterSeconds);
  }

  const result = (await response.json()) as {
    success: boolean;
    expiresAt?: number;
    probeFailed: boolean;
    recordId: string;
  };

  return {
    success: result.success,
    expiresAt: result.expiresAt !== undefined ? new Date(result.expiresAt * 1000).toISOString() : undefined,
    probeFailed: result.probeFailed,
    recordId: result.recordId,
  };
}

/**
 * Handle PollBootstrapRendezvous RPC (RFD 108).
 */
export async function handlePollBootstrapRendezvous(
  env: Env,
  request: { meshId: string; waitSeconds?: number },
  log?: Logger
): Promise<{
  records: Array<{
    recordId: string;
    ciphertext: string;
    gcmNonce: string;
    publishedAt: string;
  }>;
  timedOut: boolean;
}> {
  log?.debug(`[Handler] PollBootstrapRendezvous: meshId=${request.meshId}, waitSeconds=${request.waitSeconds}`);

  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
  const registry = env.COLONY_REGISTRY.get(registryId);

  const response = await registry.fetch(
    new Request("http://internal/poll-bootstrap-rendezvous", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })
  );

  if (!response.ok) {
    const error = (await response.json()) as { error: string; code: number; retryAfterSeconds?: number };
    throw new ConnectError(error.error, error.code, error.retryAfterSeconds);
  }

  return (await response.json()) as {
    records: Array<{ recordId: string; ciphertext: string; gcmNonce: string; publishedAt: string }>;
    timedOut: boolean;
  };
}

/**
 * Handle AckBootstrapRendezvous RPC (RFD 108).
 */
export async function handleAckBootstrapRendezvous(
  env: Env,
  request: { meshId: string; recordId: string; writeToken: string },
  log?: Logger
): Promise<{ success: boolean }> {
  log?.debug(`[Handler] AckBootstrapRendezvous: meshId=${request.meshId}, recordId=${request.recordId}`);

  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
  const registry = env.COLONY_REGISTRY.get(registryId);

  const response = await registry.fetch(
    new Request("http://internal/ack-bootstrap-rendezvous", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })
  );

  if (!response.ok) {
    const error = (await response.json()) as { error: string; code: number; retryAfterSeconds?: number };
    throw new ConnectError(error.error, error.code, error.retryAfterSeconds);
  }

  return (await response.json()) as { success: boolean };
}
