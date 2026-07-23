import express from "express";
import { createMerchantRouter } from "./merchant/demo-endpoint.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());

// merchant demo routes
app.use(createMerchantRouter());

// health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "beaver402" });
});

app.listen(PORT, () => {
  console.log(`beaver402 backend running on port ${PORT}`);
});

export default app;
