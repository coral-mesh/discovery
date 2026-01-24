import type { Env } from "../types";
import { ConnectError, ConnectErrorCode } from "../registry";

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
  clientIP?: string
): Promise<{
  success: boolean;
  ttl: number;
  expiresAt: { seconds: bigint };
  observedEndpoint?: {
    ip: string;
    port: number;
    protocol: string;
  };
}> {
  // Get the Durable Object for this mesh.
  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
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
    expiresAt: { seconds: BigInt(result.expiresAt) },
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
  clientIP?: string
): Promise<{
  success: boolean;
  ttl: number;
  expiresAt: { seconds: bigint };
  observedEndpoint?: {
    ip: string;
    port: number;
    protocol: string;
  };
}> {
  // Use the mesh ID to route to the correct Durable Object.
  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
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
    expiresAt: { seconds: BigInt(result.expiresAt) },
    observedEndpoint: result.observedEndpoint,
  };
}
