.PHONY: build clean deps

# Build the Wasm module using TinyGo.
build: deps
	tinygo build -o ../src/crypto.wasm -target wasm -no-debug ./main.go

# Tidy dependencies.
deps:
	go mod tidy

# Clean build artifacts.
clean:
	rm -f ../src/crypto.wasm
