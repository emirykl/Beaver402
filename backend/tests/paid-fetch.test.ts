import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { extractChallenge, paidFetch, type FetchLike } from "../src/agent/paid-fetch.js";
import { createSignedChallenge } from "../src/merchant/challenge-signer.js";
import type { Beaver402Adapter, PaymentResult } from "../src/adapter/x402-client.js";

const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const TESTNET = "Test SDF Network ; September 2015";

const merchantKp = Keypair.random();
const recipientKp = Keypair.random();
const ENDPOINT = "https://merchant.test/api/data";

function challenge(method = "GET", body?: string) {
  return createSignedChallenge({
    merchantKeypair: merchantKp,
    httpMethod: method,
    endpoint: ENDPOINT,
    body,
    recipient: recipientKp.publicKey(),
    asset: USDC,
    amount: "1000000",
    network: TESTNET,
  });
}

function paymentRequired(method = "GET", body?: string) {
  const signed = challenge(method, body);
  return {
    error: "Payment Required",
    paymentDetails: {
      amount: "1000000",
      asset: USDC,
      recipient: recipientKp.publicKey(),
      network: TESTNET,
    },
    challenge: {
      fields: signed.fields,
      hash: signed.hash,
      merchantSignature: signed.merchantSignature,
      merchantPubkey: signed.merchantPubkey,
    },
  };
}

/** An adapter stub, so the orchestration can be tested without a ledger. */
function stubAdapter(result: Partial<PaymentResult> = {}): Beaver402Adapter {
  return {
    processPayment: vi.fn(async () => ({
      success: true,
      txHash: "abc123",
      challengeHash: "aa".repeat(32),
      intentHash: "bb".repeat(32),
      ...result,
    })),
  } as unknown as Beaver402Adapter;
}

function stubFetch(responses: Array<{ status: number; body: unknown }>): FetchLike {
  let call = 0;
  return vi.fn(async () => {
    const response = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return { status: response.status, json: async () => response.body };
  });
}

describe("reading a payment challenge", () => {
  it("accepts a well formed 402 body", () => {
    expect(extractChallenge(paymentRequired())).not.toBeNull();
  });

  it("refuses a body with no challenge", () => {
    expect(extractChallenge({ error: "Payment Required" })).toBeNull();
  });

  it("refuses a challenge that is missing its signature", () => {
    const body = paymentRequired() as Record<string, any>;
    delete body.challenge.merchantSignature;
    expect(extractChallenge(body)).toBeNull();
  });

  it("refuses anything that is not an object", () => {
    expect(extractChallenge(null)).toBeNull();
    expect(extractChallenge("402")).toBeNull();
  });
});

describe("fetching a resource that has to be paid for", () => {
  it("returns the content untouched when no payment is asked for", async () => {
    const adapter = stubAdapter();
    const fetchImpl = stubFetch([{ status: 200, body: { data: "free" } }]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(false);
    expect(result.content).toEqual({ data: "free" });
    expect(adapter.processPayment).not.toHaveBeenCalled();
  });

  it("pays and then repeats the request", async () => {
    const adapter = stubAdapter();
    const fetchImpl = stubFetch([
      { status: 402, body: paymentRequired() },
      { status: 200, body: { data: "premium" } },
    ]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(true);
    expect(result.content).toEqual({ data: "premium" });
    expect(result.payment?.txHash).toBe("abc123");
    expect(result.payment?.amount).toBe("1000000");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("hands the adapter what was actually sent, not what the merchant claims", async () => {
    const adapter = stubAdapter();
    const body = JSON.stringify({ query: "weather" });
    const fetchImpl = stubFetch([
      { status: 402, body: paymentRequired("POST", body) },
      { status: 200, body: { ok: true } },
    ]);

    await paidFetch({ url: ENDPOINT, method: "post", body }, adapter, fetchImpl);

    expect(adapter.processPayment).toHaveBeenCalledWith(
      expect.anything(),
      "POST",
      ENDPOINT,
      body
    );
  });

  it("stops when the policy refuses the payment", async () => {
    const adapter = stubAdapter({ success: false, error: "velocity exceeded" });
    const fetchImpl = stubFetch([
      { status: 402, body: paymentRequired() },
      { status: 200, body: { data: "premium" } },
    ]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(false);
    expect(result.error).toContain("velocity exceeded");
    // The resource must not be requested again after a refused payment.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops when the merchant asks for payment without a challenge", async () => {
    const adapter = stubAdapter();
    const fetchImpl = stubFetch([{ status: 402, body: { error: "pay me" } }]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(false);
    expect(result.error).toContain("usable signed challenge");
    expect(adapter.processPayment).not.toHaveBeenCalled();
  });
});
