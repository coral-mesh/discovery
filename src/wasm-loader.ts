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

/**
 * Load the crypto Wasm module.
 *
 * Note: In production, the Wasm module would be bundled with the worker.
 * This implementation provides the interface structure.
 */
export async function loadCryptoModule(): Promise<CryptoModule> {
  if (cryptoModule) {
    return cryptoModule;
  }

  // In a real implementation, we would:
  // 1. Import the Wasm module: import wasmModule from "./crypto.wasm";
  // 2. Instantiate it with Go runtime support.
  // 3. Access the exported functions.
  //
  // For now, throw an error indicating Wasm is not yet bundled.
  throw new Error("Wasm crypto module not bundled. Build with: cd wasm && make build");

  // The actual implementation would look like:
  //
  // const go = new Go();
  // const wasmInstance = await WebAssembly.instantiate(wasmModule, go.importObject);
  // go.run(wasmInstance.instance);
  //
  // cryptoModule = {
  //   createReferralTicket: (globalThis as any).coralCrypto.createReferralTicket,
  //   verifySignature: (globalThis as any).coralCrypto.verifySignature,
  //   generateKeyPair: (globalThis as any).coralCrypto.generateKeyPair,
  // };
  //
  // return cryptoModule;
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
