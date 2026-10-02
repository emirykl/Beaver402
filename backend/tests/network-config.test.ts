import { describe, it, expect } from "vitest";
import { Networks } from "@stellar/stellar-sdk";

import {
  loadNetworkConfig,
  usdcContractFor,
  verifyNetwork,
  resetNetworkConfig,
  NetworkConfigError,
} from "../src/config/network.js";

const MAINNET_RPC = "https://rpc.example.com";

describe("choosing a network", () => {
  it("runs on testnet when nothing says otherwise", () => {
    const config = loadNetworkConfig({});
    expect(config.name).toBe("testnet");
    expect(config.caip2).toBe("stellar:testnet");
    expect(config.passphrase).toBe(Networks.TESTNET);
    expect(config.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(config.explorer).toBe("https://stellar.expert/explorer/testnet");
  });

  it("refuses a network it does not know", () => {
    expect(() => loadNetworkConfig({ BEAVER_NETWORK: "pubnet" })).toThrow(NetworkConfigError);
  });

  it("has no mainnet RPC default, so one has to be chosen", () => {
    expect(() => loadNetworkConfig({ BEAVER_NETWORK: "mainnet" })).toThrow(/SOROBAN_RPC_URL/);
  });

  it("builds a mainnet configuration from an explicit RPC", () => {
    const config = loadNetworkConfig({ BEAVER_NETWORK: "mainnet", SOROBAN_RPC_URL: MAINNET_RPC });
    expect(config.caip2).toBe("stellar:pubnet");
    expect(config.passphrase).toBe(Networks.PUBLIC);
    expect(config.explorer).toBe("https://stellar.expert/explorer/public");
    expect(config.facilitatorUrl).toBe("https://channels.openzeppelin.com/x402");
  });
});

describe("refusing a configuration that disagrees with itself", () => {
  it("refuses the testnet passphrase on mainnet", () => {
    expect(() =>
      loadNetworkConfig({
        BEAVER_NETWORK: "mainnet",
        SOROBAN_RPC_URL: MAINNET_RPC,
        NETWORK_PASSPHRASE: Networks.TESTNET,
      })
    ).toThrow(/not the mainnet passphrase/);
  });

  it("refuses the mainnet passphrase on testnet", () => {
    expect(() => loadNetworkConfig({ NETWORK_PASSPHRASE: Networks.PUBLIC })).toThrow(
      /not the testnet passphrase/
    );
  });

  it("refuses a testnet RPC on mainnet", () => {
    expect(() =>
      loadNetworkConfig({ BEAVER_NETWORK: "mainnet", SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org" })
    ).toThrow(/test network/);
  });

  it("refuses an unencrypted RPC on mainnet", () => {
    expect(() =>
      loadNetworkConfig({ BEAVER_NETWORK: "mainnet", SOROBAN_RPC_URL: "http://rpc.example.com" })
    ).toThrow(/https/);
  });

  it("refuses the testnet facilitator on mainnet", () => {
    expect(() =>
      loadNetworkConfig({
        BEAVER_NETWORK: "mainnet",
        SOROBAN_RPC_URL: MAINNET_RPC,
        FACILITATOR_URL: "https://channels.openzeppelin.com/x402/testnet",
      })
    ).toThrow(/testnet facilitator/);
  });

  it("refuses a token that is not this network's USDC", () => {
    expect(() =>
      loadNetworkConfig({
        BEAVER_NETWORK: "mainnet",
        SOROBAN_RPC_URL: MAINNET_RPC,
        USDC_CONTRACT: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      })
    ).toThrow(/USDC on mainnet is/);
  });
});

describe("the USDC each network pays in", () => {
  it("derives Circle's testnet USDC contract", () => {
    expect(loadNetworkConfig({}).usdcContract).toBe(
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
    );
  });

  it("derives Circle's mainnet USDC contract, the one the x402 package names", () => {
    // Also what Horizon lists as the contract for USDC issued by Circle's
    // mainnet account, checked on 2026-10-02.
    expect(
      usdcContractFor("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", Networks.PUBLIC)
    ).toBe("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
  });
});

describe("asking the RPC which network it serves", () => {
  it("accepts an endpoint that serves the configured network", async () => {
    resetNetworkConfig();
    const config = loadNetworkConfig({});
    await expect(
      verifyNetwork(config, { getNetwork: async () => ({ passphrase: Networks.TESTNET }) as never })
    ).resolves.toBeUndefined();
  });

  it("refuses an endpoint that serves another network", async () => {
    resetNetworkConfig();
    const config = loadNetworkConfig({});
    await expect(
      verifyNetwork(config, { getNetwork: async () => ({ passphrase: Networks.PUBLIC }) as never })
    ).rejects.toThrow(/not testnet/);
    resetNetworkConfig();
  });
});
