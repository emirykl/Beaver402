import express, { type Request, type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { verifyMerchantSignature } from "./challenge-signer.js";
import { liveMerchantDeps, requirePayment, type MerchantDeps } from "./x402-merchant.js";
import { network } from "../config/network.js";

/** 0.1 USDC in stroops (7 decimals). */
const PRICE = "1000000";

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

export function createMerchantRouter(deps: MerchantDeps = liveMerchantDeps(merchantConfig)) {
  const router = express.Router();
  const paid = requirePayment(deps);

  router.get("/api/data", paid, (_req: Request, res: Response) => {
    // payment was made, return the protected resource
    res.json({
      data: "premium content unlocked via x402 payment with beaver402 protection",
      timestamp: new Date().toISOString(),
      protectedBy: "beaver402",
    });
  });

  router.post("/api/submit", paid, (req: Request, res: Response) => {
    res.json({
      result: "submission accepted",
      body: req.body,
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/api/merchant-info", (_req: Request, res: Response) => {
    const merchant = deps.merchant();
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
