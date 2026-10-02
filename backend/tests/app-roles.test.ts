import { describe, it, expect, afterEach } from "vitest";

import { roleFromEnv } from "../src/app.js";
import { resetNetworkConfig } from "../src/config/network.js";

afterEach(() => {
  delete process.env.BEAVER_NETWORK;
  delete process.env.SOROBAN_RPC_URL;
  resetNetworkConfig();
});

describe("what a process runs", () => {
  it("runs everything in one process for local testnet work", () => {
    expect(roleFromEnv({})).toBe("all");
  });

  it("refuses a role it does not know", () => {
    expect(() => roleFromEnv({ BEAVER402_ROLE: "owner" })).toThrow(/agent, merchant or all/);
  });

  it("keeps the agent and the merchant apart on mainnet", () => {
    process.env.BEAVER_NETWORK = "mainnet";
    process.env.SOROBAN_RPC_URL = "https://rpc.example.com";
    resetNetworkConfig();
    expect(() => roleFromEnv({})).toThrow(/run separately/);
    expect(roleFromEnv({ BEAVER402_ROLE: "agent" })).toBe("agent");
    expect(roleFromEnv({ BEAVER402_ROLE: "merchant" })).toBe("merchant");
  });
});
