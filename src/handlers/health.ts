import type { Env } from "../types";
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

  let registeredColonies = 0;
  try {
    if (env.DISCOVERY_METRICS) {
      const metricsId = env.DISCOVERY_METRICS.idFromName("global");
      const metrics = env.DISCOVERY_METRICS.get(metricsId);
      const response = await metrics.fetch(new Request("http://internal/stats"));
      const stats = await response.json() as { activeColonies: number };
      registeredColonies = stats.activeColonies;
    }
  } catch {
    // Fall back to 0 if metrics unavailable.
  }

  return {
    status: "ok",
    version: config.serviceVersion,
    uptimeSeconds: BigInt(Math.floor((Date.now() - workerStartTime) / 1000)),
    registeredColonies,
  };
}
