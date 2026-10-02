import express from "express";
import { createMerchantRouter } from "./merchant/demo-endpoint.js";
import { createPasskeyRouter } from "./passkey/passkey-routes.js";
import { createPolicyRouter } from "./policy/policy-routes.js";
import { createAgentRouter } from "./agent/agent-routes.js";
import { createOpsRouter } from "./ops/ops-routes.js";
import { createMetricsRouter } from "./ops/metrics-routes.js";
import {
  extractRequestFromToolCall,
  isPaymentRequired,
  extractPaymentDetails,
} from "./mcp/mcp-tool-handler.js";
import { getSupabase, isSupabaseConfigured } from "./lib/supabase.js";
import { describePolicyError } from "./shared/policy-errors.js";
import { network } from "./config/network.js";
import { isAuthenticated } from "./lib/sessions.js";
import { failPublicly } from "./lib/public-error.js";

/**
 * What this process runs.
 *
 * - `agent` holds the delegated signer and the fee account: the owner panel's
 *   API, the paying agent and the payment log.
 * - `merchant` holds the merchant key and nothing else: the paid API.
 * - `all` runs both in one process, which is only for local testnet work.
 *
 * On mainnet the two run as separate deployments, so neither ever has the
 * other's secret.
 */
export type Role = "agent" | "merchant" | "all";

export function roleFromEnv(env: Record<string, string | undefined> = process.env): Role {
  const role = (env.BEAVER402_ROLE ?? "all").trim();
  if (role !== "agent" && role !== "merchant" && role !== "all") {
    throw new Error(`BEAVER402_ROLE must be agent, merchant or all, got "${role}"`);
  }
  if (role === "all" && network().name === "mainnet") {
    throw new Error("on mainnet the agent and the merchant run separately, set BEAVER402_ROLE");
  }
  return role;
}

export function createApp(role: Role = roleFromEnv()) {
  const app = express();

  // Behind a proxy that terminates TLS, such as Vercel, the scheme and the
  // caller's address come from the proxy. The merchant signs the URL it was
  // asked for, so it has to see https rather than the internal http.
  if (process.env.VERCEL || process.env.TRUST_PROXY) {
    app.set("trust proxy", true);
  }

  // The merchant signs over the body exactly as it arrived, so the raw text
  // is kept next to the parsed value.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: string }).rawBody = buf.toString("utf-8");
      },
    })
  );

  if (role === "merchant" || role === "all") {
    // merchant demo routes (402 payment required flow)
    app.use(createMerchantRouter());
  }

  if (role === "agent" || role === "all") {
    // passkey authentication routes
    app.use(createPasskeyRouter());

    // policy management routes and the public configuration
    app.use(createPolicyRouter());

    // the agent facing route that pays for a resource when asked to
    app.use(createAgentRouter());

    // event collection, the event export and the public status
    app.use(createOpsRouter());

    // cookieless traffic counts for the landing page
    app.use(createMetricsRouter());

    // MCP tool call interception endpoint
    app.post("/api/mcp/extract", (req, res) => {
      const { toolCall, response } = req.body;

      if (!toolCall) {
        res.status(400).json({ error: "toolCall is required" });
        return;
      }

      const requestInfo = extractRequestFromToolCall(toolCall);
      if (!requestInfo) {
        res.status(400).json({ error: "could not extract request info from tool call" });
        return;
      }

      // if there is a response, check if payment is required
      let paymentDetails = null;
      if (response && isPaymentRequired(response.statusCode || 0)) {
        paymentDetails = extractPaymentDetails(response.body || {});
      }

      res.json({
        request: requestInfo,
        paymentRequired: !!paymentDetails,
        paymentDetails,
      });
    });

    // The payment log, for the owner. It holds refused attempts as well as
    // settlements, which is the owner's business and nobody else's, so it
    // takes the session a passkey ceremony issued. What anyone may see is
    // on the ledger and on /api/status.
    app.get("/api/transactions", async (req, res) => {
      const session = typeof req.headers["x-session-id"] === "string" ? req.headers["x-session-id"] : "";
      if (!(await isAuthenticated(session))) {
        res.status(401).json({ error: "authentication required" });
        return;
      }
      if (!isSupabaseConfigured()) {
        res.json({ transactions: [] });
        return;
      }
      try {
        const supabase = getSupabase();
        const { data, error } = await supabase
          .from("transactions")
          .select("id, tx_hash, recipient, asset, amount, status, error, created_at")
          .eq("network", network().passphrase)
          .order("created_at", { ascending: false })
          .limit(50);

        if (error) {
          failPublicly(res, 500, "could not read the payment log", error);
          return;
        }

        // The log keeps the whole host error, which is a page of diagnostics.
        // What reaches the panel is the sentence inside it.
        const transactions = (data ?? []).map((row) => ({
          ...row,
          error: row.error ? describePolicyError(row.error) : row.error,
        }));

        res.json({ transactions });
      } catch (err) {
        failPublicly(res, 500, "could not read the payment log", err);
      }
    });
  }

  // health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "beaver402", role, network: network().name });
  });

  return app;
}
