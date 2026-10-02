import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

import { resetNetworkConfig } from "../src/config/network.js";
import { isAllowedUrl, loadAgentAccess } from "../src/agent/agent-guard.js";
import { createAgentRouter } from "../src/agent/agent-routes.js";

const TOKEN = "t".repeat(40);

function withEnv(values: Record<string, string | undefined>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetNetworkConfig();
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetNetworkConfig();
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("who may make the agent pay", () => {
  it("lets anything through on a local testnet without a token", () => {
    restore = withEnv({ BEAVER_NETWORK: undefined, AGENT_API_TOKEN: undefined, AGENT_ALLOWED_ORIGINS: undefined });
    const access = loadAgentAccess();
    expect(access.token).toBeNull();
    expect(isAllowedUrl(access, "http://localhost:3002/api/data")).toBe(true);
  });

  it("will not start on mainnet without a token", () => {
    restore = withEnv({
      BEAVER_NETWORK: "mainnet",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      AGENT_API_TOKEN: undefined,
      AGENT_ALLOWED_ORIGINS: "https://merchant.example",
    });
    expect(() => loadAgentAccess()).toThrow(/AGENT_API_TOKEN/);
  });

  it("will not start on mainnet with a short token", () => {
    restore = withEnv({
      BEAVER_NETWORK: "mainnet",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      AGENT_API_TOKEN: "short",
      AGENT_ALLOWED_ORIGINS: "https://merchant.example",
    });
    expect(() => loadAgentAccess()).toThrow(/32 characters/);
  });

  it("will not start on mainnet without a list of merchants", () => {
    restore = withEnv({
      BEAVER_NETWORK: "mainnet",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      AGENT_API_TOKEN: TOKEN,
      AGENT_ALLOWED_ORIGINS: undefined,
    });
    expect(() => loadAgentAccess()).toThrow(/AGENT_ALLOWED_ORIGINS/);
  });

  it("only fetches from listed merchants, over https, on mainnet", () => {
    restore = withEnv({
      BEAVER_NETWORK: "mainnet",
      SOROBAN_RPC_URL: "https://rpc.example.com",
      AGENT_API_TOKEN: TOKEN,
      AGENT_ALLOWED_ORIGINS: "https://merchant.example",
    });
    const access = loadAgentAccess();
    expect(isAllowedUrl(access, "https://merchant.example/api/data")).toBe(true);
    expect(isAllowedUrl(access, "https://elsewhere.example/api/data")).toBe(false);
    expect(isAllowedUrl(access, "http://merchant.example/api/data")).toBe(false);
    expect(isAllowedUrl(access, "file:///etc/passwd")).toBe(false);
    expect(isAllowedUrl(access, "not a url")).toBe(false);
  });
});

describe("the agent route itself", () => {
  async function serve(access: { token: string | null; allowedOrigins: string[] | null }) {
    const app = express();
    app.use(express.json());
    // Nothing here may reach a merchant, so the fetch fails loudly if it does.
    app.use(
      createAgentRouter(async () => {
        throw new Error("the route fetched something it should have refused");
      }, access)
    );
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/api/agent/fetch`, close: () => server.close() };
  }

  it("refuses a caller without the token", async () => {
    const { url, close } = await serve({ token: TOKEN, allowedOrigins: null });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://merchant.example/api/data" }),
    });
    close();
    expect(response.status).toBe(401);
  });

  it("refuses a caller with the wrong token", async () => {
    const { url, close } = await serve({ token: TOKEN, allowedOrigins: null });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${"x".repeat(40)}` },
      body: JSON.stringify({ url: "https://merchant.example/api/data" }),
    });
    close();
    expect(response.status).toBe(401);
  });

  it("refuses a merchant that is not on the list, even with the token", async () => {
    const { url, close } = await serve({ token: TOKEN, allowedOrigins: ["https://merchant.example"] });
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ url: "https://elsewhere.example/api/data" }),
    });
    close();
    expect(response.status).toBe(403);
  });
});
