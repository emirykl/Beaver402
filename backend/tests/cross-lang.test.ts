import { describe, it, expect } from "vitest";
import {
  fieldsMatch,
  hashChallenge,
  hashIntent,
  requestDigest,
  settlementPreimage,
} from "../src/shared/hashing.js";
import { loadTestVectors } from "../src/shared/test-vectors.js";
import type { PayloadFields } from "../src/shared/types.js";

interface EncodingVector {
  name: string;
  note: string;
  fields: PayloadFields;
  requestDigest: string;
  settlementPreimage: string;
  challengeHash: string;
  intentHash: string;
}

interface MatchVector {
  name: string;
  note: string;
  challenge: PayloadFields;
  intent: PayloadFields;
  shouldMatch: boolean;
}

const vectors = loadTestVectors() as {
  version: string;
  domains: Record<string, string>;
  vectors: EncodingVector[];
  matchVectors: MatchVector[];
};

// The same file is read by the Rust test suite. If either implementation
// drifts, one of the two stops reproducing these bytes.
describe("shared encoding vectors", () => {
  it("carries the vectors both languages check against", () => {
    expect(vectors.version).toBe("2");
    expect(vectors.vectors.length).toBeGreaterThan(0);
    expect(vectors.matchVectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.vectors) {
    describe(vector.name, () => {
      it("reproduces the request digest", () => {
        expect(requestDigest(vector.fields).toString("hex")).toBe(vector.requestDigest);
      });

      it("reproduces the settlement preimage", () => {
        expect(settlementPreimage(vector.fields).toString("hex")).toBe(
          vector.settlementPreimage
        );
      });

      it("reproduces the challenge hash", () => {
        expect(hashChallenge(vector.fields).toString("hex")).toBe(vector.challengeHash);
      });

      it("reproduces the intent hash", () => {
        expect(hashIntent(vector.fields).toString("hex")).toBe(vector.intentHash);
      });

      it("keeps the two domains apart", () => {
        expect(vector.challengeHash).not.toBe(vector.intentHash);
      });
    });
  }

  it("gives normalized fields the same hash as the plain ones", () => {
    const basic = vectors.vectors.find((v) => v.name === "basic_payment");
    const normalized = vectors.vectors.find((v) => v.name === "case_normalization");

    expect(basic).toBeDefined();
    expect(normalized).toBeDefined();
    expect(normalized!.challengeHash).toBe(basic!.challengeHash);
  });
});

describe("challenge and intent agreement vectors", () => {
  for (const vector of vectors.matchVectors) {
    it(`${vector.name}: ${vector.note}`, () => {
      expect(fieldsMatch(vector.challenge, vector.intent)).toBe(vector.shouldMatch);

      // Agreement on the fields has to mean agreement on the hashes.
      const sameHash =
        hashChallenge(vector.challenge).toString("hex") ===
        hashChallenge(vector.intent).toString("hex");
      expect(sameHash).toBe(vector.shouldMatch);
    });
  }
});
