import express from "express";
import { createMerchantRouter } from "./merchant/demo-endpoint.js";
import { createPasskeyRouter } from "./passkey/passkey-routes.js";
import { createPolicyRouter, markAuthenticated } from "./policy/policy-routes.js";
import {
  extractRequestFromToolCall,
  isPaymentRequired,
  extractPaymentDetails,
} from "./mcp/mcp-tool-handler.js";

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
app.post("/api/auth/session", (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  markAuthenticated(sessionId);
  res.json({ authenticated: true });
});

// health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "beaver402" });
});

app.listen(PORT, () => {
  console.log(`beaver402 backend running on port ${PORT}`);
});

export default app;
