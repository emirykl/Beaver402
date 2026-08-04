import express, { type Request, type Response } from "express";

import { createAdapter, type Beaver402Adapter } from "../adapter/x402-client.js";
import { paidFetch, type FetchLike } from "./paid-fetch.js";

/**
 * The one place a signing key is used.
 *
 * The agent, and therefore the language model driving it, only ever sees the
 * result of a payment. The key stays here, is read from the environment, and
 * is never returned in a response.
 */
let adapter: Beaver402Adapter | null = null;

function getAdapter(): Beaver402Adapter {
  if (adapter) return adapter;

  const agentSecret = process.env.AGENT_SECRET;
  if (!agentSecret) {
    throw new Error("AGENT_SECRET is required to authorize payments");
  }

  adapter = createAdapter(agentSecret, process.env.POLICY_CONTRACT_ID || "");
  return adapter;
}

const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
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

export function createAgentRouter(fetchImpl: FetchLike = nodeFetch) {
  const router = express.Router();

  router.post("/api/agent/fetch", async (req: Request, res: Response) => {
    const { url, method, body, headers } = req.body ?? {};

    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
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
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
