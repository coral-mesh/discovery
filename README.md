# coral-discovery-workers

Cloudflare Workers implementation of the
[Coral](https://github.com/coral-mesh) mesh discovery service. Uses Durable
Objects with SQLite for persistent colony and agent registration, and the
[Connect Protocol](https://connectrpc.com/) for RPC transport.

## Architecture

```
HTTP → Worker (index.ts) → Handler → Durable Object (ColonyRegistry)
                                          ↓
                                     SQLite storage
```

Requests are routed by `mesh_id` to a Durable Object instance, giving each mesh
its own isolated SQLite database with automatic TTL-based cleanup via alarms.

## RPC Endpoints

All RPCs are served at `/coral.discovery.v1.DiscoveryService/{Method}` using the
Connect protocol (unary, POST, JSON).

| Method                 | Description                              |
|------------------------|------------------------------------------|
| `RegisterColony`       | Register or update a colony              |
| `LookupColony`         | Look up a colony by mesh ID              |
| `RegisterAgent`        | Register or update an agent              |
| `LookupAgent`          | Look up an agent by ID and mesh ID       |
| `CreateBootstrapToken` | Issue a signed Ed25519 JWT for bootstrap |
| `Health`               | Service health check                     |

Additional routes:

- `GET /.well-known/jwks.json` — public JWKS for token verification
- `GET /health` — HTTP health check

## Development

```sh
make install       # Install dependencies
make wasm          # Build TinyGo Wasm module
npm run generate   # Generate protobuf TypeScript from proto/
npm run dev        # Start wrangler dev server
npm run test       # Run tests
make typecheck     # Type-check with tsc
```

## Docker

```sh
make docker-build  # Multi-stage build (TinyGo + Node.js)
make docker-run    # Run on port 8080
```

## Deployment

```sh
make deploy        # Deploy to Cloudflare Workers
```

Required secrets (set via `wrangler secret put`):

- `DISCOVERY_SIGNING_KEY` — JSON `{id, privateKey}` with base64-encoded Ed25519
  private key

## Configuration

Environment variables in `wrangler.toml`:

| Variable              | Default | Description                  |
|-----------------------|---------|------------------------------|
| `DEFAULT_TTL_SECONDS` | `300`   | Registration TTL             |
| `CLEANUP_INTERVAL_MS` | `60000` | Expired entry cleanup period |
| `LOG_LEVEL`           | `info`  | debug, info, warn, error     |
| `USE_WASM_CRYPTO`     | `false` | Use TinyGo Wasm for crypto   |

## Related

- [coral-crypto](https://github.com/coral-mesh/coral-crypto) — shared Go
  cryptographic library (JWT, keys, fingerprinting)
