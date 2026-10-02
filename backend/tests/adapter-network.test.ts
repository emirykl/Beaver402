import { describe, it, expect } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";

import { Beaver402Adapter } from "../src/adapter/x402-client.js";
import { resetNetworkConfig } from "../src/config/network.js";
import { paymentRequired, requirementsFor, signedChallenge, USDC, type Terms } from "./helpers/x402.js";

const MAINNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ENDPOINT = "https://merchant.example/api/data";

const adapter = new Beaver402Adapter({
  agentKeypair: Keypair.random(),
  policyContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
});

const base: Terms = { merchant: Keypair.random(), recipient: Keypair.random().publicKey(), endpoint: ENDPOINT };

describe("a backend set up for testnet", () => {
  resetNetworkConfig();

  it("will not pay a merchant that only accepts mainnet", async () => {
    const required = paymentRequired({ ...base, asset: MAINNET_USDC, network: Networks.PUBLIC });
    required.accepts[0]!.network = "stellar:pubnet";
    const result = await adapter.preparePayment(required, "GET", ENDPOINT);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not accept USDC on stellar:testnet/);
  });

  it("will not sign a challenge made for mainnet even if the requirements say testnet", async () => {
    const required = paymentRequired(base, signedChallenge({ ...base, network: Networks.PUBLIC }));
    const result = await adapter.preparePayment(required, "GET", ENDPOINT);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/another network/);
  });

  it("will not pay when fees are not sponsored", async () => {
    const required = paymentRequired(base);
    required.accepts[0]!.extra = {};
    const result = await adapter.preparePayment(required, "GET", ENDPOINT);
    expect(result.error).toMatch(/fees sponsored/);
  });

  it("will not pay without a Beaver402 challenge", async () => {
    const required = paymentRequired(base);
    delete required.extensions;
    const result = await adapter.preparePayment(required, "GET", ENDPOINT);
    expect(result.error).toMatch(/without a signed Beaver402 challenge/);
  });

  for (const [what, change] of [
    ["the amount", { amount: "2000000" }],
    ["the recipient", { payTo: Keypair.random().publicKey() }],
  ] as const) {
    it(`will not pay when the requirements and the challenge disagree on ${what}`, async () => {
      const required = paymentRequired(base);
      Object.assign(required.accepts[0]!, change);
      const result = await adapter.preparePayment(required, "GET", ENDPOINT);
      expect(result.success).toBe(false);
      expect(result.error).toContain(`disagree on ${what}`);
    });
  }

  it("gets past every network and binding check for its own network and token", async () => {
    // A forged merchant signature stops it at the next check, which shows
    // everything before it let this payment through.
    const challenge = signedChallenge(base);
    const forged = { ...challenge, merchantSignature: Buffer.alloc(64).toString("base64") };
    const result = await adapter.preparePayment(paymentRequired(base, forged), "GET", ENDPOINT);
    expect(result.error).toMatch(/merchant signature/);
    expect(requirementsFor(base).asset).toBe(USDC);
  });
});
