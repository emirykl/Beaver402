/**
 * The example merchant as a Vercel function. Completed payments go to
 * Supabase, because a serverless function has no disk that outlives it.
 *
 * Environment: the variables in ../example/.env.example, plus SUPABASE_URL
 * and SUPABASE_SERVICE_KEY. Create the beaver402_settlements table first
 * (POSTGRES_SCHEMA in the package).
 */
import express from "express";
import { createClient } from "@supabase/supabase-js";
import { captureRawBody, createMerchant, optionsFromEnv, supabaseStore, usdc, type PaymentContext } from "@beaver402/merchant";

const supabase = createClient(process.env.SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_KEY ?? "", {
  auth: { persistSession: false },
});
const merchant = createMerchant({
  ...optionsFromEnv(process.env, supabaseStore(supabase)),
  description: "Beaver402 example merchant",
});

const app = express();
app.use(express.json({ verify: captureRawBody }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", network: merchant.info().network });
});

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

export default app;
