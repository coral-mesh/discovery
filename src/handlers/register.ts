import type { Env } from "../types";
import { ConnectError, ConnectErrorCode } from "../registry";
import type { Logger } from "../logger";

/**
 * Handle RegisterColony RPC.
 */
export async function handleRegisterColony(
  env: Env,
  request: {
    meshId: string;
    pubkey: string;
    endpoints: string[];
    meshIpv4?: string;
    meshIpv6?: string;
    connectPort?: number;
    publicPort?: number;
    metadata?: Record<string, string>;
    observedEndpoint?: {
      ip: string;
      port: number;
      protocol: string;
    };
    publicEndpoint?: {
      enabled: boolean;
      url?: string;
      caCert?: string;
      caFingerprint?: {
        algorithm: number;
        value: Uint8Array;
      };
    };
  },
  clientIP?: string,
  log?: Logger
): Promise<{
  success: boolean;
  ttl: number;
  expiresAt: string; // RFC 3339 string for ProtoJSON compatibility.
  observedEndpoint?: {
    ip: string;
    port: number;
    protocol: string;
  };
}> {
  log?.debug(`[Handler] RegisterColony: meshId=${request.meshId}, pubkey=${request.pubkey?.substring(0, 20)}..., endpoints=${JSON.stringify(request.endpoints)}, clientIP=${clientIP}`);

  // Get the Durable Object for this mesh.
  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
  log?.debug(`[Handler] RegisterColony: DO id=${registryId.toString()}`);
  const registry = env.COLONY_REGISTRY.get(registryId);

  // Forward request to Durable Object.
  const response = await registry.fetch(
    new Request("http://internal/register-colony", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...request,
        observedIP: clientIP,
      }),
    })
  );

  if (!response.ok) {
    const error = await response.json() as { error: string; code: number };
    throw new ConnectError(error.error, error.code);
  }

  const result = await response.json() as {
    success: boolean;
    ttl: number;
    expiresAt: number;
    observedEndpoint?: {
      ip: string;
      port: number;
      protocol: string;
    };
  };

  return {
    success: result.success,
    ttl: result.ttl,
    expiresAt: new Date(result.expiresAt).toISOString(),
    observedEndpoint: result.observedEndpoint,
  };
}

/**
 * Handle RegisterAgent RPC.
 */
export async function handleRegisterAgent(
  env: Env,
  request: {
    agentId: string;
    meshId: string;
    pubkey: string;
    endpoints: string[];
    observedEndpoint?: {
      ip: string;
      port: number;
      protocol: string;
    };
    metadata?: Record<string, string>;
  },
  clientIP?: string,
  log?: Logger
): Promise<{
  success: boolean;
  ttl: number;
  expiresAt: string; // RFC 3339 string for ProtoJSON compatibility.
  observedEndpoint?: {
    ip: string;
    port: number;
    protocol: string;
  };
}> {
  log?.debug(`[Handler] RegisterAgent: agentId=${request.agentId}, meshId=${request.meshId}, pubkey=${request.pubkey?.substring(0, 20)}..., endpoints=${JSON.stringify(request.endpoints)}, clientIP=${clientIP}`);

  // Use the mesh ID to route to the correct Durable Object.
  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
  log?.debug(`[Handler] RegisterAgent: DO id=${registryId.toString()}`);
  const registry = env.COLONY_REGISTRY.get(registryId);

  // Forward request to Durable Object.
  const response = await registry.fetch(
    new Request("http://internal/register-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...request,
        observedIP: clientIP,
      }),
    })
  );

  if (!response.ok) {
    const error = await response.json() as { error: string; code: number };
    throw new ConnectError(error.error, error.code);
  }

  const result = await response.json() as {
    success: boolean;
    ttl: number;
    expiresAt: number;
    observedEndpoint?: {
      ip: string;
      port: number;
      protocol: string;
    };
  };

  return {
    success: result.success,
    ttl: result.ttl,
    expiresAt: new Date(result.expiresAt).toISOString(),
    observedEndpoint: result.observedEndpoint,
  };
}
