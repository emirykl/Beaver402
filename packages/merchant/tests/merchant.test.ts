import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  type PaymentRequired,
} from "../src/protocol.js";
import type { SignedChallenge } from "../src/encoding.js";
import { memoryStore } from "../src/store.js";
import { build, fakeFacilitator, fakeLedger, MERCHANT, paymentFor, POLICY, PROOF, RECIPIENT, serve, SETTLEMENT, transferEvent, USDC } from "./helpers/fixtures.js";

type Init = { method?: string; body?: string };

async function challengeOf(base: string, path: string, init: Init = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: init.body ? { "content-type": "application/json" } : {},
    body: init.body,
  });
  const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!) as PaymentRequired;
  const challenge = (required.extensions!.beaver402 as { challenge: SignedChallenge }).challenge;
  return { res, required, challenge };
}

function pay(base: string, path: string, payment: ReturnType<typeof paymentFor>, init: Init = {}) {
  return fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment),
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body,
  });
}

async function payFor(base: string, path: string, init: Init = {}) {
  const { required, challenge } = await challengeOf(base, path, init);
  return pay(base, path, paymentFor(challenge, required.accepts[0]!), init);
}

describe("asking for payment", () => {
  it("answers 402 with x402 v2 exact requirements and a challenge signed over this request", async () => {
    const { merchant } = build({}, { skipPreflight: true });
    const { base, close } = await serve(merchant);
    const { res, required, challenge } = await challengeOf(base, "/data?b=2&a=1");
    close();

    expect(res.status).toBe(402);
    expect(required.accepts[0]).toEqual({
      scheme: "exact",
      network: "stellar:testnet",
      asset: USDC,
      amount: "1000000",
      payTo: RECIPIENT,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    });
    expect(challenge.merchantPubkey).toBe(MERCHANT.publicKey());
    expect(challenge.fields.normalizedEndpoint).toBe(`${base}/data?b=2&a=1`);
    expect(Number(challenge.fields.expiry) - Math.floor(Date.now() / 1000)).toBeGreaterThan(290);
  });

  it("signs the public URL rather than the Host header when one is configured", async () => {
    const { merchant } = build({ publicUrl: "https://api.example.com" }, { skipPreflight: true });
    const { base, close } = await serve(merchant);
    const { challenge } = await challengeOf(base, "/data");
    close();
    expect(challenge.fields.normalizedEndpoint).toBe("https://api.example.com/data");
  });

  it("uses the route's own price", async () => {
    const { merchant } = build({}, { skipPreflight: true });
    const { base, close } = await serve(merchant);
    const { required } = await challengeOf(base, "/submit", { method: "POST", body: "{}" });
    close();
    expect(required.accepts[0]!.amount).toBe("2000000");
  });

  it("hands out no challenge while the setup is broken", async () => {
    const ledger = fakeLedger();
    (ledger.rpc as { getTrustline: unknown }).getTrustline = async () => {
      throw new Error("not found");
    };
    const { merchant } = build({}, { skipPreflight: false }, ledger);
    const { base, close } = await serve(merchant);
    const res = await fetch(`${base}/data`);
    close();
    expect(res.status).toBe(503);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("refuses to sign a request whose raw body was not kept", async () => {
    const { merchant } = build({}, { skipPreflight: true });
    const express = (await import("express")).default;
    const app = express();
    app.use(express.json());
    app.post("/submit", merchant.protect(), (_req, res) => res.json({}));
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    server.close();
    expect(res.status).toBe(503);
  });
});

describe("releasing the resource", () => {
  it("releases it after settlement and ledger confirmation, with the proof of intent in the receipt", async () => {
    const store = memoryStore();
    const { merchant, facilitator } = build({ store }, { skipPreflight: true });
    const { base, close } = await serve(merchant);
    const res = await payFor(base, "/data");
    close();

    expect(res.status).toBe(200);
    expect((await res.json()).payment).toBe(SETTLEMENT);
    const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(receipt.transaction).toBe(SETTLEMENT);
    expect((receipt.extensions!.beaver402 as { proofTransaction?: string }).proofTransaction).toBe(PROOF);
    expect(facilitator.calls).toEqual({ verify: 1, settle: 1 });
    expect(await store.pendingProofs()).toEqual([]);
  });

  it("binds a POST payment to its body", async () => {
    const ledger = fakeLedger({ settlement: { status: "SUCCESS", events: [transferEvent(POLICY, RECIPIENT, 2_000_000n)] } });
    const { merchant, facilitator } = build({}, { skipPreflight: true }, ledger);
    const { base, close } = await serve(merchant);
    const body = JSON.stringify({ query: "weather" });
    const { required, challenge } = await challengeOf(base, "/submit", { method: "POST", body });
    const payment = paymentFor(challenge, required.accepts[0]!);

    const tampered = await pay(base, "/submit", payment, { method: "POST", body: JSON.stringify({ query: "other" }) });
    expect(tampered.status).toBe(402);
    expect((await tampered.json()).error).toMatch(/different request/);
    expect(facilitator.calls.verify).toBe(0);

    const honest = await pay(base, "/submit", payment, { method: "POST", body });
    close();
    expect(honest.status).toBe(200);
    expect(await honest.json()).toEqual({ accepted: { query: "weather" } });
  });
});

describe("refusing a payment before anything settles", () => {
  async function refused(tamper: (args: { required: PaymentRequired; challenge: SignedChallenge }) => { payment: ReturnType<typeof paymentFor>; path?: string }, ledger = fakeLedger()) {
    const { merchant, facilitator } = build({}, { skipPreflight: true }, ledger);
    const { base, close } = await serve(merchant);
    const got = await challengeOf(base, "/data");
    const { payment, path } = tamper(got);
    const res = await pay(base, path ?? "/data", payment);
    close();
    return { status: res.status, error: (await res.json()).error as string, facilitator };
  }

  it("for another endpoint", async () => {
    const r = await refused(({ required, challenge }) => ({ payment: paymentFor(challenge, required.accepts[0]!), path: "/data?x=1" }));
    expect(r.status).toBe(402);
    expect(r.error).toMatch(/different request/);
    expect(r.facilitator.calls.verify).toBe(0);
  });

  it("with changed requirements", async () => {
    const r = await refused(({ required, challenge }) => {
      const payment = paymentFor(challenge, required.accepts[0]!);
      payment.accepted = { ...payment.accepted, amount: "1" };
      return { payment };
    });
    expect(r.error).toMatch(/does not match what this resource costs/);
  });

  it("to another recipient", async () => {
    const other = StellarSdk.Keypair.random().publicKey();
    const r = await refused(({ required, challenge }) => ({
      payment: paymentFor({ ...challenge, fields: { ...challenge.fields, recipient: other } }, required.accepts[0]!),
    }));
    expect(r.error).toMatch(/another recipient/);
  });

  it("for another amount", async () => {
    const r = await refused(({ required, challenge }) => ({
      payment: paymentFor({ ...challenge, fields: { ...challenge.fields, amount: "999999" } }, required.accepts[0]!),
    }));
    expect(r.error).toMatch(/another amount/);
  });

  it("answering another merchant's challenge", async () => {
    const r = await refused(({ required, challenge }) => ({
      payment: paymentFor({ ...challenge, merchantSignature: StellarSdk.Keypair.random().sign(Buffer.alloc(32)).toString("base64") }, required.accepts[0]!),
    }));
    expect(r.error).toMatch(/this merchant's signature/);
  });

  it("answering an expired challenge", async () => {
    const r = await refused(({ required, challenge }) => ({
      payment: paymentFor({ ...challenge, fields: { ...challenge.fields, expiry: String(Math.floor(Date.now() / 1000) - 1) } }, required.accepts[0]!),
    }));
    expect(r.error).toMatch(/expired/);
  });

  it("from an account whose owner has not approved this merchant", async () => {
    const r = await refused(({ required, challenge }) => ({ payment: paymentFor(challenge, required.accepts[0]!) }), fakeLedger({ approved: false }));
    expect(r.status).toBe(402);
    expect(r.error).toMatch(/not approved this merchant/);
    expect(r.facilitator.calls.verify).toBe(0);
  });

  it("from an account that is not a Beaver402 policy account", async () => {
    const r = await refused(({ required, challenge }) => ({ payment: paymentFor(challenge, required.accepts[0]!) }), fakeLedger({ simulationError: "MissingValue" }));
    expect(r.error).toMatch(/not come from a Beaver402 policy account/);
  });

  it("that the facilitator does not verify", async () => {
    const fac = fakeFacilitator({ verify: async () => ({ isValid: false, invalidReason: "simulation_failed" }) });
    const { merchant } = build({}, { skipPreflight: true }, fakeLedger(), fac);
    const { base, close } = await serve(merchant);
    const res = await payFor(base, "/data");
    close();
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/simulation_failed/);
    expect(fac.calls.settle).toBe(0);
  });
});

describe("after settlement", () => {
  it("keeps the resource locked when the ledger does not show the agreed transfer", async () => {
    const store = memoryStore();
    const ledger = fakeLedger({ settlement: { status: "SUCCESS", events: [transferEvent(POLICY, RECIPIENT, 1n)] } });
    const { merchant } = build({ store }, { skipPreflight: true }, ledger);
    const { base, close } = await serve(merchant);
    const res = await payFor(base, "/data");
    close();
    expect(res.status).toBe(502);
    expect(await store.pendingProofs()).toEqual([]);
    expect(ledger.calls.send).toBe(0);
  });

  it("keeps it locked when the settlement failed on the ledger", async () => {
    const { merchant } = build({}, { skipPreflight: true }, fakeLedger({ settlement: { status: "FAILED", events: [] } }));
    const { base, close } = await serve(merchant);
    const res = await payFor(base, "/data");
    close();
    expect(res.status).toBe(502);
  });

  it("unlocks one response per payment, also when the same payment is sent again", async () => {
    const { merchant, facilitator } = build({}, { skipPreflight: true });
    const { base, close } = await serve(merchant);
    const { required, challenge } = await challengeOf(base, "/data");
    const payment = paymentFor(challenge, required.accepts[0]!);
    expect((await pay(base, "/data", payment)).status).toBe(200);
    const again = await pay(base, "/data", payment);
    close();
    expect(again.status).toBe(409);
    expect(facilitator.calls.settle).toBe(1);
  });

  it("refuses a settlement hash it has already recorded", async () => {
    const { merchant } = build({}, { skipPreflight: true });
    const { base, close } = await serve(merchant);
    expect((await payFor(base, "/data")).status).toBe(200);
    // A second, different payment for which the facilitator reports the same hash.
    const second = await payFor(base, "/data");
    close();
    expect(second.status).toBe(409);
  });

  it("still releases a settled payment whose proof failed, and keeps it pending to publish later", async () => {
    const store = memoryStore();
    const ledger = fakeLedger({ proofFails: true });
    const { merchant } = build({ store }, { skipPreflight: true }, ledger);
    const { base, close } = await serve(merchant);
    const res = await payFor(base, "/data");
    close();

    expect(res.status).toBe(200);
    const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect((receipt.extensions!.beaver402 as { proofTransaction?: string }).proofTransaction).toBeUndefined();
    const [pending] = await store.pendingProofs();
    expect(pending?.payer).toBe(POLICY);

    ledger.proofFails = false;
    const published = await merchant.publishPendingProofs();
    expect(published).toEqual([{ nonce: pending!.nonce, proofTransaction: PROOF }]);
    expect(await store.pendingProofs()).toEqual([]);
  });
});
