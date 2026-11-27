import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";

import { isKnownMerchant, knownMerchants } from "../src/policy/merchants.js";

const OWN = Keypair.random();
const PARTNER = Keypair.random().publicKey();

describe("the merchants the panel lists", () => {
  it("starts with this deployment's own merchant, then the named ones", () => {
    expect(knownMerchants({ MERCHANT_SECRET: OWN.secret(), MERCHANTS: `Partner API=${PARTNER}` })).toEqual([
      { label: "Reference merchant", pubkey: OWN.publicKey() },
      { label: "Partner API", pubkey: PARTNER },
    ]);
  });

  it("takes the public key alone when the merchant runs elsewhere", () => {
    expect(knownMerchants({ MERCHANT_PUBKEY: OWN.publicKey(), MERCHANT_LABEL: "Weather API" })).toEqual([
      { label: "Weather API", pubkey: OWN.publicKey() },
    ]);
  });

  it("lists a key once", () => {
    expect(knownMerchants({ MERCHANT_PUBKEY: OWN.publicKey(), MERCHANTS: `Again=${OWN.publicKey()}` })).toHaveLength(1);
  });

  it("refuses an entry it cannot read", () => {
    expect(() => knownMerchants({ MERCHANTS: "no-key-here" })).toThrow(/Label=G/);
    expect(() => knownMerchants({ MERCHANTS: "Partner=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" })).toThrow(/G address/);
  });

  it("knows which keys are on the list", () => {
    const env = { MERCHANT_PUBKEY: OWN.publicKey(), MERCHANTS: `Partner=${PARTNER}` };
    expect(isKnownMerchant(PARTNER, env)).toBe(true);
    expect(isKnownMerchant(Keypair.random().publicKey(), env)).toBe(false);
  });
});

vi.mock("../src/lib/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isAuthenticated: async () => true,
}));

describe("approving a merchant from the panel", () => {
  it("is refused for a key that is not on the list, before anything is prepared", async () => {
    process.env.MERCHANT_PUBKEY = OWN.publicKey();
    process.env.MERCHANTS = `Partner=${PARTNER}`;
    const { createPolicyRouter } = await import("../src/policy/policy-routes.js");
    const app = express();
    app.use(express.json());
    app.use(createPolicyRouter());
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/policy/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add_merchant", pubkey: Keypair.random().publicKey() }),
    });
    server.close();
    delete process.env.MERCHANT_PUBKEY;
    delete process.env.MERCHANTS;
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only a merchant listed/);
  });
});
