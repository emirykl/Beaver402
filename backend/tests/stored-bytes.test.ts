import { describe, it, expect } from "vitest";

import { decodeStoredBytes } from "../src/lib/supabase.js";

// A passkey public key is written as base64 text into a bytea column, so
// Postgres keeps the characters of that text and returns them hex escaped.
// Reading it back as plain base64 gives nonsense, which looks exactly like a
// corrupt credential.
describe("reading bytes back out of storage", () => {
  const original = Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]);
  const asBase64 = original.toString("base64");

  it("unwraps the hex escape a bytea column hands back", () => {
    const stored = `\\x${Buffer.from(asBase64, "utf-8").toString("hex")}`;

    expect(decodeStoredBytes(stored)).toEqual(original);
  });

  it("still reads a value stored as plain base64", () => {
    expect(decodeStoredBytes(asBase64)).toEqual(original);
  });

  it("survives a round trip for a full sized public key", () => {
    const key = Buffer.alloc(77);
    for (let i = 0; i < key.length; i += 1) {
      key[i] = (i * 7) % 256;
    }

    const stored = `\\x${Buffer.from(key.toString("base64"), "utf-8").toString("hex")}`;

    expect(decodeStoredBytes(stored)).toEqual(key);
  });
});
