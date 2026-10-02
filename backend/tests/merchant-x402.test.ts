import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";

import { createMerchantRouter, type MerchantConfig } from "../src/merchant/demo-endpoint.js";
import type { MerchantDeps } from "../src/merchant/x402-merchant.js";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "../src/x402/protocol.js";
import { challengeFrom } from "../src/x402/protocol.js";
import { paymentFor, POLICY, TESTNET, USDC } from "./helpers/x402.js";

const SETTLEMENT = "ef".repeat(32);
const PROOF = "12".repeat(32);

function merchantConfig(): MerchantConfig {
  return {
    keypair: MERCHANT,
    recipient: RECIPIENT,
    asset: USDC,
    network: TESTNET,
    price: "1000000",
  };
}
const MERCHANT = Keypair.random();
const RECIPIENT = Keypair.random().publicKey();

function deps(overrides: Partial<MerchantDeps> = {}) {
  const calls = {
    verify: vi.fn(async () => ({ isValid: true })),
    settle: vi.fn(async () => ({ success: true, transaction: SETTLEMENT, network: "stellar:testnet" as const, payer: POLICY })),
    confirm: vi.fn(async () => {}),
    record: vi.fn(async () => true),
    publishProof: vi.fn(async () => PROOF),
  };
  const built: MerchantDeps = {
    merchant: merchantConfig,
    facilitator: () => ({ verify: calls.verify, settle: calls.settle }),
    confirm: calls.confirm,
    record: calls.record,
    publishProof: calls.publishProof,
    ...overrides,
  };
  return { deps: built, calls };
}

async function serve(merchantDeps: MerchantDeps) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: string }).rawBody = buf.toString("utf-8");
      },
    })
  );
  app.use(createMerchantRouter(merchantDeps));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Ask for the resource, then answer the 402 the way the agent would. */
async function payFor(base: string, path: string, tamper?: (payload: ReturnType<typeof paymentFor>) => void, otherPath?: string) {
  const first = await fetch(`${base}${path}`);
  const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
  const challenge = challengeFrom(required)!;
  const payload = paymentFor(challenge, required.accepts[0]!);
  tamper?.(payload);
  return fetch(`${base}${otherPath ?? path}`, {
    headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
  });
}

describe("asking for payment", () => {
  it("answers 402 with standard x402 v2 requirements and a challenge for this request", async () => {
    const { deps: d } = deps();
    const { base, close } = await serve(d);
    const response = await fetch(`${base}/api/data`);
    close();

    expect(response.status).toBe(402);
    const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!);
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]).toEqual({
      scheme: "exact",
      network: "stellar:testnet",
      asset: USDC,
      amount: "1000000",
      payTo: RECIPIENT,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    });

    const challenge = challengeFrom(required)!;
    expect(challenge.merchantPubkey).toBe(MERCHANT.publicKey());
    expect(challenge.fields.normalizedEndpoint).toBe(`${base}/api/data`);
    expect(challenge.fields.recipient).toBe(RECIPIENT);
  });
});

describe("releasing the resource", () => {
  it("releases it once the facilitator settled and the ledger confirmed, and returns the receipt", async () => {
    const { deps: d, calls } = deps();
    const { base, close } = await serve(d);
    const response = await payFor(base, "/api/data");
    close();

    expect(response.status).toBe(200);
    expect((await response.json()).protectedBy).toBe("beaver402");

    const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!);
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBe(SETTLEMENT);
    expect((receipt.extensions?.beaver402 as { proofTransaction?: string }).proofTransaction).toBe(PROOF);

    expect(calls.confirm).toHaveBeenCalledWith(SETTLEMENT, {
      asset: USDC,
      from: POLICY,
      to: RECIPIENT,
      amount: "1000000",
    });
    expect(calls.publishProof).toHaveBeenCalledWith(POLICY, expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it("refuses a payment made for another endpoint before the facilitator hears of it", async () => {
    const { deps: d, calls } = deps();
    const { base, close } = await serve(d);
    const response = await payFor(base, "/api/data", undefined, "/api/data?other=1");
    close();

    expect(response.status).toBe(402);
    expect((await response.json()).error).toMatch(/different request/);
    expect(calls.verify).not.toHaveBeenCalled();
  });

  it("refuses a payment whose requirements were changed", async () => {
    const { deps: d, calls } = deps();
    const { base, close } = await serve(d);
    const response = await payFor(base, "/api/data", (p) => {
      p.accepted = { ...p.accepted, amount: "1" };
    });
    close();

    expect(response.status).toBe(402);
    expect((await response.json()).error).toMatch(/does not match what this resource costs/);
    expect(calls.verify).not.toHaveBeenCalled();
  });

  it("refuses a payment answering another merchant's challenge", async () => {
    const { deps: d, calls } = deps();
    const { base, close } = await serve(d);

    const first = await fetch(`${base}/api/data`);
    const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
    const challenge = challengeFrom(required)!;
    const forged = { ...challenge, merchantSignature: Keypair.random().sign(Buffer.alloc(32)).toString("base64") };
    const response = await fetch(`${base}/api/data`, {
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentFor(forged, required.accepts[0]!)) },
    });
    close();

    expect(response.status).toBe(402);
    expect((await response.json()).error).toMatch(/this merchant's signature/);
    expect(calls.verify).not.toHaveBeenCalled();
  });

  it("does not settle what the facilitator will not verify", async () => {
    const { deps: d, calls } = deps({
      facilitator: () => ({
        verify: async () => ({ isValid: false, invalidReason: "invalid_exact_stellar_payload_simulation_failed" }),
        settle: vi.fn(),
      }),
    });
    const { base, close } = await serve(d);
    const response = await payFor(base, "/api/data");
    close();

    expect(response.status).toBe(402);
    expect((await response.json()).error).toMatch(/simulation_failed/);
    expect(calls.confirm).not.toHaveBeenCalled();
  });

  it("does not release the resource when the ledger does not confirm the settlement", async () => {
    const { deps: d, calls } = deps({
      confirm: async () => {
        throw new Error("settlement carries 0 transfers, expected exactly one");
      },
    });
    const { base, close } = await serve(d);
    const response = await payFor(base, "/api/data");
    close();

    expect(response.status).toBe(502);
    expect(calls.record).not.toHaveBeenCalled();
    expect(calls.publishProof).not.toHaveBeenCalled();
  });

  it("does not release the resource twice for one payment", async () => {
    const { deps: d } = deps({ record: async () => false });
    const { base, close } = await serve(d);
    const response = await payFor(base, "/api/data");
    close();

    expect(response.status).toBe(409);
  });

  it("still releases a settled payment whose proof could not be published", async () => {
    const { deps: d } = deps({ publishProof: async () => undefined });
    const { base, close } = await serve(d);
    const response = await payFor(base, "/api/data");
    close();

    expect(response.status).toBe(200);
    const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE")!);
    expect((receipt.extensions?.beaver402 as { proofTransaction?: string }).proofTransaction).toBeUndefined();
  });

  it("binds a payment to the body it was made for", async () => {
    const { deps: d, calls } = deps();
    const { base, close } = await serve(d);

    const body = JSON.stringify({ query: "weather" });
    const first = await fetch(`${base}/api/submit`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
    const payload = paymentFor(challengeFrom(required)!, required.accepts[0]!);

    const tampered = await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
      body: JSON.stringify({ query: "something else" }),
    });
    expect(tampered.status).toBe(402);
    expect(calls.verify).not.toHaveBeenCalled();

    const honest = await fetch(`${base}/api/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
      body,
    });
    close();
    expect(honest.status).toBe(200);
  });
});
