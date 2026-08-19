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
// The asset is the token contract the payment settles through, and the
// network is the passphrase whose hash the contract compares against the
// network id the ledger reports. Both are covered by the challenge signature.
const ASSET =
  process.env.USDC_ISSUER || "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NETWORK = process.env.NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
const PRICE = "1000000"; // 0.1 USDC in stroops (7 decimals)

/** Has the caller already paid for this? */
function wasPaid(req: Request): boolean {
  return Boolean(req.headers["x-payment-response"]);
}

/**
 * Answer with the price and a challenge signed over this exact request.
 *
 * The endpoint is read back off the request rather than written down, so what
 * the merchant signs is what the merchant was asked for.
 */
function askForPayment(
  req: Request,
  res: Response,
  httpMethod: string,
  body?: string
): void {
  const challenge = createSignedChallenge({
    merchantKeypair: MERCHANT_KEYPAIR,
    httpMethod,
    endpoint: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    body,
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
}

export function createMerchantRouter() {
  const router = express.Router();

  router.get("/api/data", (req: Request, res: Response) => {
    if (!wasPaid(req)) {
      askForPayment(req, res, "GET");
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
    if (!wasPaid(req)) {
      askForPayment(req, res, "POST", JSON.stringify(req.body));
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
