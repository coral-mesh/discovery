import type { Env, Config } from "../types";
import { parseConfig } from "../types";

// Track worker startup time.
const workerStartTime = Date.now();

/**
 * Handle Health RPC.
 */
export async function handleHealth(
  env: Env
): Promise<{
  status: string;
  version: string;
  uptimeSeconds: bigint;
  registeredColonies: number;
}> {
  const config = parseConfig(env);

  // Note: In a distributed system, we can't easily count all colonies.
  // This returns 0 as a placeholder - a proper implementation would need
  // a global counter or aggregation across all Durable Objects.
  return {
    status: "ok",
    version: config.serviceVersion,
    uptimeSeconds: BigInt(Math.floor((Date.now() - workerStartTime) / 1000)),
    registeredColonies: 0, // Placeholder - would need global aggregation.
  };
}
