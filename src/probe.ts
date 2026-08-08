/**
 * Opt-in TCP reachability probe for PSK-encrypted rendezvous publish
 * (RFD 108). Never gates publish by default — see Security Model item 9 in
 * the RFD: an unauthenticated "connect to whatever the caller says" gate is
 * a public internet scanning primitive when mesh_id costs nothing to
 * generate, so this is only invoked when the caller explicitly opts in via
 * verify_reachability=true, and even then only after the abuse controls in
 * quota.ts allow it.
 */

const PROBE_TIMEOUT_MS = 2000;

/**
 * Split an "ip:port" or "[ipv6]:port" endpoint into host and port parts.
 * Returns nulls if the endpoint can't be parsed.
 */
export function splitHostPort(endpoint: string): { host: string; port: number } | null {
  if (!endpoint) return null;

  if (endpoint.startsWith("[")) {
    const closeIdx = endpoint.indexOf("]");
    if (closeIdx === -1) return null;
    const host = endpoint.slice(1, closeIdx);
    const rest = endpoint.slice(closeIdx + 1);
    if (!rest.startsWith(":")) return null;
    const port = Number.parseInt(rest.slice(1), 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  }

  const idx = endpoint.lastIndexOf(":");
  if (idx === -1) return null;
  const host = endpoint.slice(0, idx);
  const port = Number.parseInt(endpoint.slice(idx + 1), 10);
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Deny-list for the reachability probe: private/loopback/link-local/
 * cloud-metadata ranges. This protects honest operators from a
 * misconfiguration that would otherwise SSRF the Worker into its own
 * private network; it is not a defense against a malicious publisher (they
 * gain nothing from lying about probe_endpoint — see RFD 108 Trust
 * Assumptions item 8).
 */
export function isDeniedProbeTarget(host: string): boolean {
  if (!host) return true;

  const lower = host.toLowerCase();
  if (lower === "localhost") return true;

  // IPv4 loopback / RFC1918 / link-local (includes the cloud metadata
  // address 169.254.169.254).
  if (host === "127.0.0.1" || host.startsWith("127.")) return true;
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.startsWith("169.254.")) return true;

  // IPv6 loopback / unique-local / link-local.
  if (host === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (lower.startsWith("fe80")) return true;

  return false;
}

/**
 * Synchronously TCP-connect to endpoint and immediately close, proving
 * reachability without exchanging any application data. Returns false for
 * any parse error, deny-listed target, timeout, or connection failure.
 */
export async function probeReachability(endpoint: string | undefined): Promise<boolean> {
  if (!endpoint) return false;

  const parsed = splitHostPort(endpoint);
  if (!parsed) return false;
  if (isDeniedProbeTarget(parsed.host)) return false;

  // Imported lazily so environments/tests that don't need real sockets
  // (e.g. unit tests of the deny-list logic above) don't pay for it.
  const { connect } = await import("cloudflare:sockets");

  let socket: { close(): Promise<void>; opened: Promise<unknown> } | undefined;
  try {
    socket = connect({ hostname: parsed.host, port: parsed.port }) as unknown as {
      close(): Promise<void>;
      opened: Promise<unknown>;
    };

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS);
    });

    await Promise.race([socket.opened, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (socket) {
      try {
        await socket.close();
      } catch {
        // Best-effort close; connection may already be gone.
      }
    }
  }
}
