# Multi-stage build for Cloudflare Worker
# Stage 1: Build Wasm (using TinyGo)
FROM tinygo/tinygo:0.33.0 AS wasm-builder

USER root

WORKDIR /build

# Copy coral-crypto as it is a dependency
COPY coral-crypto /coral-crypto

# Copy wasm module source
COPY coral-discovery-workers/wasm /build/wasm

# Build Wasm
WORKDIR /build/wasm
# Ensure dependencies are available and go.sum is up to date
RUN go mod tidy

# We need to ensure go.mod points to correct location
# Since we copied coral-crypto to /coral-crypto, we might need to adjust replace directive or rely on it being correct relative to build context?
# In go.mod: replace ... => ../../coral-crypto
# If we are in /build/wasm, ../../coral-crypto resolves to /coral-crypto. Correct.
RUN tinygo build -o crypto.wasm -target wasm -no-debug ./main.go

# Stage 2: Runtime (Node.js)
FROM node:20-slim

# Install curl for healthchecks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY coral-discovery-workers/package.json coral-discovery-workers/package-lock.json* ./

# Install dependencies
RUN npm install --legacy-peer-deps


# Copy source code
COPY coral-discovery-workers/ .

# Copy built wasm from builder
COPY --from=wasm-builder /build/wasm/crypto.wasm ./src/crypto.wasm

# Create .dev.vars file for wrangler dev (secrets in dev mode)
RUN echo 'DISCOVERY_SIGNING_KEY={"id":"01H7X0X7X0X7X0X7X0X7X0X7X0","privateKey":"hXIqNNX5M2H9WuNmTPcAYgwRSWpJMqONpL3HPPoxsdoitbpmLL7H2ArTXJV0YXj89bxfbePj0GTKqEB+N9g8SA=="}' > .dev.vars

# Expose port
EXPOSE 8080

# Run wrangler dev
# --ip 0.0.0.0 to bind to all interfaces
# --persist-to enables local SQLite persistence for Durable Objects
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8080", "--persist-to", "/tmp/wrangler-persist"]
