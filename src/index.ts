/**
 * Coral Discovery Service - Cloudflare Workers Implementation
 *
 * This implements the DiscoveryService proto via buf connect protocol.
 * It uses Durable Objects with SQLite for persistent storage.
 */

import type { Env } from "./types";
import { parseConfig } from "./types";
import { ColonyRegistry, ConnectError, ConnectErrorCode } from "./registry";
import { handleRegisterColony, handleRegisterAgent } from "./handlers/register";
import { handleLookupColony, handleLookupAgent } from "./handlers/lookup";
import { handleHealth } from "./handlers/health";
import { handleCreateBootstrapToken } from "./handlers/bootstrap";

// Re-export Durable Object class.
export { ColonyRegistry };

/**
 * Main worker handler.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Get client IP from Cloudflare headers.
    const clientIP = request.headers.get("CF-Connecting-IP") || undefined;

    try {
      // Handle Connect protocol routes.
      // Connect uses POST with paths like /coral.discovery.v1.DiscoveryService/RegisterColony
      if (method === "POST" && path.startsWith("/coral.discovery.v1.DiscoveryService/")) {
        return await handleConnectRequest(request, env, path, clientIP);
      }

      // Handle JWKS endpoint for token verification.
      if (method === "GET" && path === "/.well-known/jwks.json") {
        return handleJWKS(env);
      }

      // Handle simple health check.
      if (method === "GET" && path === "/health") {
        return Response.json({
          status: "ok",
          version: parseConfig(env).serviceVersion,
        });
      }

      // Not found.
      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("Worker error:", err);

      if (err instanceof ConnectError) {
        return createConnectErrorResponse(err);
      }

      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

/**
 * Handle Connect protocol requests.
 */
async function handleConnectRequest(
  request: Request,
  env: Env,
  path: string,
  clientIP?: string
): Promise<Response> {
  // Extract RPC name from path.
  const rpcName = path.replace("/coral.discovery.v1.DiscoveryService/", "");

  // Parse request body.
  const contentType = request.headers.get("Content-Type") || "";
  let body: unknown;

  if (contentType.includes("application/json")) {
    body = await request.json();
  } else if (contentType.includes("application/proto")) {
    // For now, we only support JSON encoding.
    return createConnectErrorResponse(
      new ConnectError("Only JSON encoding is supported", ConnectErrorCode.InvalidArgument)
    );
  } else {
    body = await request.json();
  }

  // Route to appropriate handler.
  try {
    let result: unknown;

    switch (rpcName) {
      case "RegisterColony":
        result = await handleRegisterColony(
          env,
          body as Parameters<typeof handleRegisterColony>[1],
          clientIP
        );
        break;

      case "LookupColony":
        result = await handleLookupColony(
          env,
          body as Parameters<typeof handleLookupColony>[1]
        );
        break;

      case "RegisterAgent":
        result = await handleRegisterAgent(
          env,
          body as Parameters<typeof handleRegisterAgent>[1],
          clientIP
        );
        break;

      case "LookupAgent":
        result = await handleLookupAgent(
          env,
          body as Parameters<typeof handleLookupAgent>[1]
        );
        break;

      case "Health":
        result = await handleHealth(env);
        break;

      case "CreateBootstrapToken":
        result = await handleCreateBootstrapToken(
          env,
          body as Parameters<typeof handleCreateBootstrapToken>[1]
        );
        break;

      case "RequestRelay":
      case "ReleaseRelay":
        throw new ConnectError("Relay not supported in Workers", ConnectErrorCode.Unimplemented);

      default:
        throw new ConnectError(`Unknown RPC: ${rpcName}`, ConnectErrorCode.Unimplemented);
    }

    return createConnectResponse(result);
  } catch (err) {
    if (err instanceof ConnectError) {
      return createConnectErrorResponse(err);
    }
    console.error(`Error handling ${rpcName}:`, err);
    throw err;
  }
}

/**
 * Create a Connect protocol success response.
 */
function createConnectResponse(data: unknown): Response {
  return new Response(JSON.stringify(data, bigIntReplacer), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Create a Connect protocol error response.
 */
function createConnectErrorResponse(err: ConnectError): Response {
  return new Response(
    JSON.stringify({
      code: connectCodeToString(err.code),
      message: err.message,
    }),
    {
      status: connectCodeToHTTPStatus(err.code),
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Convert Connect error code to string.
 */
function connectCodeToString(code: number): string {
  const codes: Record<number, string> = {
    0: "ok",
    1: "canceled",
    2: "unknown",
    3: "invalid_argument",
    4: "deadline_exceeded",
    5: "not_found",
    6: "already_exists",
    7: "permission_denied",
    8: "resource_exhausted",
    9: "failed_precondition",
    10: "aborted",
    11: "out_of_range",
    12: "unimplemented",
    13: "internal",
    14: "unavailable",
    15: "data_loss",
    16: "unauthenticated",
  };
  return codes[code] || "unknown";
}

/**
 * Convert Connect error code to HTTP status.
 */
function connectCodeToHTTPStatus(code: number): number {
  const statusMap: Record<number, number> = {
    0: 200, // OK
    1: 408, // Canceled -> Request Timeout
    2: 500, // Unknown -> Internal Server Error
    3: 400, // InvalidArgument -> Bad Request
    4: 408, // DeadlineExceeded -> Request Timeout
    5: 404, // NotFound -> Not Found
    6: 409, // AlreadyExists -> Conflict
    7: 403, // PermissionDenied -> Forbidden
    8: 429, // ResourceExhausted -> Too Many Requests
    9: 400, // FailedPrecondition -> Bad Request
    10: 409, // Aborted -> Conflict
    11: 400, // OutOfRange -> Bad Request
    12: 501, // Unimplemented -> Not Implemented
    13: 500, // Internal -> Internal Server Error
    14: 503, // Unavailable -> Service Unavailable
    15: 500, // DataLoss -> Internal Server Error
    16: 401, // Unauthenticated -> Unauthorized
  };
  return statusMap[code] || 500;
}

/**
 * Handle JWKS endpoint.
 */
function handleJWKS(env: Env): Response {
  // TODO: Implement JWKS endpoint with actual keys.
  // For now, return an empty JWKS.
  const jwks = {
    keys: [],
  };

  return new Response(JSON.stringify(jwks), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

/**
 * JSON replacer for BigInt values.
 */
function bigIntReplacer(key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}
