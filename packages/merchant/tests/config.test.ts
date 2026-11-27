import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

import { createMerchant } from "../src/merchant.js";
import { MerchantConfigError, optionsFromEnv, resolveConfig, usdc, usdcContract } from "../src/config.js";
import { memoryStore, type SettlementStore } from "../src/store.js";
import { options, USDC } from "./helpers/fixtures.js";

const persistent: SettlementStore = { ...memoryStore(), persistent: true };
const mainnet = {
  network: "mainnet" as const,
  rpcUrl: "https://rpc.example.com",
  usdcContract: usdcContract("mainnet"),
  publicUrl: "https://api.example.com",
  store: persistent,
};

function refuses(overrides: Parameters<typeof options>[0], pattern: RegExp) {
  expect(() => resolveConfig(options(overrides))).toThrow(MerchantConfigError);
  expect(() => resolveConfig(options(overrides))).toThrow(pattern);
}

describe("configuration", () => {
  it("accepts a complete testnet setup", () => {
    const config = resolveConfig(options());
    expect(config.usdcContract).toBe(USDC);
    expect(config.facilitatorUrl).toBe("https://channels.openzeppelin.com/x402/testnet");
  });

  it("accepts a complete mainnet setup", () => {
    expect(resolveConfig(options(mainnet)).facilitatorUrl).toBe("https://channels.openzeppelin.com/x402");
  });

  it("knows Circle's USDC contracts", () => {
    expect(usdcContract("testnet")).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    expect(usdcContract("mainnet")).toBe("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
  });

  it("needs the network named", () => refuses({ network: undefined as never }, /network must be/));
  it("needs the USDC contract written out", () => refuses({ usdcContract: "" }, /usdcContract is required/));
  it("refuses another network's USDC", () => refuses({ usdcContract: usdcContract("mainnet") }, /but USDC on testnet/));
  it("refuses a token that is not USDC", () => refuses({ usdcContract: "CCYRWISLRHOL37FXT4FBOJBWTBIZCU2V3ST3TVNR25VQOFDZC7YE4Z2N" }, /but USDC/));
  it("needs a facilitator API key", () => refuses({ facilitatorApiKey: " " }, /facilitatorApiKey/));
  it("refuses the mainnet facilitator on testnet", () => refuses({ facilitatorUrl: "https://channels.openzeppelin.com/x402" }, /mainnet facilitator/));
  it("needs a merchant secret", () => refuses({ merchantSecret: "GABC" }, /merchantSecret/));
  it("refuses a contract as recipient", () => refuses({ recipient: USDC }, /classic Stellar account/));
  it("refuses a muxed recipient", () =>
    refuses({ recipient: new StellarSdk.MuxedAccount(new StellarSdk.Account(StellarSdk.Keypair.random().publicKey(), "0"), "1").accountId() }, /classic/));
  it("refuses a price that is not a positive integer", () => {
    refuses({ price: "0.1" }, /positive integer/);
    refuses({ price: "0" }, /positive integer/);
  });
  it("refuses a public URL with a path", () => refuses({ publicUrl: "https://api.example.com/v1" }, /origin/));
  it("refuses a challenge valid for longer than the contract allows", () => refuses({ challengeSeconds: 901 }, /challengeSeconds/));

  describe("on mainnet", () => {
    it("needs an RPC", () => refuses({ ...mainnet, rpcUrl: undefined }, /rpcUrl is required/));
    it("needs it over https", () => refuses({ ...mainnet, rpcUrl: "http://rpc.example.com" }, /https/));
    it("refuses a testnet RPC", () => refuses({ ...mainnet, rpcUrl: "https://soroban-testnet.stellar.org" }, /test network/));
    it("refuses a testnet facilitator", () => refuses({ ...mainnet, facilitatorUrl: "https://channels.openzeppelin.com/x402/testnet" }, /testnet facilitator/));
    it("needs the public URL", () => refuses({ ...mainnet, publicUrl: undefined }, /publicUrl is required/));
    it("needs it over https", () => refuses({ ...mainnet, publicUrl: "http://api.example.com" }, /https/));
    it("refuses a store that forgets payments on restart", () => refuses({ ...mainnet, store: memoryStore() }, /persistent store/));
  });

  it("is checked when the merchant is created, before anything is signed", () => {
    expect(() => createMerchant(options({ usdcContract: "" }))).toThrow(MerchantConfigError);
  });
});

describe("USDC amounts", () => {
  it("converts decimal USDC to integer units", () => {
    expect(usdc("0.1")).toBe("1000000");
    expect(usdc("1")).toBe("10000000");
    expect(usdc("0.0000001")).toBe("1");
  });
  it("refuses more than 7 decimals or anything else", () => {
    expect(() => usdc("0.00000001")).toThrow();
    expect(() => usdc("-1")).toThrow();
    expect(() => usdc("1e3")).toThrow();
  });
});

describe("environment", () => {
  it("reads the documented variables", () => {
    const opts = optionsFromEnv(
      {
        BEAVER402_NETWORK: "testnet",
        USDC_CONTRACT: USDC,
        FACILITATOR_API_KEY: "k",
        MERCHANT_SECRET: StellarSdk.Keypair.random().secret(),
        RECIPIENT_ADDRESS: StellarSdk.Keypair.random().publicKey(),
        PRICE_USDC: "0.25",
      },
      memoryStore()
    );
    expect(opts.price).toBe("2500000");
    expect(() => resolveConfig(opts)).not.toThrow();
  });
  it("needs the network named", () => {
    expect(() => optionsFromEnv({}, memoryStore())).toThrow(/BEAVER402_NETWORK/);
  });
});
