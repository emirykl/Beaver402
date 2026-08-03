import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createSignedChallenge,
  verifyMerchantSignature,
} from "../src/merchant/challenge-signer.js";
import {
  createIntentFromChallenge,
  verifyChallengeIntentMatch,
} from "../src/adapter/buyer-intent.js";
import { Beaver402Adapter } from "../src/adapter/x402-client.js";
import {
  extractRequestFromToolCall,
  isPaymentRequired,
} from "../src/mcp/mcp-tool-handler.js";
import {
  hashChallenge,
  hashIntent,
} from "../src/shared/hashing.js";
import type { IntentFields } from "../src/shared/types.js";

// Settlement fields have to be real Stellar values now: the asset is the
// token contract the payment goes through and the network is the passphrase
// whose hash the contract checks against the ledger.
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TESTNET = "Test SDF Network ; September 2015";
const PUBNET = "Public Global Stellar Network ; September 2015";


const merchantKp = Keypair.random();
const agentKp = Keypair.random();
const recipientKp = Keypair.random();

describe("end to end x402 payment flow", () => {
  it("should validate a matching challenge and intent pair", () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "1000000",
      network: TESTNET,
      expirySeconds: 300,
    });

    expect(verifyMerchantSignature(challenge)).toBe(true);

    const intent = createIntentFromChallenge(
      challenge,
      "GET",
      "https://api.merchant.com/data"
    );

    const matchResult = verifyChallengeIntentMatch(challenge, intent);
    expect(matchResult.matches).toBe(true);

    // both use the same POI domain, so hashes match when fields match
    // Domain separation means the two hashes differ by construction. What
    // has to hold is that they describe the same fields.
    expect(challenge.hash).not.toBe(intent.hash);
    expect(hashChallenge(intent.fields).toString("hex")).toBe(challenge.hash);

    expect(intent.fields.method || intent.fields.httpMethod).toBeTruthy();
    expect(intent.fields.recipient).toBe(recipientKp.publicKey());
    expect(intent.fields.asset).toBe(USDC);
    expect(intent.fields.amount).toBe("1000000");
    expect(intent.fields.network).toBe(TESTNET);
  });

  it("should reject when agent observes different endpoint", async () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "1000000",
      network: TESTNET,
    });

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: TESTNET,
    });

    const result = await adapter.processPayment(
      challenge,
      "GET",
      "https://evil.com/steal"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("mismatch");
  });

  it("should reject when body is tampered", async () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "POST",
      endpoint: "https://api.merchant.com/submit",
      body: '{"action":"buy"}',
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "1000000",
      network: TESTNET,
    });

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: TESTNET,
    });

    const result = await adapter.processPayment(
      challenge,
      "POST",
      "https://api.merchant.com/submit",
      '{"action":"steal"}'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("mismatch");
  });

  it("should reject expired challenge", async () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "1000000",
      network: TESTNET,
      expirySeconds: -100,
    });

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: TESTNET,
    });

    const result = await adapter.processPayment(
      challenge,
      "GET",
      "https://api.merchant.com/data"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("should reject invalid merchant signature", async () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "1000000",
      network: TESTNET,
    });

    challenge.merchantSignature = Buffer.from("invalid").toString("base64");

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: TESTNET,
    });

    const result = await adapter.processPayment(
      challenge,
      "GET",
      "https://api.merchant.com/data"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("merchant signature");
  });

  it("should verify complete two-party proof of intent flow", () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "POST",
      endpoint: "https://api.merchant.com/submit",
      body: '{"task":"analyze_data","priority":"high"}',
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "5000000",
      network: TESTNET,
      expirySeconds: 600,
    });

    const intent = createIntentFromChallenge(
      challenge,
      "POST",
      "https://api.merchant.com/submit",
      '{"task":"analyze_data","priority":"high"}'
    );

    const match = verifyChallengeIntentMatch(challenge, intent);
    expect(match.matches).toBe(true);
    // Domain separation means the two hashes differ by construction. What
    // has to hold is that they describe the same fields.
    expect(challenge.hash).not.toBe(intent.hash);
    expect(hashChallenge(intent.fields).toString("hex")).toBe(challenge.hash);
    expect(challenge.hash).toBeTruthy();
    expect(challenge.hash.length).toBe(64);
  });

  it("should reject when amount is tampered between challenge and intent", () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "1000000",
      network: TESTNET,
    });

    const intent = createIntentFromChallenge(
      challenge,
      "GET",
      "https://api.merchant.com/data"
    );

    // tamper with the amount
    intent.fields.amount = "9999999";
    intent.hash = hashIntent(intent.fields as IntentFields).toString("hex");

    const match = verifyChallengeIntentMatch(challenge, intent);
    expect(match.matches).toBe(false);
  });

  it("should reject when method is tampered", () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: USDC,
      amount: "1000000",
      network: TESTNET,
    });

    const intent = createIntentFromChallenge(
      challenge,
      "POST",
      "https://api.merchant.com/data"
    );

    const match = verifyChallengeIntentMatch(challenge, intent);
    expect(match.matches).toBe(false);
  });
});

describe("MCP tool call integration", () => {
  it("should extract request info from tool call", () => {
    const toolCall = {
      name: "http_request",
      arguments: {
        method: "GET",
        url: "https://api.merchant.com/data",
      },
    };

    const info = extractRequestFromToolCall(toolCall);
    expect(info).not.toBeNull();
    expect(info!.httpMethod).toBe("GET");
    expect(info!.endpoint).toBe("https://api.merchant.com/data");
  });

  it("should extract body hash from POST tool call", () => {
    const toolCall = {
      name: "http_request",
      arguments: {
        method: "POST",
        url: "https://api.merchant.com/submit",
        body: '{"key":"value"}',
      },
    };

    const info = extractRequestFromToolCall(toolCall);
    expect(info).not.toBeNull();
    expect(info!.httpMethod).toBe("POST");
    expect(info!.bodyHash).toBeTruthy();
    expect(info!.rawBody).toBe('{"key":"value"}');
  });

  it("should detect 402 status code", () => {
    expect(isPaymentRequired(402)).toBe(true);
    expect(isPaymentRequired(200)).toBe(false);
    expect(isPaymentRequired(404)).toBe(false);
  });
});
