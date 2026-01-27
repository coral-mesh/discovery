import type { Env } from "../types";
import { ConnectError, ConnectErrorCode } from "../registry";
import type { Logger } from "../logger";

/**
 * Handle LookupColony RPC.
 */
export async function handleLookupColony(
  env: Env,
  request: { meshId: string },
  log?: Logger
): Promise<{
  meshId: string;
  pubkey: string;
  endpoints: string[];
  meshIpv4?: string;
  meshIpv6?: string;
  connectPort?: number;
  publicPort?: number;
  metadata?: Record<string, string>;
  lastSeen?: string; // RFC 3339 string for ProtoJSON compatibility.
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
      value: string; // Base64 encoded bytes for ProtoJSON compatibility.
    };
  };
}> {
  log?.debug(`[Handler] LookupColony: meshId=${request.meshId}`);

  // Get the Durable Object for this mesh.
  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
  log?.debug(`[Handler] LookupColony: DO id=${registryId.toString()}`);
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
    lastSeen: result.lastSeen ? new Date(result.lastSeen).toISOString() : undefined,
    observedEndpoints: result.observedEndpoints,
    nat: result.nat,
    publicEndpoint: result.publicEndpoint
      ? {
          ...result.publicEndpoint,
          caFingerprint: result.publicEndpoint.caFingerprint
            ? {
                algorithm: result.publicEndpoint.caFingerprint.algorithm,
                value: result.publicEndpoint.caFingerprint.value, // value is already base64 string
              }
            : undefined,
        }
      : undefined,
  };
}

/**
 * Handle LookupAgent RPC.
 *
 * Note: The Workers implementation requires meshId to route to the correct
 * Durable Object. Clients should include meshId in the request body.
 */
export async function handleLookupAgent(
  env: Env,
  request: { agentId: string; meshId?: string },
  log?: Logger
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
  lastSeen?: string; // RFC 3339 string for ProtoJSON compatibility.
}> {
  log?.debug(`[Handler] LookupAgent: agentId=${request.agentId}, meshId=${request.meshId}`);

  // Workers implementation requires meshId to route to the correct Durable Object.
  // The original Go server maintains a global index, but Workers uses partitioned DOs.
  if (!request.meshId) {
    throw new ConnectError(
      "mesh_id required for agent lookup in Workers implementation (include meshId in request body)",
      ConnectErrorCode.InvalidArgument
    );
  }

  const registryId = env.COLONY_REGISTRY.idFromName(request.meshId);
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
    lastSeen: result.lastSeen ? new Date(result.lastSeen).toISOString() : undefined,
  };
}
