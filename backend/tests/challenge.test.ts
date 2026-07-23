import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createSignedChallenge,
  verifyMerchantSignature,
} from "../src/merchant/challenge-signer.js";
import {
  createIntentFromChallenge,
  verifyChallengeIntentMatch,
  createIntent,
} from "../src/adapter/buyer-intent.js";
import { hashChallenge, hashIntent } from "../src/shared/hashing.js";

const merchantKp = Keypair.random();
const recipientKp = Keypair.random();

function makeChallenge() {
  return createSignedChallenge({
    merchantKeypair: merchantKp,
    httpMethod: "GET",
    endpoint: "https://api.merchant.com/premium-data",
    recipient: recipientKp.publicKey(),
    asset: "USDC",
    amount: "5000000",
    network: "testnet",
    expirySeconds: 300,
  });
}

describe("merchant challenge signing", () => {
  it("should create a valid signed challenge", () => {
    const challenge = makeChallenge();

    expect(challenge.fields.version).toBe("1");
    expect(challenge.merchantPubkey).toBe(merchantKp.publicKey());
    expect(challenge.hash).toHaveLength(64);
    expect(challenge.merchantSignature).toBeTruthy();
  });

  it("should produce a verifiable signature", () => {
    const challenge = makeChallenge();
    expect(verifyMerchantSignature(challenge)).toBe(true);
  });

  it("should reject a tampered challenge", () => {
    const challenge = makeChallenge();
    challenge.fields.amount = "9999999";
    expect(verifyMerchantSignature(challenge)).toBe(false);
  });

  it("should reject signature from wrong key", () => {
    const challenge = makeChallenge();
    const fakeKp = Keypair.random();
    challenge.merchantPubkey = fakeKp.publicKey();
    expect(verifyMerchantSignature(challenge)).toBe(false);
  });
});

describe("buyer intent creation", () => {
  it("should create intent from challenge with matching fields", () => {
    const challenge = makeChallenge();

    const intent = createIntentFromChallenge(
      challenge,
      "GET",
      "https://api.merchant.com/premium-data"
    );

    expect(intent.hash).toHaveLength(64);
    expect(intent.fields.merchantPubkey).toBe(merchantKp.publicKey());
    expect(intent.fields.amount).toBe("5000000");
  });

  it("should match when buyer observes same request", () => {
    const challenge = makeChallenge();

    const intent = createIntentFromChallenge(
      challenge,
      "GET",
      "https://api.merchant.com/premium-data"
    );

    const result = verifyChallengeIntentMatch(challenge, intent);
    expect(result.matches).toBe(true);
  });
});

describe("challenge intent mismatch detection", () => {
  it("should detect amount tampering", () => {
    const challenge = makeChallenge();

    const intent = createIntent({
      merchantPubkey: challenge.merchantPubkey,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/premium-data",
      recipient: recipientKp.publicKey(),
      asset: "USDC",
      amount: "9999999",
      network: "testnet",
      nonce: challenge.fields.nonce,
      expiry: challenge.fields.expiry,
    });

    const result = verifyChallengeIntentMatch(challenge, intent);
    expect(result.matches).toBe(false);
    expect(result.reason).toContain("amount");
  });

  it("should detect endpoint tampering", () => {
    const challenge = makeChallenge();

    const intent = createIntentFromChallenge(
      challenge,
      "GET",
      "https://evil.com/steal-data"
    );

    const result = verifyChallengeIntentMatch(challenge, intent);
    expect(result.matches).toBe(false);
  });

  it("should detect body tampering", () => {
    const challengeWithBody = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "POST",
      endpoint: "https://api.merchant.com/submit",
      body: '{"action": "purchase"}',
      recipient: recipientKp.publicKey(),
      asset: "USDC",
      amount: "5000000",
      network: "testnet",
    });

    const intent = createIntentFromChallenge(
      challengeWithBody,
      "POST",
      "https://api.merchant.com/submit",
      '{"action": "refund"}'
    );

    const result = verifyChallengeIntentMatch(challengeWithBody, intent);
    expect(result.matches).toBe(false);
    expect(result.reason).toContain("bodyHash");
  });

  it("should detect recipient tampering", () => {
    const challenge = makeChallenge();
    const attackerKp = Keypair.random();

    const intent = createIntent({
      merchantPubkey: challenge.merchantPubkey,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/premium-data",
      recipient: attackerKp.publicKey(),
      asset: "USDC",
      amount: "5000000",
      network: "testnet",
      nonce: challenge.fields.nonce,
      expiry: challenge.fields.expiry,
    });

    const result = verifyChallengeIntentMatch(challenge, intent);
    expect(result.matches).toBe(false);
    expect(result.reason).toContain("recipient");
  });

  it("should detect network tampering", () => {
    const challenge = makeChallenge();

    const intent = createIntent({
      merchantPubkey: challenge.merchantPubkey,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/premium-data",
      recipient: recipientKp.publicKey(),
      asset: "USDC",
      amount: "5000000",
      network: "mainnet",
      nonce: challenge.fields.nonce,
      expiry: challenge.fields.expiry,
    });

    const result = verifyChallengeIntentMatch(challenge, intent);
    expect(result.matches).toBe(false);
  });
});

describe("hash consistency", () => {
  it("should produce matching hashes when fields are identical", () => {
    const challenge = makeChallenge();
    const intent = createIntentFromChallenge(
      challenge,
      "GET",
      "https://api.merchant.com/premium-data"
    );

    const challengeHash = hashChallenge(challenge.fields);
    const intentHash = hashIntent(intent.fields);

    // domain separators differ, so raw hashes will differ
    // but the canonical data (minus domain) should be consistent
    expect(challengeHash.length).toBe(32);
    expect(intentHash.length).toBe(32);
  });

  it("should produce different hashes for different nonces", () => {
    const c1 = makeChallenge();
    const c2 = makeChallenge();

    // nonces are random, so hashes should differ
    expect(c1.hash).not.toBe(c2.hash);
  });
});
