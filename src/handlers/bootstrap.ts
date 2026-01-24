import type { Env } from "../types";
import { ConnectError, ConnectErrorCode } from "../registry";

/**
 * Handle CreateBootstrapToken RPC.
 *
 * This handler creates JWT tokens for agent bootstrap.
 * It requires the DISCOVERY_SIGNING_KEY secret to be set.
 *
 * Note: In the full implementation, this would use the Wasm crypto module.
 * For now, this is a placeholder that shows the structure.
 */
export async function handleCreateBootstrapToken(
  env: Env,
  request: {
    reefId: string;
    colonyId: string;
    agentId: string;
    intent: string;
  }
): Promise<{
  jwt: string;
  expiresAt: bigint;
}> {
  // Validate required fields.
  if (!request.reefId) {
    throw new ConnectError("reef_id is required", ConnectErrorCode.InvalidArgument);
  }
  if (!request.colonyId) {
    throw new ConnectError("colony_id is required", ConnectErrorCode.InvalidArgument);
  }
  if (!request.agentId) {
    throw new ConnectError("agent_id is required", ConnectErrorCode.InvalidArgument);
  }
  if (!request.intent) {
    throw new ConnectError("intent is required", ConnectErrorCode.InvalidArgument);
  }

  // Check for signing key.
  if (!env.DISCOVERY_SIGNING_KEY) {
    throw new ConnectError(
      "DISCOVERY_SIGNING_KEY not configured",
      ConnectErrorCode.Internal
    );
  }

  // TODO: Use Wasm crypto module to create JWT.
  // For now, return a placeholder error indicating Wasm is not loaded.
  throw new ConnectError(
    "Wasm crypto module not loaded - CreateBootstrapToken requires Wasm integration",
    ConnectErrorCode.Unimplemented
  );

  // The actual implementation would be:
  // const crypto = await loadCryptoModule();
  // const result = crypto.createReferralTicket(
  //   env.DISCOVERY_SIGNING_KEY,
  //   keyId,
  //   request.reefId,
  //   request.colonyId,
  //   request.agentId,
  //   request.intent,
  //   60 // TTL in seconds.
  // );
  //
  // return {
  //   jwt: result.jwt,
  //   expiresAt: BigInt(result.expiresAt),
  // };
}
