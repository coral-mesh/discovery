//go:build tinygo.wasm || js

// Package main provides Wasm entrypoint for coral-crypto operations.
// This is compiled with TinyGo and bundled with the Cloudflare Worker.
package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/coral-mesh/coral-crypto/jwt"
	"github.com/coral-mesh/coral-crypto/keys"
)

func main() {
	// Register functions for JavaScript interop.
	js.Global().Set("coralCrypto", js.ValueOf(map[string]interface{}{
		"createReferralTicket": js.FuncOf(createReferralTicket),
		"verifySignature":      js.FuncOf(verifySignature),
		"generateKeyPair":      js.FuncOf(generateKeyPair),
	}))

	// Keep the program running.
	select {}
}

// createReferralTicket creates a new referral ticket JWT.
// Arguments: privateKeyB64, keyID, reefID, colonyID, agentID, intent, ttlSeconds
// Returns: { jwt: string, expiresAt: number } or { error: string }
func createReferralTicket(this js.Value, args []js.Value) interface{} {
	if len(args) < 7 {
		return map[string]interface{}{
			"error": "expected 7 arguments: privateKeyB64, keyID, reefID, colonyID, agentID, intent, ttlSeconds",
		}
	}

	privateKeyB64 := args[0].String()
	keyID := args[1].String()
	reefID := args[2].String()
	colonyID := args[3].String()
	agentID := args[4].String()
	intent := args[5].String()
	ttlSeconds := args[6].Int()

	// Decode private key.
	privateKey, err := keys.DecodePrivateKey(privateKeyB64)
	if err != nil {
		return map[string]interface{}{
			"error": "failed to decode private key: " + err.Error(),
		}
	}

	// Create token.
	token, expiresAt, err := jwt.CreateReferralTicketStatic(
		privateKey,
		keyID,
		reefID,
		colonyID,
		agentID,
		intent,
		ttlSeconds,
		"", "", // Use defaults for issuer and audience.
	)
	if err != nil {
		return map[string]interface{}{
			"error": "failed to create token: " + err.Error(),
		}
	}

	return map[string]interface{}{
		"jwt":       token,
		"expiresAt": expiresAt,
	}
}

// verifySignature verifies a JWT signature against JWKS.
// Arguments: tokenString, jwksJSON
// Returns: { valid: boolean } or { error: string }
func verifySignature(this js.Value, args []js.Value) interface{} {
	if len(args) < 2 {
		return map[string]interface{}{
			"error": "expected 2 arguments: tokenString, jwksJSON",
		}
	}

	tokenString := args[0].String()
	jwksJSON := args[1].String()

	valid, err := jwt.VerifySignatureStatic(tokenString, jwksJSON)
	if err != nil {
		return map[string]interface{}{
			"error": err.Error(),
		}
	}

	return map[string]interface{}{
		"valid": valid,
	}
}

// generateKeyPair generates a new Ed25519 key pair.
// Returns: { id, privateKey, publicKey, jwk } or { error: string }
func generateKeyPair(this js.Value, args []js.Value) interface{} {
	kp, err := keys.GenerateKeyPair()
	if err != nil {
		return map[string]interface{}{
			"error": "failed to generate key pair: " + err.Error(),
		}
	}

	jwk := kp.ToJWK()
	jwkJSON, err := json.Marshal(jwk)
	if err != nil {
		return map[string]interface{}{
			"error": "failed to marshal JWK: " + err.Error(),
		}
	}

	return map[string]interface{}{
		"id":         kp.ID,
		"privateKey": keys.EncodePrivateKey(kp.PrivateKey),
		"publicKey":  keys.EncodePublicKey(kp.PublicKey),
		"jwk":        string(jwkJSON),
	}
}
