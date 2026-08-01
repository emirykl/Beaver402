import express from "express";
import { createMerchantRouter } from "./merchant/demo-endpoint.js";
import { createPasskeyRouter } from "./passkey/passkey-routes.js";
import { createPolicyRouter, markAuthenticated } from "./policy/policy-routes.js";
import {
  extractRequestFromToolCall,
  isPaymentRequired,
  extractPaymentDetails,
} from "./mcp/mcp-tool-handler.js";
import { getSupabase, isSupabaseConfigured } from "./lib/supabase.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());

// merchant demo routes (402 payment required flow)
app.use(createMerchantRouter());

// passkey authentication routes
app.use(createPasskeyRouter());

// policy management routes (freeze, restore, revoke, state)
app.use(createPolicyRouter());

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

// session auth callback (called after successful passkey auth)
app.post("/api/auth/session", async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  await markAuthenticated(sessionId);
  res.json({ authenticated: true });
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
    res.json({ transactions: data ?? [] });
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
