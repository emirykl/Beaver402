import express, { type Request, type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createSignedChallenge,
  verifyMerchantSignature,
} from "./challenge-signer.js";
import { network } from "../config/network.js";

/** 0.1 USDC in stroops (7 decimals). */
const PRICE = "1000000";

/** How long a challenge stays payable. The contract allows at most 900. */
const CHALLENGE_SECONDS = 300;

export interface MerchantConfig {
  keypair: Keypair;
  /** Where payments land. A classic account with a USDC trustline. */
  recipient: string;
  /** The token contract the payment settles through. */
  asset: string;
  /** The network passphrase, covered by the challenge signature. */
  network: string;
  price: string;
}

let cached: MerchantConfig | null = null;

/**
 * Who the merchant is. Read when first needed rather than at import, so a
 * backend that does not run the merchant never needs its secret.
 */
export function merchantConfig(): MerchantConfig {
  if (cached) return cached;

  const secret = process.env.MERCHANT_SECRET;
  if (!secret) {
    throw new Error(
      "MERCHANT_SECRET environment variable is required. Generate one with: node -e \"console.log(require('@stellar/stellar-sdk').Keypair.random().secret())\""
    );
  }
  const keypair = Keypair.fromSecret(secret);
  const config = network();

  // On testnet the merchant's own account doubles as the recipient. On
  // mainnet where the money goes is said explicitly.
  const recipient = process.env.RECIPIENT_ADDRESS || (config.name === "testnet" ? keypair.publicKey() : "");
  if (!recipient) {
    throw new Error("RECIPIENT_ADDRESS is required on mainnet");
  }

  cached = {
    keypair,
    recipient,
    asset: config.usdcContract,
    network: config.passphrase,
    price: PRICE,
  };
  return cached;
}

export function resetMerchantConfig(): void {
  cached = null;
}

/** Has the caller already paid for this? */
function wasPaid(req: Request): boolean {
  return Boolean(req.headers["x-payment-response"]);
}

/**
 * Answer with the price and a challenge signed over this exact request.
 *
 * The endpoint is read back off the request rather than written down, so what
 * the merchant signs is what the merchant was asked for. Behind a proxy the
 * scheme comes from the proxy, which is why the app trusts it on a host that
 * terminates TLS in front of it.
 */
function askForPayment(
  req: Request,
  res: Response,
  httpMethod: string,
  body?: string
): void {
  const merchant = merchantConfig();
  const challenge = createSignedChallenge({
    merchantKeypair: merchant.keypair,
    httpMethod,
    endpoint: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    body,
    recipient: merchant.recipient,
    asset: merchant.asset,
    amount: merchant.price,
    network: merchant.network,
    expirySeconds: CHALLENGE_SECONDS,
  });

  res.status(402).json({
    error: "Payment Required",
    paymentDetails: {
      amount: merchant.price,
      asset: merchant.asset,
      recipient: merchant.recipient,
      network: merchant.network,
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
    const merchant = merchantConfig();
    res.json({
      merchantPubkey: merchant.keypair.publicKey(),
      recipient: merchant.recipient,
      asset: merchant.asset,
      network: merchant.network,
      price: merchant.price,
    });
  });

  return router;
}

export { verifyMerchantSignature };
