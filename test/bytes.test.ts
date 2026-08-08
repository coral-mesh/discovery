import { describe, it, expect } from "vitest";
import { base64ToBytes, sha256Hex, constantTimeEqualHex, generateRecordID } from "../src/bytes";

describe("base64ToBytes", () => {
  it("round-trips standard base64", () => {
    const bytes = base64ToBytes(btoa("hello world"));
    expect(new TextDecoder().decode(bytes)).toBe("hello world");
  });

  it("handles URL-safe base64 without padding", () => {
    const standard = btoa("write-token-value");
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(base64ToBytes(urlSafe)).toEqual(base64ToBytes(standard));
  });
});

describe("sha256Hex", () => {
  it("is deterministic for the same input", async () => {
    const bytes = base64ToBytes(btoa("write-token-value"));
    const a = await sha256Hex(bytes);
    const b = await sha256Hex(bytes);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different input", async () => {
    const a = await sha256Hex(base64ToBytes(btoa("token-a")));
    const b = await sha256Hex(base64ToBytes(btoa("token-b")));
    expect(a).not.toBe(b);
  });
});

describe("constantTimeEqualHex", () => {
  it("returns true for identical hex strings", () => {
    expect(constantTimeEqualHex("abcd1234", "abcd1234")).toBe(true);
  });

  it("returns false for different hex strings of the same length", () => {
    expect(constantTimeEqualHex("abcd1234", "abcd1235")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(constantTimeEqualHex("abcd", "abcd1234")).toBe(false);
  });
});

describe("generateRecordID", () => {
  it("generates unique, non-empty IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRecordID()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
