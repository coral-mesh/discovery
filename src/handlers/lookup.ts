import type { Env } from "../types";
import { ConnectError, ConnectErrorCode } from "../registry";

/**
 * Handle LookupColony RPC.
 */
export async function handleLookupColony(
  env: Env,
  request: { meshId: string }
): Promise<{
  meshId: string;
  pubkey: string;
  endpoints: string[];
  meshIpv4?: string;
  meshIpv6?: string;
  connectPort?: number;
  publicPort?: number;
  metadata?: Record<string, string>;
  lastSeen?: { seconds: bigint };
  observedEndpoints?: Array<{
    ip: string;
    port: number;
    protocol: string;
  }>;
  nat?: number;
  publicEndpoint?: {
    enabled: boolean;
    url?: string;
    caCert?: string;
    caFingerprint?: {
      algorithm: number;
      value: Uint8Array;
    };
  };
}> {
  // Get the Durable Object for this mesh.
  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
  const registry = env.COLONY_REGISTRY.get(registryId);

  // Forward request to Durable Object.
  const response = await registry.fetch(
    new Request("http://internal/lookup-colony", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })
  );

  if (!response.ok) {
    const error = await response.json() as { error: string; code: number };
    throw new ConnectError(error.error, error.code);
  }

  const result = await response.json() as {
    meshId: string;
    pubkey: string;
    endpoints: string[];
    meshIpv4?: string;
    meshIpv6?: string;
    connectPort?: number;
    publicPort?: number;
    metadata?: Record<string, string>;
    lastSeen?: number;
    observedEndpoints?: Array<{
      ip: string;
      port: number;
      protocol: string;
    }>;
    nat?: number;
    publicEndpoint?: {
      enabled: boolean;
      url?: string;
      caCert?: string;
      caFingerprint?: {
        algorithm: number;
        value: string;
      };
    };
  };

  return {
    meshId: result.meshId,
    pubkey: result.pubkey,
    endpoints: result.endpoints,
    meshIpv4: result.meshIpv4,
    meshIpv6: result.meshIpv6,
    connectPort: result.connectPort,
    publicPort: result.publicPort,
    metadata: result.metadata,
    lastSeen: result.lastSeen ? { seconds: BigInt(result.lastSeen) } : undefined,
    observedEndpoints: result.observedEndpoints,
    nat: result.nat,
    publicEndpoint: result.publicEndpoint
      ? {
          ...result.publicEndpoint,
          caFingerprint: result.publicEndpoint.caFingerprint
            ? {
                algorithm: result.publicEndpoint.caFingerprint.algorithm,
                value: new Uint8Array(
                  Buffer.from(result.publicEndpoint.caFingerprint.value, "base64")
                ),
              }
            : undefined,
        }
      : undefined,
  };
}

/**
 * Handle LookupAgent RPC.
 */
export async function handleLookupAgent(
  env: Env,
  request: { agentId: string },
  meshIdHint?: string
): Promise<{
  agentId: string;
  meshId: string;
  pubkey: string;
  endpoints: string[];
  observedEndpoints?: Array<{
    ip: string;
    port: number;
    protocol: string;
  }>;
  metadata?: Record<string, string>;
  lastSeen?: { seconds: bigint };
}> {
  // If we have a mesh ID hint, use it to route directly.
  // Otherwise, we need to search across all DOs (not implemented - would need a global index).
  if (!meshIdHint) {
    throw new ConnectError(
      "mesh_id hint required for agent lookup in Workers implementation",
      ConnectErrorCode.InvalidArgument
    );
  }

  const registryId = env.COLONY_REGISTRY.idFromName(meshIdHint);
  const registry = env.COLONY_REGISTRY.get(registryId);

  // Forward request to Durable Object.
  const response = await registry.fetch(
    new Request("http://internal/lookup-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    })
  );

  if (!response.ok) {
    const error = await response.json() as { error: string; code: number };
    throw new ConnectError(error.error, error.code);
  }

  const result = await response.json() as {
    agentId: string;
    meshId: string;
    pubkey: string;
    endpoints: string[];
    observedEndpoints?: Array<{
      ip: string;
      port: number;
      protocol: string;
    }>;
    metadata?: Record<string, string>;
    lastSeen?: number;
  };

  return {
    agentId: result.agentId,
    meshId: result.meshId,
    pubkey: result.pubkey,
    endpoints: result.endpoints,
    observedEndpoints: result.observedEndpoints,
    metadata: result.metadata,
    lastSeen: result.lastSeen ? { seconds: BigInt(result.lastSeen) } : undefined,
  };
}
