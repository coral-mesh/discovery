/**
 * Environment bindings for the Cloudflare Worker.
 */
export interface Env {
  // Durable Object bindings.
  COLONY_REGISTRY: DurableObjectNamespace;
  DISCOVERY_METRICS: DurableObjectNamespace;

  // Environment variables.
  ENVIRONMENT: string;
  SERVICE_VERSION: string;
  DEFAULT_TTL_SECONDS: string;
  CLEANUP_INTERVAL_MS: string;
  USE_WASM_CRYPTO?: string; // Set to "true" to use Wasm implementation.
  LOG_LEVEL?: string; // "debug", "info", "warn", "error", "silent"

  // Secrets (set via wrangler secret).
  DISCOVERY_SIGNING_KEY?: string;
}

/**
 * Configuration derived from environment variables.
 */
export interface Config {
  environment: string;
  serviceVersion: string;
  defaultTTLSeconds: number;
  cleanupIntervalMs: number;
  useWasmCrypto: boolean;
}

/**
 * Parse environment variables into config.
 */
export function parseConfig(env: Env): Config {
  return {
    environment: env.ENVIRONMENT || "development",
    serviceVersion: env.SERVICE_VERSION || "0.0.0",
    defaultTTLSeconds: parseInt(env.DEFAULT_TTL_SECONDS || "300", 10),
    cleanupIntervalMs: parseInt(env.CLEANUP_INTERVAL_MS || "60000", 10),
    useWasmCrypto: env.USE_WASM_CRYPTO === "true",
  };
}

/**
 * Colony record stored in SQLite.
 */
export interface ColonyRecord {
  meshId: string;
  pubkey: string;
  endpoints: string[]; // JSON serialized.
  meshIpv4?: string;
  meshIpv6?: string;
  connectPort?: number;
  publicPort?: number;
  metadata?: Record<string, string>; // JSON serialized.
  observedEndpoint?: EndpointRecord;
  publicEndpoint?: PublicEndpointRecord;
  natHint: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/**
 * Agent record stored in SQLite.
 */
export interface AgentRecord {
  agentId: string;
  meshId: string;
  pubkey: string;
  endpoints: string[];
  observedEndpoint?: EndpointRecord;
  metadata?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/**
 * Endpoint information.
 */
export interface EndpointRecord {
  ip: string;
  port: number;
  protocol: string;
  viaRelay?: boolean;
}

/**
 * Public endpoint information (RFD 085).
 */
export interface PublicEndpointRecord {
  enabled: boolean;
  url?: string;
  caCert?: string;
  caFingerprint?: {
    algorithm: number;
    value: string; // Base64 encoded bytes for ProtoJSON compatibility.
  };
  updatedAt?: number;
}
