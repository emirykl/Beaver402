import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

/**
 * A provider URL carrying its key, planted where the public status route and
 * the server log would pick it up. Neither may ever show it.
 */
const CANARY_KEY = "c4n4ry9f3c2b7a6d5e4f3a2b1c0d9e8f";
const CANARY_URL = `https://mainnet.provider.example/v1/${CANARY_KEY}`;

const state = vi.hoisted(() => ({
  collectorRow: null as Record<string, unknown> | null,
  policyError: null as Error | null,
}));

vi.mock("../src/lib/supabase.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/supabase.js")>();
  const query = (table: string) => {
    const result =
      table === "collector_state" ? { data: state.collectorRow, error: null } : { data: [], error: null };
    const chain: Record<string, unknown> = {};
    for (const step of ["select", "eq", "order", "limit"]) chain[step] = () => chain;
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
    return chain;
  };
  return { ...original, isSupabaseConfigured: () => true, getSupabase: () => ({ from: query }) };
});

vi.mock("../src/policy/policy-routes.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/policy/policy-routes.js")>();
  return {
    ...original,
    publicConfig: () => ({ network: "mainnet", contractId: null, contractUrl: null, asset: null }),
    readPolicyState: async () => {
      if (state.policyError) throw state.policyError;
      return {
        frozen: false,
        agentSigner: null,
        merchantApproved: true,
        limits: {},
        velocityTxCount: 0,
        velocityTotalAmount: "0",
        velocityWindowStart: 0,
      };
    },
  };
});

const { createOpsRouter } = await import("../src/ops/ops-routes.js");

async function getStatus(): Promise<{ status: number; text: string }> {
  const app = express();
  app.use(createOpsRouter());
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    return { status: response.status, text: await response.text() };
  } finally {
    server.close();
  }
}

describe("the public status route with a credential in the way", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    state.collectorRow = null;
    state.policyError = null;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not show a raw collector error stored before summaries existed", async () => {
    state.collectorRow = {
      last_run_at: "2026-10-04T00:00:00Z",
      last_ledger: 42,
      last_error: `request to ${CANARY_URL} failed, reason: socket hang up`,
    };
    const { status, text } = await getStatus();
    expect(status).toBe(200);
    expect(text).not.toContain(CANARY_KEY);
    expect(JSON.parse(text).collector).toEqual({
      last_run_at: "2026-10-04T00:00:00Z",
      last_ledger: 42,
      last_error: "the collection failed",
    });
  });

  it("passes through the summaries the collector writes", async () => {
    state.collectorRow = { last_run_at: null, last_ledger: 7, last_error: "ledgers 10 to 20 had left the RPC window before they were read" };
    expect(JSON.parse((await getStatus()).text).collector.last_error).toBe(
      "ledgers 10 to 20 had left the RPC window before they were read"
    );
    state.collectorRow = { last_run_at: null, last_ledger: 7, last_error: "the RPC could not be reached" };
    expect(JSON.parse((await getStatus()).text).collector.last_error).toBe("the RPC could not be reached");
    state.collectorRow = { last_run_at: null, last_ledger: 7, last_error: null };
    expect(JSON.parse((await getStatus()).text).collector.last_error).toBeNull();
  });

  it("keeps the credential out of the response and the server log when the RPC call fails", async () => {
    state.policyError = new Error(`request to ${CANARY_URL} failed`, {
      cause: new Error(`connect ECONNREFUSED while calling ${CANARY_URL}`),
    });
    const { status, text } = await getStatus();
    expect(status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: "could not read the status" });
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(CANARY_KEY);
    expect(logged.join("\n")).toContain("[redacted]");
    expect(logged.join("\n")).toContain("caused by");
  });
});
