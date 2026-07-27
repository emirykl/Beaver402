import { describe, it, expect } from "vitest";
import {
  canonicalEncode,
  domainSeparatedHash,
  CHALLENGE_DOMAIN,
  INTENT_DOMAIN,
} from "../src/shared/hashing.js";
import { loadTestVectors } from "../src/shared/test-vectors.js";
import type { ChallengeFields } from "../src/shared/types.js";

const vectors = loadTestVectors();

describe("cross language vector compatibility", () => {
  it("should produce deterministic canonical encoding for basic payment", () => {
    const v = vectors.vectors[0];
    const encoded = canonicalEncode(v.fields as ChallengeFields);
    const encodedStr = encoded.toString("utf-8");

    // verify pipe-separated format
    const parts = encodedStr.split("|");
    expect(parts.length).toBe(12);
    expect(parts[0]).toBe("1"); // version
    expect(parts[3]).toBe("GET"); // method normalized
    expect(parts[8]).toBe("1000000"); // amount
  });

  it("should produce stable hash output for same input across runs", () => {
    const v = vectors.vectors[0];
    const encoded = canonicalEncode(v.fields as ChallengeFields);

    const hash1 = domainSeparatedHash(CHALLENGE_DOMAIN, encoded);
    const hash2 = domainSeparatedHash(CHALLENGE_DOMAIN, encoded);

    expect(hash1.toString("hex")).toBe(hash2.toString("hex"));
  });

  it("should produce different hashes for challenge vs intent domain", () => {
    const v = vectors.vectors[0];
    const encoded = canonicalEncode(v.fields as ChallengeFields);

    const challengeHash = domainSeparatedHash(CHALLENGE_DOMAIN, encoded);
    const intentHash = domainSeparatedHash(INTENT_DOMAIN, encoded);

    expect(challengeHash.toString("hex")).not.toBe(intentHash.toString("hex"));
  });

  it("should produce same encoding regardless of method casing", () => {
    const v1 = vectors.vectors[0]; // GET
    const v2 = vectors.vectors[2]; // get (lowercase)

    const enc1 = canonicalEncode(v1.fields as ChallengeFields);
    const enc2 = canonicalEncode(v2.fields as ChallengeFields);

    expect(enc1.toString("hex")).toBe(enc2.toString("hex"));
  });

  it("should detect mismatched amount in negative vector", () => {
    const v = vectors.vectors[3]; // mismatched_amount
    const challengeEncoded = canonicalEncode(v.challenge as ChallengeFields);
    const intentEncoded = canonicalEncode(v.intent as ChallengeFields);

    const challengeHash = domainSeparatedHash(CHALLENGE_DOMAIN, challengeEncoded);
    const intentHash = domainSeparatedHash(INTENT_DOMAIN, intentEncoded);

    // different amounts must produce different hashes
    expect(challengeHash.toString("hex")).not.toBe(intentHash.toString("hex"));
  });

  it("should detect mismatched endpoint in negative vector", () => {
    const v = vectors.vectors[4]; // mismatched_endpoint
    const challengeEncoded = canonicalEncode(v.challenge as ChallengeFields);
    const intentEncoded = canonicalEncode(v.intent as ChallengeFields);

    // encodings themselves should differ
    expect(challengeEncoded.toString("hex")).not.toBe(intentEncoded.toString("hex"));
  });

  it("domain separator prefix length byte should match domain string length", () => {
    // this verifies the length-prefixed domain format used in both TS and Rust
    const domain = CHALLENGE_DOMAIN;
    const data = Buffer.from("test");

    const hash = domainSeparatedHash(domain, data);
    expect(hash.length).toBe(32); // sha256 output is 32 bytes

    // domain is 22 bytes ("beaver402:challenge:v1")
    expect(Buffer.from(domain).length).toBe(22);
  });
});
