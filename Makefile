.PHONY: all install dev deploy generate test test-watch typecheck wasm wasm-clean clean docker-build docker-run help

# Default target
all: install wasm

# Install npm dependencies
install:
	npm install --legacy-peer-deps

# Run development server
dev:
	npm run dev

# Deploy to Cloudflare
deploy:
	npm run deploy

# Generate protobuf code
generate:
	npm run generate

# Run tests
test:
	npm run test

# Run tests in watch mode
test-watch:
	npm run test:watch

# Run TypeScript type checking
typecheck:
	npm run typecheck

# Build Wasm module
wasm:
	cd wasm && $(MAKE) build

# Clean Wasm artifacts
wasm-clean:
	cd wasm && $(MAKE) clean

# Clean all build artifacts
clean: wasm-clean
	rm -rf node_modules
	rm -rf .wrangler

# Build Docker image (run from parent directory with coral-crypto available)
docker-build:
	cd .. && docker build -f coral-discovery-workers/Dockerfile -t coral-discovery-workers .

# Run Docker container
docker-run:
	docker run -p 8080:8080 coral-discovery-workers

# Show help
help:
	@echo "Available targets:"
	@echo "  all          - Install dependencies and build wasm (default)"
	@echo "  install      - Install npm dependencies"
	@echo "  dev          - Run development server"
	@echo "  deploy       - Deploy to Cloudflare"
	@echo "  generate     - Generate protobuf code"
	@echo "  test         - Run tests"
	@echo "  test-watch   - Run tests in watch mode"
	@echo "  typecheck    - Run TypeScript type checking"
	@echo "  wasm         - Build Wasm module"
	@echo "  wasm-clean   - Clean Wasm artifacts"
	@echo "  clean        - Clean all build artifacts"
	@echo "  docker-build - Build Docker image"
	@echo "  docker-run   - Run Docker container"
	@echo "  help         - Show this help"
