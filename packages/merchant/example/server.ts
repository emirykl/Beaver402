/**
 * A paid API with two routes behind Beaver402:
 *
 *   GET  /forecast?city=...   0.1 USDC, the query string is part of what is paid for
 *   POST /summarize           0.2 USDC, the JSON body is part of what is paid for
 *
 * GET /merchant prints what the account owner needs to approve this
 * merchant. Configuration comes from .env; see .env.example.
 */
import express from "express";
import {
  captureRawBody,
  createMerchant,
  fileStore,
  memoryStore,
  optionsFromEnv,
  usdc,
  type PaymentContext,
} from "@beaver402/merchant";

const storePath = process.env.SETTLEMENT_STORE;
const merchant = createMerchant(optionsFromEnv(process.env, storePath ? fileStore(storePath) : memoryStore()));

const app = express();
// The challenge signs the exact request body, so its raw bytes are kept.
app.use(express.json({ verify: captureRawBody }));

app.get("/merchant", (_req, res) => {
  res.json(merchant.info());
});

app.get("/forecast", merchant.protect({ description: "One city forecast" }), (req, res) => {
  const { payment } = res.locals.beaver402 as PaymentContext;
  res.json({
    city: req.query.city ?? "Istanbul",
    forecast: "sunny, 18°C",
    paidWith: payment.txHash,
    proofOfIntent: payment.proofTransaction ?? null,
  });
});

app.post("/summarize", merchant.protect({ price: usdc("0.2"), description: "Summarise a text" }), (req, res) => {
  const text = String(req.body?.text ?? "");
  res.json({ summary: text.split(/\s+/).slice(0, 12).join(" "), words: text.split(/\s+/).filter(Boolean).length });
});

const port = Number(process.env.PORT ?? 4021);
const results = await merchant.check();
for (const r of results) console.log(`${r.ok ? "ok  " : r.severity === "warning" ? "warn" : "FAIL"}  ${r.name}: ${r.detail}`);
app.listen(port, () => {
  const info = merchant.info();
  console.log(`\nBeaver402 example merchant on ${info.network}, http://localhost:${port}`);
  console.log(`merchant key: ${info.merchantPubkey}`);
  console.log(`recipient:    ${info.recipient}`);
});
