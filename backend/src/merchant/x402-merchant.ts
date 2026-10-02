import type { Request, Response, NextFunction } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { createSignedChallenge } from "./challenge-signer.js";
import { authorizedTerms, bindPaymentToRequest, PaymentBindingError } from "./payment-binding.js";
import { confirmSettlement, type ExpectedTransfer } from "./settlement.js";
import type { MerchantConfig } from "./demo-endpoint.js";
import { network, rpcServer } from "../config/network.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  EXTENSION,
  HEADERS,
  MAX_TIMEOUT_SECONDS,
  sameRequirements,
  X402_VERSION,
  type Beaver402Receipt,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
} from "../x402/protocol.js";

/** How long a challenge stays payable. The contract allows at most 900. */
const CHALLENGE_SECONDS = 300;

/** The two calls an x402 facilitator answers for the merchant. */
export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; invalidMessage?: string }>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export interface SettledPayment {
  txHash: string;
  nonce: string;
  challengeHash: string;
  payer: string;
  recipient: string;
  asset: string;
  amount: string;
}

/** Everything the merchant relies on, so each part can be replaced in tests. */
export interface MerchantDeps {
  merchant: () => MerchantConfig;
  facilitator: () => Facilitator;
  confirm: (txHash: string, expected: ExpectedTransfer) => Promise<void>;
  /** Returns false when this payment was already recorded. */
  record: (payment: SettledPayment) => Promise<boolean>;
  /** Publishes the proof of intent and returns its transaction, if it went out. */
  publishProof: (policyAccount: string, nonce: string) => Promise<string | undefined>;
}

/** The standard x402 requirements for this merchant's price. */
export function requirementsFor(merchant: MerchantConfig): PaymentRequirements {
  return {
    scheme: "exact",
    network: network().caip2,
    asset: merchant.asset,
    amount: merchant.price,
    payTo: merchant.recipient,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { areFeesSponsored: true },
  };
}

/** The request as the merchant sees it, which is what it signs. */
function observed(req: Request): { method: string; url: string; body: string | null } {
  return {
    method: req.method,
    url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    body: (req as Request & { rawBody?: string }).rawBody || null,
  };
}

function askForPayment(req: Request, res: Response, merchant: MerchantConfig, error?: string): void {
  const request = observed(req);
  const challenge = createSignedChallenge({
    merchantKeypair: merchant.keypair,
    httpMethod: request.method,
    endpoint: request.url,
    body: request.body,
    recipient: merchant.recipient,
    asset: merchant.asset,
    amount: merchant.price,
    network: merchant.network,
    expirySeconds: CHALLENGE_SECONDS,
  });

  const required: PaymentRequired = {
    x402Version: X402_VERSION,
    error: error ?? "Payment Required",
    resource: { url: request.url, description: "Beaver402 reference resource", mimeType: "application/json" },
    accepts: [requirementsFor(merchant)],
    extensions: { [EXTENSION]: { challenge } },
  };

  res.setHeader(HEADERS.required, encodePaymentRequiredHeader(required));
  res.status(402).json(required);
}

/**
 * Put a resource behind an x402 v2 payment with Beaver402 protection.
 *
 * Without a payment the answer is 402, carrying the standard requirements
 * and a challenge signed over this exact request. With one, the resource is
 * released only after all of the following.
 *
 * 1. The payment is for exactly these requirements.
 * 2. Its authorization answers a challenge this merchant signed for this
 *    very request, which the merchant checks against its own key.
 * 3. The facilitator verifies it and settles it.
 * 4. The ledger itself shows that settlement moving the agreed amount of the
 *    agreed token from the payer to the merchant.
 * 5. The settlement had not already unlocked something.
 *
 * Then the proof of intent is published, and the settlement receipt goes
 * back in PAYMENT-RESPONSE.
 */
export function requirePayment(deps: MerchantDeps) {
  return async function payment(req: Request, res: Response, next: NextFunction): Promise<void> {
    const merchant = deps.merchant();
    const header = req.get(HEADERS.signature);
    if (!header) {
      askForPayment(req, res, merchant);
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      res.status(400).json({ error: "PAYMENT-SIGNATURE is not an x402 payment" });
      return;
    }

    const requirements = requirementsFor(merchant);
    if (payload.x402Version !== X402_VERSION || !payload.accepted || !sameRequirements(payload.accepted, requirements)) {
      askForPayment(req, res, merchant, "the payment does not match what this resource costs");
      return;
    }

    let challengeHash: string;
    let terms: ReturnType<typeof authorizedTerms>;
    try {
      terms = authorizedTerms(String(payload.payload?.transaction ?? ""), network().passphrase);
      ({ challengeHash } = bindPaymentToRequest(terms, observed(req), {
        keypair: merchant.keypair,
        recipient: merchant.recipient,
        asset: merchant.asset,
        amount: merchant.price,
        network: merchant.network,
      }));
    } catch (err) {
      const reason = err instanceof PaymentBindingError ? err.message : "the payment could not be read";
      askForPayment(req, res, merchant, reason);
      return;
    }

    const facilitator = deps.facilitator();
    let settlement: SettleResponse;
    try {
      const verdict = await facilitator.verify(payload, requirements);
      if (!verdict.isValid) {
        askForPayment(req, res, merchant, `the facilitator refused the payment: ${verdict.invalidReason ?? "invalid"}`);
        return;
      }
      settlement = await facilitator.settle(payload, requirements);
    } catch (err) {
      res.status(502).json({ error: `the facilitator could not be reached: ${err instanceof Error ? err.message : err}` });
      return;
    }

    if (!settlement.success) {
      res.setHeader(HEADERS.response, encodePaymentResponseHeader(settlement));
      askForPayment(req, res, merchant, `settlement failed: ${settlement.errorReason ?? "unknown"}`);
      return;
    }

    try {
      await deps.confirm(settlement.transaction, {
        asset: merchant.asset,
        from: terms.payer,
        to: merchant.recipient,
        amount: merchant.price,
      });
    } catch (err) {
      res.status(502).json({ error: `the settlement could not be confirmed: ${err instanceof Error ? err.message : err}` });
      return;
    }

    const fresh = await deps.record({
      txHash: settlement.transaction,
      nonce: terms.nonce,
      challengeHash,
      payer: terms.payer,
      recipient: merchant.recipient,
      asset: merchant.asset,
      amount: merchant.price,
    });
    if (!fresh) {
      res.status(409).json({ error: "this payment has already been used" });
      return;
    }

    const proofTransaction = await deps.publishProof(terms.payer, terms.nonce);

    const receipt: Beaver402Receipt = { challengeHash, nonce: terms.nonce, proofTransaction };
    res.setHeader(
      HEADERS.response,
      encodePaymentResponseHeader({ ...settlement, extensions: { ...settlement.extensions, [EXTENSION]: receipt } })
    );
    next();
  };
}

// ── The real dependencies ─────────────────────────────────────────

let facilitator: Facilitator | null = null;

/**
 * The hosted facilitator, authenticated with the project's API key. It is
 * asked once whether it supports the exact scheme on this network.
 */
export function hostedFacilitator(): Facilitator {
  if (facilitator) return facilitator;

  const key = process.env.FACILITATOR_API_KEY;
  if (!key && network().name === "mainnet") {
    throw new Error("FACILITATOR_API_KEY is required on mainnet");
  }
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const client = new HTTPFacilitatorClient({
    url: network().facilitatorUrl,
    createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
  });

  let supported: Promise<void> | null = null;
  const ensureSupported = () => {
    supported ??= client.getSupported().then((answer) => {
      const kind = answer.kinds.find(
        (k) => k.x402Version === X402_VERSION && k.scheme === "exact" && k.network === network().caip2
      );
      if (!kind) {
        throw new Error(`${network().facilitatorUrl} does not support exact payments on ${network().caip2}`);
      }
    });
    supported.catch(() => {
      supported = null;
    });
    return supported;
  };

  facilitator = {
    async verify(payload, requirements) {
      await ensureSupported();
      return client.verify(payload, requirements);
    },
    async settle(payload, requirements) {
      await ensureSupported();
      return client.settle(payload, requirements);
    },
  };
  return facilitator;
}

const recordedInMemory = new Set<string>();

/** Record a settlement once. The hash and the nonce are both unique. */
export async function recordSettlement(payment: SettledPayment): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    const keys = [`tx:${payment.txHash}`, `nonce:${payment.nonce}`];
    if (keys.some((key) => recordedInMemory.has(key))) return false;
    keys.forEach((key) => recordedInMemory.add(key));
    return true;
  }

  const { error } = await getSupabase().from("settled_payments").insert({
    tx_hash: payment.txHash,
    nonce: payment.nonce,
    challenge_hash: payment.challengeHash,
    network: network().passphrase,
    payer: payment.payer,
    recipient: payment.recipient,
    asset: payment.asset,
    amount: payment.amount,
    facilitator: network().facilitatorUrl,
  });
  if (!error) return true;
  // A unique violation means this payment was seen before.
  if (error.code === "23505") return false;
  throw new Error(`failed to record the settlement: ${error.message}`);
}

/**
 * Announce the payment's proof of intent from the policy account.
 *
 * The merchant pays this transaction's fee. A failure here does not take
 * the resource back: the payment has settled. It is logged, and the proof
 * can still be published by anyone while the account remembers the payment.
 */
export function proofPublisher(merchantKeypair: () => StellarSdk.Keypair) {
  return async function publishProof(policyAccount: string, nonce: string): Promise<string | undefined> {
    try {
      const server = rpcServer();
      const source = merchantKeypair();
      const account = await server.getAccount(source.publicKey());
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "1000000",
        networkPassphrase: network().passphrase,
      })
        .addOperation(
          StellarSdk.Operation.invokeContractFunction({
            contract: policyAccount,
            function: "publish_proof",
            args: [StellarSdk.xdr.ScVal.scvBytes(Buffer.from(nonce, "hex"))],
          })
        )
        .setTimeout(60)
        .build();

      const prepared = await server.prepareTransaction(tx);
      prepared.sign(source);
      const sent = await server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        throw new Error(JSON.stringify(sent.errorResult));
      }

      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await server.getTransaction(sent.hash);
        if (result.status === "SUCCESS") return sent.hash;
        if (result.status === "FAILED") throw new Error(`publish_proof ${sent.hash} failed`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`publish_proof ${sent.hash} was not confirmed`);
    } catch (err) {
      console.error("could not publish the proof of intent:", err);
      return undefined;
    }
  };
}

export function liveMerchantDeps(merchant: () => MerchantConfig): MerchantDeps {
  return {
    merchant,
    facilitator: hostedFacilitator,
    confirm: (txHash, expected) => confirmSettlement(txHash, expected),
    record: recordSettlement,
    publishProof: proofPublisher(() => merchant().keypair),
  };
}
