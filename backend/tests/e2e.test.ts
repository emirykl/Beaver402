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

const merchantKp = Keypair.random();
const agentKp = Keypair.random();
const recipientKp = Keypair.random();

describe("end to end x402 payment flow", () => {
  it("should complete a valid payment cycle", async () => {
    // step 1: merchant creates challenge (simulating 402 response)
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: "USDC",
      amount: "1000000",
      network: "testnet",
      expirySeconds: 300,
    });

    // step 2: verify merchant signature
    expect(verifyMerchantSignature(challenge)).toBe(true);

    // step 3: adapter processes payment
    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: "testnet",
    });

    const result = await adapter.processPayment(
      challenge,
      "GET",
      "https://api.merchant.com/data"
    );

    expect(result.success).toBe(true);
    expect(result.txHash).toBeTruthy();
    expect(result.challengeHash).toBe(challenge.hash);
    expect(result.intentHash).toBeTruthy();
  });

  it("should reject when agent observes different endpoint", async () => {
    const challenge = createSignedChallenge({
      merchantKeypair: merchantKp,
      httpMethod: "GET",
      endpoint: "https://api.merchant.com/data",
      recipient: recipientKp.publicKey(),
      asset: "USDC",
      amount: "1000000",
      network: "testnet",
    });

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: "testnet",
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
      asset: "USDC",
      amount: "1000000",
      network: "testnet",
    });

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: "testnet",
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
      asset: "USDC",
      amount: "1000000",
      network: "testnet",
      expirySeconds: -100, // already expired
    });

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: "testnet",
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
      asset: "USDC",
      amount: "1000000",
      network: "testnet",
    });

    // tamper with the signature
    challenge.merchantSignature = Buffer.from("invalid").toString("base64");

    const adapter = new Beaver402Adapter({
      agentKeypair: agentKp,
      policyContractId: "CONTRACT_ID_PLACEHOLDER",
      network: "testnet",
    });

    const result = await adapter.processPayment(
      challenge,
      "GET",
      "https://api.merchant.com/data"
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("merchant signature");
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
