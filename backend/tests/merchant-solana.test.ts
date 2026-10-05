import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";

import { createMerchantRouter, type MerchantConfig } from "../src/merchant/demo-endpoint.js";
import type { MerchantDeps } from "../src/merchant/x402-merchant.js";
import { PaymentBindingError } from "../src/merchant/payment-binding.js";
import { solanaMerchant, type SolanaMerchant } from "../src/chains/solana/merchant.js";
import { loadSolanaConfig } from "../src/chains/solana/config.js";
import {
  challengeFor,
  challengeFrom,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  SOLANA_SCHEME,
} from "../src/x402/protocol.js";
import { verifyMerchantSignature } from "../src/merchant/challenge-signer.js";
import { TESTNET, USDC } from "./helpers/x402.js";

const MERCHANT = Keypair.random();
const RECIPIENT = Keypair.random().publicKey();
const config = loadSolanaConfig({ SOLANA_POLICY_ADDRESS: "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG" });
const SIGNATURE = "5".repeat(87);

function merchantConfig(): MerchantConfig {
  return { keypair: MERCHANT, recipient: RECIPIENT, asset: USDC, network: TESTNET, price: "1000000" };
}

function deps(solana: SolanaMerchant | null) {
  const record = vi.fn(async () => true);
  const settle = vi.fn();
  const built: MerchantDeps = {
    merchant: merchantConfig,
    facilitator: () => ({ verify: vi.fn(), settle }),
    confirm: vi.fn(),
    record,
    publishProof: vi.fn(),
    solana: () => solana,
  };
  return { deps: built, record, stellarSettle: settle };
}

async function serve(merchantDeps: MerchantDeps) {
  const app = express();
  app.use(express.json());
  app.use(createMerchantRouter(merchantDeps));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** The real Solana side, with settlement replaced. */
function fakeSolana(settle: SolanaMerchant["settle"]): SolanaMerchant {
  const real = solanaMerchant({ keypair: MERCHANT }, config);
  return { ...real, settle };
}

describe("a merchant selling on Stellar and Solana", () => {
  it("offers both networks, each with its own challenge over the same request", async () => {
    const { deps: d } = deps(solanaMerchant({ keypair: MERCHANT }, config));
    const { base, close } = await serve(d);
    try {
      const first = await fetch(`${base}/api/data`);
      expect(first.status).toBe(402);
      const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED")!);
      expect(required.accepts.map((a) => a.network)).toEqual(["stellar:testnet", config.caip2]);

      const solana = required.accepts[1]!;
      expect(solana.scheme).toBe(SOLANA_SCHEME);
      expect(solana.asset).toBe(config.usdcMint);
      expect(solana.amount).toBe("100000");
      expect(solana.extra?.feePayer).toBe(solana.payTo);

      const stellarChallenge = challengeFrom(required)!;
      const solanaChallenge = challengeFor(required, config.caip2)!;
      expect(challengeFor(required, "stellar:testnet")).toEqual(stellarChallenge);
      expect(verifyMerchantSignature(solanaChallenge)).toBe(true);
      expect(solanaChallenge.fields.network).toBe(config.caip2);
      expect(solanaChallenge.fields.normalizedEndpoint).toBe(stellarChallenge.fields.normalizedEndpoint);
      expect(solanaChallenge.fields.nonce).not.toBe(stellarChallenge.fields.nonce);
    } finally {
      close();
    }
  });

  it("offers Stellar alone when Solana is off", async () => {
    const { deps: d } = deps(null);
    const { base, close } = await serve(d);
    try {
      const required = decodePaymentRequiredHeader((await fetch(`${base}/api/data`)).headers.get("PAYMENT-REQUIRED")!);
      expect(required.accepts).toHaveLength(1);
      expect((required.extensions?.beaver402 as { challenges?: unknown }).challenges).toBeUndefined();
    } finally {
      close();
    }
  });

  it("settles a Solana payment itself and releases the resource with a receipt", async () => {
    const settle = vi.fn<SolanaMerchant["settle"]>(async () => ({
      settlement: { success: true, transaction: SIGNATURE, network: config.caip2, payer: config.policy! } as never,
      terms: {
        payer: config.policy!,
        merchantPubkey: Buffer.alloc(32),
        merchantSignature: Buffer.alloc(64),
        requestDigest: Buffer.alloc(32),
        recipient: "r",
        asset: config.usdcMint,
        amount: "100000",
        nonce: "ab".repeat(32),
        expiry: "1",
      },
      challengeHash: "cd".repeat(32),
    }));
    const solana = fakeSolana(settle);
    const { deps: d, record, stellarSettle } = deps(solana);
    const { base, close } = await serve(d);
    try {
      const payload = { x402Version: 2, resource: { url: `${base}/api/data` }, accepted: solana.requirements(), payload: { transaction: "AA==" } };
      const paid = await fetch(`${base}/api/data`, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload as never) } });
      expect(paid.status).toBe(200);
      expect(settle).toHaveBeenCalledOnce();
      expect(stellarSettle).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ network: config.caip2, txHash: SIGNATURE, facilitator: "merchant" }));
      const receipt = decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE")!);
      expect(receipt.transaction).toBe(SIGNATURE);
      expect((receipt.extensions?.beaver402 as { proofTransaction: string }).proofTransaction).toBe(SIGNATURE);
    } finally {
      close();
    }
  });

  it("answers a refused Solana payment with a fresh 402 naming the reason", async () => {
    const solana = fakeSolana(async () => {
      throw new PaymentBindingError("the payment was authorized for a different request");
    });
    const { deps: d, record } = deps(solana);
    const { base, close } = await serve(d);
    try {
      const payload = { x402Version: 2, resource: { url: `${base}/api/data` }, accepted: solana.requirements(), payload: { transaction: "AA==" } };
      const refused = await fetch(`${base}/api/data`, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload as never) } });
      expect(refused.status).toBe(402);
      expect((await refused.json()).error).toBe("the payment was authorized for a different request");
      expect(record).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("refuses a Solana payment whose requirements were changed", async () => {
    const settle = vi.fn();
    const solana = fakeSolana(settle);
    const { deps: d } = deps(solana);
    const { base, close } = await serve(d);
    try {
      const accepted = { ...solana.requirements(), amount: "1" };
      const payload = { x402Version: 2, resource: { url: `${base}/api/data` }, accepted, payload: { transaction: "AA==" } };
      const refused = await fetch(`${base}/api/data`, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload as never) } });
      expect(refused.status).toBe(402);
      expect(settle).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });
});
