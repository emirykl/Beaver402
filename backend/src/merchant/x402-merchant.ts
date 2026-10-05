import type { Request, Response, NextFunction } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { createSignedChallenge } from "./challenge-signer.js";
import { authorizedTerms, bindPaymentToRequest, PaymentBindingError } from "./payment-binding.js";
import { address } from "@solana/kit";
import { isChainEnabled } from "../chains/registry.js";
import { solanaMerchant, type SolanaMerchant } from "../chains/solana/merchant.js";
import { confirmSettlement, type ExpectedTransfer } from "./settlement.js";
import type { MerchantConfig } from "./demo-endpoint.js";
import { network, rpcServer } from "../config/network.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { forLog, redact } from "../lib/public-error.js";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  EXTENSION,
  HEADERS,
  MAX_TIMEOUT_SECONDS,
  sameRequirements,
  X402_VERSION,
  type Beaver402Extension,
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
  /** Which network settled it. Defaults to the configured Stellar one. */
  network?: string;
  facilitator?: string;
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
  /** Selling on Solana as well, when the deployment has it turned on. */
  solana?: () => SolanaMerchant | null;
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

function askForPayment(
  req: Request,
  res: Response,
  merchant: MerchantConfig,
  error?: string,
  solana?: SolanaMerchant | null
): void {
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

  const accepts = [requirementsFor(merchant)];
  const extension: Beaver402Extension = { challenge };
  if (solana) {
    // One challenge per network, each over this same request. The agent
    // pays on whichever it holds funds on.
    accepts.push(solana.requirements());
    extension.challenges = {
      [network().caip2]: challenge,
      [solana.caip2]: solana.challenge(request),
    };
  }

  const required: PaymentRequired = {
    x402Version: X402_VERSION,
    error: error ?? "Payment Required",
    resource: { url: request.url, description: "Beaver402 reference resource", mimeType: "application/json" },
    accepts,
    extensions: { [EXTENSION]: extension },
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
    const solana = deps.solana?.() ?? null;
    const ask = (error?: string) => askForPayment(req, res, merchant, error, solana);
    const header = req.get(HEADERS.signature);
    if (!header) {
      ask();
      return;
    }

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      res.status(400).json({ error: "PAYMENT-SIGNATURE is not an x402 payment" });
      return;
    }

    if (solana && payload.accepted?.network === solana.caip2) {
      await solanaPayment(req, res, next, deps, payload, solana, ask);
      return;
    }

    const requirements = requirementsFor(merchant);
    if (payload.x402Version !== X402_VERSION || !payload.accepted || !sameRequirements(payload.accepted, requirements)) {
      ask("the payment does not match what this resource costs");
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
      ask(reason);
      return;
    }

    const facilitator = deps.facilitator();
    let settlement: SettleResponse;
    try {
      const verdict = await facilitator.verify(payload, requirements);
      if (!verdict.isValid) {
        ask(`the facilitator refused the payment: ${verdict.invalidReason ?? "invalid"}`);
        return;
      }
      settlement = await facilitator.settle(payload, requirements);
    } catch (err) {
      console.error("facilitator call failed:", forLog(err));
      res.status(502).json({ error: `the facilitator could not be reached: ${redact(err instanceof Error ? err.message : String(err))}` });
      return;
    }

    if (!settlement.success) {
      res.setHeader(HEADERS.response, encodePaymentResponseHeader(settlement));
      ask(`settlement failed: ${settlement.errorReason ?? "unknown"}`);
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
      console.error("settlement confirmation failed:", forLog(err));
      res.status(502).json({ error: `the settlement could not be confirmed: ${redact(err instanceof Error ? err.message : String(err))}` });
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

/**
 * A payment on Solana. The merchant reads it, binds it to this request,
 * settles it itself as the fee payer and confirms it on the ledger. The
 * proof of intent is part of the payment there, so the receipt points at
 * the payment's own transaction.
 */
async function solanaPayment(
  req: Request,
  res: Response,
  next: NextFunction,
  deps: MerchantDeps,
  payload: PaymentPayload,
  solana: SolanaMerchant,
  ask: (error?: string) => void
): Promise<void> {
  const requirements = solana.requirements();
  if (payload.x402Version !== X402_VERSION || !payload.accepted || !sameRequirements(payload.accepted, requirements)) {
    ask("the payment does not match what this resource costs");
    return;
  }

  let settled: Awaited<ReturnType<SolanaMerchant["settle"]>>;
  try {
    settled = await solana.settle(payload, observed(req));
  } catch (err) {
    if (err instanceof PaymentBindingError) {
      ask(err.message);
      return;
    }
    console.error("solana settlement failed:", forLog(err));
    res.status(502).json({ error: `the payment could not be settled: ${redact(err instanceof Error ? err.message : String(err))}` });
    return;
  }

  const { settlement, terms, challengeHash } = settled;
  const fresh = await deps.record({
    network: solana.caip2,
    facilitator: "merchant",
    txHash: settlement.transaction,
    nonce: terms.nonce,
    challengeHash,
    payer: terms.payer,
    recipient: terms.recipient,
    asset: terms.asset,
    amount: terms.amount,
  });
  if (!fresh) {
    res.status(409).json({ error: "this payment has already been used" });
    return;
  }

  const receipt: Beaver402Receipt = { challengeHash, nonce: terms.nonce, proofTransaction: settlement.transaction };
  res.setHeader(
    HEADERS.response,
    encodePaymentResponseHeader({ ...settlement, extensions: { ...settlement.extensions, [EXTENSION]: receipt } })
  );
  next();
}

// ── The real dependencies ─────────────────────────────────────────

let facilitator: Facilitator | null = null;

/**
 * The facilitator this merchant settles through.
 *
 * Normally the hosted one. On testnet, and only there, FACILITATOR_MODE=
 * reference runs the x402 reference implementation of the exact scheme in
 * this process instead, with a testnet account of its own paying the fees.
 * That is a test tool for rehearsing the whole flow before the hosted
 * facilitator's key is available; it is refused on mainnet, where Beaver402
 * never operates a facilitator.
 */
export function hostedFacilitator(): Facilitator {
  if (facilitator) return facilitator;

  if (process.env.FACILITATOR_MODE === "reference") {
    facilitator = referenceFacilitator();
    return facilitator;
  }

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

function referenceFacilitator(): Facilitator {
  if (network().name !== "testnet") {
    throw new Error("the reference facilitator is a testnet tool and is refused on mainnet");
  }
  const secret = process.env.FACILITATOR_SIGNER_SECRET;
  if (!secret) {
    throw new Error("FACILITATOR_MODE=reference needs FACILITATOR_SIGNER_SECRET, a funded testnet account");
  }

  let scheme: Promise<Facilitator> | null = null;
  const load = () =>
    (scheme ??= Promise.all([import("@x402/stellar/exact/facilitator"), import("@x402/stellar")]).then(
      ([{ ExactStellarScheme }, { createEd25519Signer }]) => {
        const signer = createEd25519Signer(secret, network().caip2);
        return new ExactStellarScheme([signer], { rpcConfig: { url: network().rpcUrl } }) as unknown as Facilitator;
      }
    ));

  return {
    async verify(payload, requirements) {
      return (await load()).verify(payload, requirements);
    },
    async settle(payload, requirements) {
      return (await load()).settle(payload, requirements);
    },
  };
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
    network: payment.network ?? network().passphrase,
    payer: payment.payer,
    recipient: payment.recipient,
    asset: payment.asset,
    amount: payment.amount,
    facilitator: payment.facilitator ?? network().facilitatorUrl,
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
      console.error("could not publish the proof of intent:", forLog(err));
      return undefined;
    }
  };
}

let solanaSide: SolanaMerchant | null | undefined;

/** The Solana side of the demo merchant, when BEAVER_CHAINS turns it on. */
export function liveSolanaMerchant(merchant: () => MerchantConfig): SolanaMerchant | null {
  if (solanaSide !== undefined) return solanaSide;
  if (!isChainEnabled("solana")) {
    solanaSide = null;
    return solanaSide;
  }
  const recipient = process.env.SOLANA_RECIPIENT_ADDRESS;
  solanaSide = solanaMerchant({
    keypair: merchant().keypair,
    recipient: recipient ? address(recipient) : undefined,
  });
  return solanaSide;
}

export function liveMerchantDeps(merchant: () => MerchantConfig): MerchantDeps {
  return {
    merchant,
    facilitator: hostedFacilitator,
    confirm: (txHash, expected) => confirmSettlement(txHash, expected),
    record: recordSettlement,
    publishProof: proofPublisher(() => merchant().keypair),
    solana: () => liveSolanaMerchant(merchant),
  };
}
