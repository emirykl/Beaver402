import { describe, it, expect } from "vitest";
import { isoCBOR } from "@simplewebauthn/server/helpers";

import { coseToOwnerKey, ownerKeyToHex } from "../src/passkey/owner-key.js";

/** Describe a key the way an authenticator describes one. */
function coseKey(
  x: Uint8Array,
  y: Uint8Array,
  overrides: Map<number, unknown> = new Map()
): Uint8Array {
  const map = new Map<number, unknown>([
    [1, 2], // key type: elliptic curve
    [3, -7], // algorithm: ES256
    [-1, 1], // curve: P-256
    [-2, x],
    [-3, y],
  ]);
  for (const [key, value] of overrides) {
    map.set(key, value);
  }
  return new Uint8Array(isoCBOR.encode(map));
}

describe("reading the owner key out of a registered passkey", () => {
  const x = new Uint8Array(32).fill(0xaa);
  const y = new Uint8Array(32).fill(0xbb);

  it("produces the uncompressed point the contract stores", () => {
    const key = coseToOwnerKey(coseKey(x, y));

    expect(key.length).toBe(65);
    expect(key[0]).toBe(0x04);
  });

  it("keeps both coordinates in order", () => {
    const key = coseToOwnerKey(coseKey(x, y));

    expect(key.subarray(1, 33)).toEqual(Buffer.from(x));
    expect(key.subarray(33)).toEqual(Buffer.from(y));
  });

  it("hands the deploy script plain hex", () => {
    const hex = ownerKeyToHex(coseKey(x, y));

    expect(hex).toHaveLength(130);
    expect(hex.startsWith("04")).toBe(true);
    expect(hex).toBe(`04${"aa".repeat(32)}${"bb".repeat(32)}`);
  });

  it("says so when the passkey is on a curve the contract cannot verify", () => {
    // An Ed25519 passkey, which some authenticators offer.
    const okp = new Uint8Array(
      isoCBOR.encode(
        new Map<number, unknown>([
          [1, 1], // key type: octet key pair
          [3, -8], // algorithm: EdDSA
          [-1, 6], // curve: Ed25519
          [-2, new Uint8Array(32).fill(0xcc)],
        ])
      )
    );

    expect(() => coseToOwnerKey(okp)).toThrow(/P-256/);
  });
});
