import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hashChallenge, hashIntent, requestDigest, settlementPreimage, type ChallengeFields } from "../src/encoding.js";

// The same file the backend and the Rust contract tests read. If this
// package drifts from the contract's encoding, these stop matching.
const path = fileURLToPath(new URL("../../../test-vectors/vectors.json", import.meta.url));
const file = JSON.parse(readFileSync(path, "utf-8")) as {
  version: string;
  vectors: { name: string; fields: ChallengeFields; requestDigest: string; settlementPreimage: string; challengeHash: string; intentHash: string }[];
};

describe("shared encoding vectors", () => {
  it("are version 2", () => {
    expect(file.version).toBe("2");
    expect(file.vectors.length).toBeGreaterThan(0);
  });
  for (const v of file.vectors) {
    it(`reproduces ${v.name}`, () => {
      expect(requestDigest(v.fields).toString("hex")).toBe(v.requestDigest);
      expect(settlementPreimage(v.fields).toString("hex")).toBe(v.settlementPreimage);
      expect(hashChallenge(v.fields).toString("hex")).toBe(v.challengeHash);
      expect(hashIntent(v.fields).toString("hex")).toBe(v.intentHash);
    });
  }
});
