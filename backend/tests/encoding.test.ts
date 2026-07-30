import { describe, it, expect } from "vitest";
import {
  canonicalEncode,
  hashChallenge,
  hashIntent,
  fieldsMatch,
  normalizeEndpoint,
  normalizeAmount,
  hashBody,
  domainSeparatedHash,
  CHALLENGE_DOMAIN,
  INTENT_DOMAIN,
  POI_DOMAIN,
} from "../src/shared/hashing.js";
import { loadTestVectors } from "../src/shared/test-vectors.js";
import type { ChallengeFields, IntentFields } from "../src/shared/types.js";

const vectors = loadTestVectors();

describe("canonical encoding", () => {
  it("should encode basic payment fields in correct order", () => {
    const v = vectors.vectors[0]; // basic_payment
    const encoded = canonicalEncode(v.fields as ChallengeFields);
    expect(encoded.toString("utf-8")).toBe(v.canonicalEncoded);
  });

  it("should encode post with body fields correctly", () => {
    const v = vectors.vectors[1]; // post_with_body
    const encoded = canonicalEncode(v.fields as ChallengeFields);
    expect(encoded.toString("utf-8")).toBe(v.canonicalEncoded);
  });

  it("should normalize http method to uppercase", () => {
    const v1 = vectors.vectors[0]; // basic_payment with GET
    const v2 = vectors.vectors[2]; // case_normalization with get

    const encoded1 = canonicalEncode(v1.fields as ChallengeFields);
    const encoded2 = canonicalEncode(v2.fields as ChallengeFields);

    expect(encoded1.toString("utf-8")).toBe(encoded2.toString("utf-8"));
  });

  it("should not include domain separator in canonical encoding", () => {
    const v = vectors.vectors[0];
    const encoded = canonicalEncode(v.fields as ChallengeFields);
    const parts = encoded.toString("utf-8").split("|");
    // 11 fields: version, merchantPubkey, method, endpoint, bodyHash,
    // recipient, asset, amount, network, nonce, expiry
    expect(parts.length).toBe(11);
    expect(parts[0]).toBe("1"); // version
    expect(parts[2]).toBe("GET"); // method (3rd, not 4th since no domainSep)
  });
});

describe("endpoint normalization", () => {
  it("should lowercase host and path", () => {
    expect(normalizeEndpoint("HTTPS://API.MERCHANT.COM/Data")).toBe(
      "https://api.merchant.com/data"
    );
  });

  it("should preserve protocol", () => {
    expect(normalizeEndpoint("https://example.com/path")).toBe(
      "https://example.com/path"
    );
  });
});

describe("amount normalization", () => {
  it("should convert number to string", () => {
    expect(normalizeAmount(1000000)).toBe("1000000");
  });

  it("should keep string as is", () => {
    expect(normalizeAmount("5000000")).toBe("5000000");
  });
});

describe("body hashing", () => {
  it("should hash empty body to sha256 of empty string", () => {
    const emptyHash = hashBody("");
    expect(emptyHash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("should hash non-empty body", () => {
    const h = hashBody("hello world");
    expect(h).toHaveLength(64);
    expect(h).not.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("domain separated hashing", () => {
  it("should produce identical hashes for matching challenge and intent fields", () => {
    const fields = vectors.vectors[0].fields as ChallengeFields;

    const challengeFields: ChallengeFields = { ...fields };
    const intentFields: IntentFields = { ...fields };

    const challengeHash = hashChallenge(challengeFields);
    const intentHash = hashIntent(intentFields);

    // both use the same POI domain for contract comparison, so matching
    // fields produce matching hashes regardless of domainSeparator value
    expect(challengeHash.toString("hex")).toBe(intentHash.toString("hex"));
  });

  it("should produce different hashes with different raw domains", () => {
    const data = Buffer.from("test");
    const h1 = domainSeparatedHash(CHALLENGE_DOMAIN, data);
    const h2 = domainSeparatedHash(INTENT_DOMAIN, data);
    expect(h1.toString("hex")).not.toBe(h2.toString("hex"));
  });

  it("should produce consistent hash for same input", () => {
    const fields = vectors.vectors[0].fields as ChallengeFields;
    const hash1 = hashChallenge(fields);
    const hash2 = hashChallenge(fields);
    expect(hash1.toString("hex")).toBe(hash2.toString("hex"));
  });

  it("should produce 32 byte hash", () => {
    const fields = vectors.vectors[0].fields as ChallengeFields;
    const hash = hashChallenge(fields);
    expect(hash.length).toBe(32);
  });
});

describe("case normalization produces same hash", () => {
  it("should hash identically regardless of http method and endpoint casing", () => {
    const v1 = vectors.vectors[0]; // basic_payment
    const v2 = vectors.vectors[2]; // case_normalization

    const hash1 = hashChallenge(v1.fields as ChallengeFields);
    const hash2 = hashChallenge(v2.fields as ChallengeFields);

    expect(hash1.toString("hex")).toBe(hash2.toString("hex"));
  });
});

describe("fields match detection", () => {
  it("should detect matching fields between challenge and intent", () => {
    const fields = vectors.vectors[0].fields;
    const challenge: ChallengeFields = { ...fields };
    const intent: IntentFields = { ...fields };
    expect(fieldsMatch(challenge, intent)).toBe(true);
  });

  it("should reject mismatched amount", () => {
    const v = vectors.vectors[3]; // mismatched_amount
    expect(fieldsMatch(v.challenge, v.intent)).toBe(false);
  });

  it("should reject mismatched endpoint", () => {
    const v = vectors.vectors[4]; // mismatched_endpoint
    expect(fieldsMatch(v.challenge, v.intent)).toBe(false);
  });
});
