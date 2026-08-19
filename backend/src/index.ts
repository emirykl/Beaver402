import express from "express";
import { createMerchantRouter } from "./merchant/demo-endpoint.js";
import { createPasskeyRouter } from "./passkey/passkey-routes.js";
import { createPolicyRouter } from "./policy/policy-routes.js";
import { createAgentRouter } from "./agent/agent-routes.js";
import {
  extractRequestFromToolCall,
  isPaymentRequired,
  extractPaymentDetails,
} from "./mcp/mcp-tool-handler.js";
import { getSupabase, isSupabaseConfigured } from "./lib/supabase.js";
import { describePolicyError } from "./shared/policy-errors.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());

// merchant demo routes (402 payment required flow)
app.use(createMerchantRouter());

// passkey authentication routes
app.use(createPasskeyRouter());

// policy management routes (freeze, restore, revoke, state)
app.use(createPolicyRouter());

// the agent facing route that pays for a resource when asked to
app.use(createAgentRouter());

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

// transaction history
app.get("/api/transactions", async (_req, res) => {
  if (!isSupabaseConfigured()) {
    res.json({ transactions: [] });
    return;
  }
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: String(err) });
  }
});

// health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "beaver402" });
});

app.listen(PORT, () => {
  console.log(`beaver402 backend running on port ${PORT}`);
});

export default app;
