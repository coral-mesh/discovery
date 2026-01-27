/**
 * Crypto operations for Discovery service using Web Crypto API.
 *
 * Cloudflare Workers support Ed25519 via the Web Crypto API, so we don't
 * need Wasm for basic signing operations. This module handles:
 * - Key parsing from base64-encoded secrets
 * - JWT creation with Ed25519 signatures
 * - JWKS generation for public key distribution
 */

import type { Env } from "./types";
import { parseConfig } from "./types";
import { loadCryptoModule, isCryptoModuleAvailable } from "./wasm-loader";

/**
 * Ed25519 key pair for signing.
 */
export interface SigningKey {
  id: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

/**
 * Signing keys container.
 */
export interface SigningKeys {
  currentKey: SigningKey | null;
  previousKeys: SigningKey[];
}

/**
 * JWK representation for JWKS endpoint.
 */
export interface JWK {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  use: string;
  alg: string;
}

/**
 * JWKS response structure.
 */
export interface JWKS {
  keys: JWK[];
}

// Cache for parsed keys.
let cachedKeys: SigningKeys | null = null;
let cachedKeySource: string | null = null;

/**
 * Get signing keys from environment.
 *
 * The DISCOVERY_SIGNING_KEY secret should be a JSON object:
 * {
 *   "id": "key-id-ulid",
 *   "privateKey": "base64-encoded-64-byte-ed25519-private-key"
 * }
 *
 * Optionally, DISCOVERY_PREVIOUS_KEYS can be a JSON array of previous keys
 * for key rotation support.
 */
export function getSigningKeys(env: Env): SigningKeys {
  const keySource = env.DISCOVERY_SIGNING_KEY || "";

  // Return cached keys if source hasn't changed.
  if (cachedKeys && cachedKeySource === keySource) {
    return cachedKeys;
  }

  cachedKeys = {
    currentKey: null,
    previousKeys: [],
  };
  cachedKeySource = keySource;

  if (!keySource) {
    return cachedKeys;
  }

  // Parse will happen lazily on first use.
  return cachedKeys;
}

/**
 * Parse and import the signing key from environment.
 * This is async because CryptoKey import is async.
 */
export async function ensureKeysLoaded(env: Env): Promise<SigningKeys> {
  const keys = getSigningKeys(env);

  // If already loaded, return.
  if (keys.currentKey !== null) {
    return keys;
  }

  if (!env.DISCOVERY_SIGNING_KEY) {
    return keys;
  }

  try {
    const keyData = JSON.parse(env.DISCOVERY_SIGNING_KEY) as {
      id: string;
      privateKey: string;
    };

    const privateKeyBytes = base64ToBytes(keyData.privateKey);

    // Ed25519 private key is 64 bytes (32 byte seed + 32 byte public key).
    if (privateKeyBytes.length !== 64 && privateKeyBytes.length !== 32) {
      console.error(`Invalid private key length: ${privateKeyBytes.length}`);
      return keys;
    }

    // For Ed25519 in Web Crypto API, we need to import the private key in JWK or PKCS8 format.
    // "raw" format is only supported for public keys.
    const seed = privateKeyBytes.length === 64 ? privateKeyBytes.slice(0, 32) : privateKeyBytes;
    const pubBytes = privateKeyBytes.length === 64 ? privateKeyBytes.slice(32) : new Uint8Array(0); // Optional for private JWK but good to have

    if (seed.length !== 32) {
      console.error(`Invalid Ed25519 seed length: ${seed.length}`);
      return keys;
    }

    // Import the private key using JWK format.
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "OKP",
        crv: "Ed25519",
        d: base64UrlEncodeBytes(seed),
        x: pubBytes.length === 32 ? base64UrlEncodeBytes(pubBytes) : "",
        ext: true,
      },
      { name: "Ed25519" },
      false,
      ["sign"]
    );

    // Use provided public key bytes or derive them (if possible).
    let publicKeyBytes: Uint8Array;
    if (privateKeyBytes.length === 64) {
      publicKeyBytes = pubBytes;
    } else {
      // For 32-byte seed, we can't easily derive the public key in Web Crypto.
      console.error("32-byte seed format requires public key derivation - not supported");
      return keys;
    }

    console.log(`Importing Ed25519 key: seed length=${seed.length}, pubkey length=${publicKeyBytes.length}`);
    
    // Import public key for JWKS export.
    try {
      const publicKey = await crypto.subtle.importKey(
        "raw",
        publicKeyBytes,
        { name: "Ed25519" },
        true,
        ["verify"]
      );

      keys.currentKey = {
        id: keyData.id,
        privateKey,
        publicKey,
        publicKeyBytes,
      };
      
      console.log(`Successfully loaded signing key: ${keyData.id}`);
    } catch (pubKeyErr) {
      console.error("Failed to import public key:", pubKeyErr);
      throw pubKeyErr;
    }
  } catch (err) {
    console.error("Failed to parse signing key:", err);
  }

  return keys;
}

/**
 * Create a JWT for agent bootstrap.
 * Uses Web Crypto by default, or Wasm if USE_WASM_CRYPTO is "true".
 */
export async function createJWT(
  env: Env,
  key: SigningKey,
  reefId: string,
  colonyId: string,
  agentId: string,
  intent: string,
  ttlSeconds: number,
  privateKeyB64: string // Needed for Wasm implementation.
): Promise<{ token: string; expiresAt: number }> {
  const config = parseConfig(env);

  if (config.useWasmCrypto) {
    try {
      const wasm = await loadCryptoModule();
      const result = wasm.createReferralTicket(
        privateKeyB64,
        key.id,
        reefId,
        colonyId,
        agentId,
        intent,
        ttlSeconds
      );

      if (result.error) {
        throw new Error(`Wasm JWT error: ${result.error}`);
      }

      return {
        token: result.jwt!,
        expiresAt: result.expiresAt!,
      };
    } catch (err) {
      console.error("Wasm JWT failed, falling back to Web Crypto:", err);
    }
  }

  // Native Web Crypto implementation (Default).
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;

  // JWT header.
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: key.id,
  };

  // JWT claims (RFD 049 format).
  const claims = {
    jti: crypto.randomUUID(),
    iss: "coral-discovery",
    aud: ["coral-colony"],
    iat: now,
    exp: expiresAt,
    reef_id: reefId,
    colony_id: colonyId,
    agent_id: agentId,
    intent: intent,
  };

  // Encode header and payload.
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(claims));
  const message = `${headerB64}.${payloadB64}`;

  // Sign with Ed25519.
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key.privateKey,
    new TextEncoder().encode(message)
  );

  const signatureB64 = base64UrlEncodeBytes(new Uint8Array(signature));
  const token = `${message}.${signatureB64}`;

  return { token, expiresAt };
}

/**
 * Get JWKS for the current and previous signing keys.
 */
export async function getJWKS(env: Env): Promise<JWKS> {
  const keys = await ensureKeysLoaded(env);

  const jwks: JWKS = { keys: [] };

  if (keys.currentKey) {
    jwks.keys.push(keyToJWK(keys.currentKey));
  }

  for (const key of keys.previousKeys) {
    jwks.keys.push(keyToJWK(key));
  }

  return jwks;
}

/**
 * Convert a signing key to JWK format.
 */
function keyToJWK(key: SigningKey): JWK {
  return {
    kid: key.id,
    kty: "OKP",
    crv: "Ed25519",
    x: base64UrlEncodeBytes(key.publicKeyBytes),
    use: "sig",
    alg: "EdDSA",
  };
}

/**
 * Base64 URL encode a string.
 */
function base64UrlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return base64UrlEncodeBytes(bytes);
}

/**
 * Base64 URL encode bytes.
 */
function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode base64 to bytes.
 */
function base64ToBytes(base64: string): Uint8Array {
  // Handle both standard and URL-safe base64.
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
