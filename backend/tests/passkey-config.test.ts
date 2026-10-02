import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import { loadNetworkConfig } from "../src/config/network.js";
import { loadPasskeyConfig, rpIdHash } from "../src/config/passkey.js";

const testnet = loadNetworkConfig({});
const mainnet = loadNetworkConfig({ BEAVER_NETWORK: "mainnet", SOROBAN_RPC_URL: "https://rpc.example.com" });

describe("where the owner passkey belongs", () => {
  it("defaults to the local panel on testnet", () => {
    expect(loadPasskeyConfig(testnet, {})).toEqual({
      rpId: "localhost",
      origin: "http://localhost:5173",
    });
  });

  it("has no default on mainnet", () => {
    expect(() => loadPasskeyConfig(mainnet, {})).toThrow(/RP_ID and ORIGIN/);
  });

  it("accepts an https origin on the relying party's domain", () => {
    expect(
      loadPasskeyConfig(mainnet, { RP_ID: "beaver402.vercel.app", ORIGIN: "https://beaver402.vercel.app" })
    ).toEqual({ rpId: "beaver402.vercel.app", origin: "https://beaver402.vercel.app" });
  });

  it("refuses localhost as a mainnet owner", () => {
    expect(() =>
      loadPasskeyConfig(mainnet, { RP_ID: "localhost", ORIGIN: "https://localhost" })
    ).toThrow(/cannot own a mainnet account/);
  });

  it("refuses a plain http origin on mainnet", () => {
    expect(() =>
      loadPasskeyConfig(mainnet, { RP_ID: "beaver402.example", ORIGIN: "http://beaver402.example" })
    ).toThrow(/https/);
  });

  it("refuses an origin on another domain", () => {
    expect(() =>
      loadPasskeyConfig(mainnet, { RP_ID: "beaver402.example", ORIGIN: "https://beaver402.example.evil.com" })
    ).toThrow(/is not on/);
  });

  it("hashes the relying party the way the authenticator does", () => {
    expect(rpIdHash("beaver402.vercel.app").toString("hex")).toBe(
      createHash("sha256").update("beaver402.vercel.app").digest("hex")
    );
  });
});
