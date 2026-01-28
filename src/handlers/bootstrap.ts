import type { Env } from "../types";
import { ConnectError, ConnectErrorCode } from "../registry";
import { getSigningKeys, createJWT, ensureKeysLoaded } from "../crypto";
import type { Logger } from "../logger";

/**
 * Handle CreateBootstrapToken RPC.
 *
 * This handler creates JWT tokens for agent bootstrap (RFD 049).
 * It requires the DISCOVERY_SIGNING_KEY secret to be set.
 */
export async function handleCreateBootstrapToken(
  env: Env,
  request: {
    reefId: string;
    colonyId: string;
    agentId: string;
    intent: string;
  },
  log?: Logger
): Promise<{
  jwt: string;
  expiresAt: bigint;
}> {
  log?.debug(`[Handler] CreateBootstrapToken: reefId=${request.reefId}, colonyId=${request.colonyId}, agentId=${request.agentId}, intent=${request.intent}`);

  // Validate required fields.
  if (!request.reefId) {
    throw new ConnectError(
      "reef_id is required",
      ConnectErrorCode.InvalidArgument,
    );
  }
  if (!request.colonyId) {
    throw new ConnectError(
      "colony_id is required",
      ConnectErrorCode.InvalidArgument,
    );
  }
  if (!request.agentId) {
    throw new ConnectError(
      "agent_id is required",
      ConnectErrorCode.InvalidArgument,
    );
  }
  if (!request.intent) {
    throw new ConnectError(
      "intent is required",
      ConnectErrorCode.InvalidArgument,
    );
  }

  // Check for signing key (from secret or env var in dev mode).
  const signingKey =
    env.DISCOVERY_SIGNING_KEY || (env as any).DISCOVERY_SIGNING_KEY_DEV;
  if (!signingKey) {
    throw new ConnectError(
      "DISCOVERY_SIGNING_KEY not configured",
      ConnectErrorCode.Internal,
    );
  }

  // Get signing keys (this will load them if not already loaded).
  const keys = await getSigningKeys(env);
  await ensureKeysLoaded(env);
  
  if (!keys.currentKey) {
    throw new ConnectError(
      "No signing key available",
      ConnectErrorCode.Internal
    );
  }

  // Create JWT with 60 second TTL.
  // We need to parse the JSON key again to get the base64 private key for Wasm.
  const keyData = JSON.parse(signingKey) as { id: string; privateKey: string };
  
  const ttlSeconds = 60;
  const result = await createJWT(
    env,
    keys.currentKey,
    request.reefId,
    request.colonyId,
    request.agentId,
    request.intent,
    ttlSeconds,
    keyData.privateKey
  );

  return {
    jwt: result.token,
    expiresAt: BigInt(result.expiresAt),
  };
}
