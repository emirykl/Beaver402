import express, { type Request, type Response } from "express";

import { createAdapter } from "../adapter/x402-client.js";
import { chainPreference, MultiChainAdapter, type ChainAdapter, type PaymentAdapter } from "../adapter/multi-chain.js";
import { enabledChains, type ChainId } from "../chains/registry.js";
import { SolanaAdapter } from "../chains/solana/adapter.js";
import { paidFetch, type FetchLike } from "./paid-fetch.js";
import {
  isAllowedUrl,
  loadAgentAccess,
  requireAgentToken,
  type AgentAccess,
} from "./agent-guard.js";
import { redact } from "../lib/public-error.js";

/**
 * The one place a signing key is used.
 *
 * The agent, and therefore the language model driving it, only ever sees the
 * result of a payment. The key stays here, is read from the environment, and
 * is never returned in a response.
 */
let adapter: PaymentAdapter | null = null;

function getAdapter(): PaymentAdapter {
  if (adapter) return adapter;

  const agentSecret = process.env.AGENT_SECRET;
  if (!agentSecret) {
    throw new Error("AGENT_SECRET is required to authorize payments");
  }

  // One agent key, the delegated signer on every chain it pays on.
  const build: Record<ChainId, () => ChainAdapter> = {
    stellar: () => createAdapter(agentSecret, process.env.POLICY_CONTRACT_ID || ""),
    solana: () => new SolanaAdapter(agentSecret),
  };
  const chains = chainPreference(enabledChains()).map((chain) => ({ chain, adapter: build[chain]() }));
  adapter = chains.length === 1 ? chains[0]!.adapter : new MultiChainAdapter(chains);
  return adapter;
}

const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    json: async () => {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    },
  };
};

export function createAgentRouter(
  fetchImpl: FetchLike = nodeFetch,
  access: AgentAccess = loadAgentAccess()
) {
  const router = express.Router();

  router.post("/api/agent/fetch", requireAgentToken(access), async (req: Request, res: Response) => {
    const { url, method, body, headers } = req.body ?? {};

    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
      return;
    }
    if (!isAllowedUrl(access, url)) {
      res.status(403).json({ error: "the agent is not allowed to fetch from that origin" });
      return;
    }

    try {
      const result = await paidFetch(
        { url, method, body, headers },
        getAdapter(),
        fetchImpl
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: redact(String(err)) });
    }
  });

  return router;
}
