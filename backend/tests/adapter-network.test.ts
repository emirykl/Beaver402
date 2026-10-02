import { describe, it, expect } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";

import { createSignedChallenge } from "../src/merchant/challenge-signer.js";
import { Beaver402Adapter } from "../src/adapter/x402-client.js";
import { resetNetworkConfig } from "../src/config/network.js";

const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const MAINNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ENDPOINT = "https://merchant.example/api/data";

const adapter = new Beaver402Adapter({
  agentKeypair: Keypair.random(),
  policyContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
});

function challenge(network: string, asset: string) {
  return createSignedChallenge({
    merchantKeypair: Keypair.random(),
    httpMethod: "GET",
    endpoint: ENDPOINT,
    recipient: Keypair.random().publicKey(),
    asset,
    amount: "1000000",
    network,
  });
}

describe("a backend set up for testnet", () => {
  resetNetworkConfig();

  it("will not sign a challenge made for mainnet", async () => {
    const result = await adapter.processPayment(challenge(Networks.PUBLIC, MAINNET_USDC), "GET", ENDPOINT);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/another network/);
  });

  it("will not pay in a token other than the account's USDC", async () => {
    const result = await adapter.processPayment(
      challenge(Networks.TESTNET, "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"),
      "GET",
      ENDPOINT
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pays in USDC/);
  });

  it("gets past both checks for its own network and token", async () => {
    // The merchant signature is checked next. A forged one stops it there,
    // which shows the network and token checks let this one through.
    const good = challenge(Networks.TESTNET, TESTNET_USDC);
    const forged = { ...good, merchantSignature: Buffer.alloc(64).toString("base64") };
    const result = await adapter.processPayment(forged, "GET", ENDPOINT);
    expect(result.error).toMatch(/merchant signature/);
  });
});
