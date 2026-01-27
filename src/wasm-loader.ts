/**
 * Wasm Crypto Module Loader
 *
 * This module loads the TinyGo-compiled Wasm module and exposes
 * the crypto functions for JWT operations.
 */

/**
 * Result from createReferralTicket.
 */
export interface CreateTicketResult {
  jwt?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * Result from verifySignature.
 */
export interface VerifySignatureResult {
  valid?: boolean;
  error?: string;
}

/**
 * Result from generateKeyPair.
 */
export interface GenerateKeyPairResult {
  id?: string;
  privateKey?: string;
  publicKey?: string;
  jwk?: string;
  error?: string;
}

/**
 * Crypto module interface exposed by Wasm.
 */
export interface CryptoModule {
  createReferralTicket(
    privateKeyB64: string,
    keyId: string,
    reefId: string,
    colonyId: string,
    agentId: string,
    intent: string,
    ttlSeconds: number
  ): CreateTicketResult;

  verifySignature(tokenString: string, jwksJSON: string): VerifySignatureResult;

  generateKeyPair(): GenerateKeyPairResult;
}

// Global instance cache.
let cryptoModule: CryptoModule | null = null;

// Note: We would typically include wasm_exec.js for Go/TinyGo support.
// In a Cloudflare Workers environment, we can use a bundled version.

/**
 * Load the crypto Wasm module.
 */
export async function loadCryptoModule(): Promise<CryptoModule> {
  if (cryptoModule) {
    return cryptoModule;
  }

  // Implementation for demonstration purposes.
  // In a real production deployment with TinyGo, you would:
  // 1. Ensure crypto.wasm is in the src directory.
  // 2. Import it: import wasmModule from "./crypto.wasm";
  // 3. Initialize the Go runtime: const go = new Go(); 
  // 4. Instantiate: const instance = await WebAssembly.instantiate(wasmModule, go.importObject);
  
  throw new Error(
    "Wasm module 'crypto.wasm' not found or not initialized. " +
    "Ensure it is built and bundled correctly."
  );
}

/**
 * Check if the crypto module is available.
 */
export function isCryptoModuleAvailable(): boolean {
  return cryptoModule !== null;
}

/**
 * Reset the crypto module (for testing).
 */
export function resetCryptoModule(): void {
  cryptoModule = null;
}
