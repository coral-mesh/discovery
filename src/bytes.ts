/**
 * Byte/base64/hash helpers used by the PSK-encrypted rendezvous handlers
 * (RFD 108). `bytes` proto fields travel over ProtoJSON as base64 strings;
 * these helpers convert between that wire representation and raw bytes only
 * where an actual computation (hashing) requires it — ciphertext and
 * gcm_nonce are otherwise kept as opaque base64 strings end-to-end, exactly
 * like `caFingerprint.value` elsewhere in this codebase.
 */

/**
 * Decode a (possibly URL-safe) base64 string to raw bytes.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compute the SHA-256 hash of bytes, returned as a lowercase hex string.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two equal-length hex strings. Used to compare
 * write_token hashes without leaking timing information about where a
 * mismatch occurs.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Generate a ULID-like, sortable, unique record identifier. Not a strict
 * ULID implementation (no crockford base32 timestamp encoding), but unique,
 * monotonic-ish, and URL-safe — sufficient for an opaque record_id that
 * only this service interprets.
 */
export function generateRecordID(): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const randStr = Array.from(rand)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("");
  return `${time}${randStr}`;
}
