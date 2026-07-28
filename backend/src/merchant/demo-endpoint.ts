import express, { type Request, type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createSignedChallenge,
  verifyMerchantSignature,
} from "./challenge-signer.js";

const MERCHANT_SECRET = process.env.MERCHANT_SECRET;
if (!MERCHANT_SECRET) {
  throw new Error(
    "MERCHANT_SECRET environment variable is required. Generate one with: node -e \"console.log(require('@stellar/stellar-sdk').Keypair.random().secret())\""
  );
}
const MERCHANT_KEYPAIR = Keypair.fromSecret(MERCHANT_SECRET);
const RECIPIENT = process.env.RECIPIENT_ADDRESS || MERCHANT_KEYPAIR.publicKey();
const ASSET = "USDC";
const NETWORK = "testnet";
const PRICE = "1000000"; // 0.1 USDC in stroops (7 decimals)

export function createMerchantRouter() {
  const router = express.Router();

  router.get("/api/data", (req: Request, res: Response) => {
    const paymentHeader = req.headers["x-payment-response"];

    if (!paymentHeader) {
      const challenge = createSignedChallenge({
        merchantKeypair: MERCHANT_KEYPAIR,
        httpMethod: "GET",
        endpoint: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        recipient: RECIPIENT,
        asset: ASSET,
        amount: PRICE,
        network: NETWORK,
        expirySeconds: 300,
      });

      res.status(402).json({
        error: "Payment Required",
        paymentDetails: {
          amount: PRICE,
          asset: ASSET,
          recipient: RECIPIENT,
          network: NETWORK,
        },
        challenge: {
          fields: challenge.fields,
          hash: challenge.hash,
          merchantSignature: challenge.merchantSignature,
          merchantPubkey: challenge.merchantPubkey,
        },
      });
      return;
    }

    // payment was made, return the protected resource
    res.json({
      data: "premium content unlocked via x402 payment with beaver402 protection",
      timestamp: new Date().toISOString(),
      protectedBy: "beaver402",
    });
  });

  router.post("/api/submit", (req: Request, res: Response) => {
    const paymentHeader = req.headers["x-payment-response"];

    if (!paymentHeader) {
      const challenge = createSignedChallenge({
        merchantKeypair: MERCHANT_KEYPAIR,
        httpMethod: "POST",
        endpoint: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        body: JSON.stringify(req.body),
        recipient: RECIPIENT,
        asset: ASSET,
        amount: PRICE,
        network: NETWORK,
        expirySeconds: 300,
      });

      res.status(402).json({
        error: "Payment Required",
        paymentDetails: {
          amount: PRICE,
          asset: ASSET,
          recipient: RECIPIENT,
          network: NETWORK,
        },
        challenge: {
          fields: challenge.fields,
          hash: challenge.hash,
          merchantSignature: challenge.merchantSignature,
          merchantPubkey: challenge.merchantPubkey,
        },
      });
      return;
    }

    res.json({
      result: "submission accepted",
      body: req.body,
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/api/merchant-info", (_req: Request, res: Response) => {
    res.json({
      merchantPubkey: MERCHANT_KEYPAIR.publicKey(),
      recipient: RECIPIENT,
      asset: ASSET,
      network: NETWORK,
      price: PRICE,
    });
  });

  return router;
}

export { MERCHANT_KEYPAIR, RECIPIENT, ASSET, NETWORK, PRICE };
