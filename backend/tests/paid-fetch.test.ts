import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

import { paidFetch, readPaymentRequired, type FetchLike } from "../src/agent/paid-fetch.js";
import type { Beaver402Adapter, PreparedPayment } from "../src/adapter/x402-client.js";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "../src/x402/protocol.js";
import { paymentFor, paymentRequired, requirementsFor, signedChallenge } from "./helpers/x402.js";

const merchant = Keypair.random();
const recipient = Keypair.random().publicKey();
const ENDPOINT = "https://merchant.test/api/data";
const terms = { merchant, recipient, endpoint: ENDPOINT };

const SETTLEMENT = "ab".repeat(32);
const PROOF = "cd".repeat(32);

/** An adapter stub, so the orchestration can be tested without a ledger. */
function stubAdapter(result: Partial<PreparedPayment> = {}): Beaver402Adapter {
  const challenge = signedChallenge(terms);
  return {
    preparePayment: vi.fn(async () => ({
      success: true,
      payload: paymentFor(challenge, requirementsFor(terms)),
      requirements: requirementsFor(terms),
      challenge,
      challengeHash: challenge.hash,
      intentHash: "bb".repeat(32),
      ...result,
    })),
  } as unknown as Beaver402Adapter;
}

interface Scripted {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function stubFetch(responses: Scripted[]) {
  let call = 0;
  return vi.fn(async () => {
    const response = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    const headers = new Map(Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: response.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => response.body,
    };
  }) as unknown as FetchLike & ReturnType<typeof vi.fn>;
}

function askForPayment(): Scripted {
  const required = paymentRequired(terms);
  return { status: 402, body: required, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) } };
}

function settled(success = true): Scripted {
  return {
    status: success ? 200 : 402,
    body: success ? { data: "premium" } : { error: "settlement failed" },
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success,
        transaction: success ? SETTLEMENT : "",
        network: "stellar:testnet",
        errorReason: success ? undefined : "invalid_exact_stellar_payload_simulation_failed",
        extensions: success ? { beaver402: { challengeHash: "aa", nonce: "00", proofTransaction: PROOF } } : undefined,
      }),
    },
  };
}

describe("reading an x402 v2 payment request", () => {
  it("reads it from the PAYMENT-REQUIRED header", () => {
    const required = paymentRequired(terms);
    expect(readPaymentRequired(encodePaymentRequiredHeader(required), null)).toEqual(required);
  });

  it("falls back to the same object in the body", () => {
    const required = paymentRequired(terms);
    expect(readPaymentRequired(null, required)).toEqual(required);
  });

  it("refuses anything else", () => {
    expect(readPaymentRequired(null, { error: "pay me" })).toBeNull();
    expect(readPaymentRequired("not base64 json", null)).toBeNull();
    expect(readPaymentRequired(null, null)).toBeNull();
  });
});

describe("fetching a resource that has to be paid for", () => {
  it("returns the content untouched when no payment is asked for", async () => {
    const adapter = stubAdapter();
    const fetchImpl = stubFetch([{ status: 200, body: { data: "free" } }]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(false);
    expect(result.content).toEqual({ data: "free" });
    expect(adapter.preparePayment).not.toHaveBeenCalled();
  });

  it("pays, repeats the request with the payment, and reports the settlement and the proof", async () => {
    const adapter = stubAdapter();
    const fetchImpl = stubFetch([askForPayment(), settled()]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(true);
    expect(result.content).toEqual({ data: "premium" });
    expect(result.payment?.txHash).toBe(SETTLEMENT);
    expect(result.payment?.proofTxHash).toBe(PROOF);
    expect(result.payment?.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${SETTLEMENT}`);
    expect(result.payment?.amount).toBe("1000000");

    // The second request carries the standard x402 payment.
    const retry = fetchImpl.mock.calls[1]![1] as { headers: Record<string, string> };
    const sent = decodePaymentSignatureHeader(retry.headers["PAYMENT-SIGNATURE"]!);
    expect(sent.x402Version).toBe(2);
    expect(sent.accepted.scheme).toBe("exact");
  });

  it("hands the adapter what was actually sent, not what the merchant claims", async () => {
    const adapter = stubAdapter();
    const body = JSON.stringify({ query: "weather" });
    const fetchImpl = stubFetch([askForPayment(), settled()]);

    await paidFetch({ url: ENDPOINT, method: "post", body }, adapter, fetchImpl);

    expect(adapter.preparePayment).toHaveBeenCalledWith(expect.anything(), "POST", ENDPOINT, body);
  });

  it("stops when the policy refuses the payment, without asking again", async () => {
    const adapter = stubAdapter({
      success: false,
      payload: undefined,
      error: "policy rejected the payment: HostError: Error(Auth, InvalidAction)\n data:[\"failed account authentication with error\", Error(Contract, #10)]",
    });
    const fetchImpl = stubFetch([askForPayment(), settled()]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(false);
    expect(result.error).toContain("VelocityExceeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a settlement the merchant could not complete", async () => {
    const adapter = stubAdapter();
    const fetchImpl = stubFetch([askForPayment(), settled(false)]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(false);
    expect(result.error).toContain("simulation_failed");
  });

  it("stops when the merchant does not speak x402 v2", async () => {
    const adapter = stubAdapter();
    const fetchImpl = stubFetch([{ status: 402, body: { error: "pay me" } }]);

    const result = await paidFetch({ url: ENDPOINT }, adapter, fetchImpl);

    expect(result.paid).toBe(false);
    expect(result.error).toContain("x402 v2 payment request");
    expect(adapter.preparePayment).not.toHaveBeenCalled();
  });
});
