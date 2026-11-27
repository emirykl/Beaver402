import * as StellarSdk from "@stellar/stellar-sdk";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import { createSignedChallenge } from "./challenge.js";
import { authorizedTerms, bindPaymentToRequest, PaymentRefused, type AuthorizedTerms, type ObservedRequest } from "./binding.js";
import { checkPrice, MerchantConfigError, resolveConfig, type MerchantOptions, type ResolvedConfig } from "./config.js";
import { httpFacilitator, type Facilitator } from "./facilitator.js";
import { confirmSettlement, isMerchantApproved, NotAPolicyAccount, publishProof, type Rpc } from "./ledger.js";
import { passed, preflight, type CheckResult } from "./preflight.js";
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
} from "./protocol.js";
import type { SettledPayment } from "./store.js";

/** Replaceable parts, for tests. */
export interface MerchantDeps {
  rpc?: Rpc;
  facilitator?: Facilitator;
  /** Skip the network checks before the first challenge. Tests only. */
  skipPreflight?: boolean;
  /** How long to wait for the ledger to show a settlement. */
  confirmation?: { attempts?: number; delayMs?: number };
}

export interface RouteOptions {
  /** This route's price, in integer USDC units. The merchant's price otherwise. */
  price?: string;
  description?: string;
}

/** Put on res.locals.beaver402 once a payment has unlocked the request. */
export interface PaymentContext {
  payment: SettledPayment;
  receipt: Beaver402Receipt;
}

export interface Merchant {
  /** Express middleware that lets a request through only once it is paid. */
  protect(route?: RouteOptions): RequestHandler;
  /** Run the network checks now, and report each of them. */
  check(): Promise<CheckResult[]>;
  /** Publish the proof of intent for a payment whose first attempt failed. */
  publishProof(policyAccount: string, nonce: string): Promise<string>;
  /** Recorded payments whose proof of intent is still missing. */
  pendingProofs(): Promise<SettledPayment[]>;
  /** Publish every recorded proof that is still missing. */
  publishPendingProofs(): Promise<{ nonce: string; proofTransaction?: string; error?: string }[]>;
  /** The public facts about this merchant, as an owner needs them to approve it. */
  info(): MerchantInfo;
}

export interface MerchantInfo {
  network: string;
  caip2: string;
  /** The key the owner approves with add_merchant. */
  merchantPubkey: string;
  /** The same key as 32 bytes of hex, the form add_merchant takes. */
  merchantKeyHex: string;
  recipient: string;
  asset: string;
  price: string;
}

/** Keep the raw body for express.json({ verify: captureRawBody }). The challenge signs it. */
export function captureRawBody(req: unknown, _res: unknown, buf: Buffer): void {
  (req as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
}

function hasBody(req: Request): boolean {
  const length = Number(req.get("content-length") ?? 0);
  return length > 0 || req.get("transfer-encoding") !== undefined;
}

export function createMerchant(options: MerchantOptions, deps: MerchantDeps = {}): Merchant {
  const config = resolveConfig(options);
  const rpc: Rpc = deps.rpc ?? new StellarSdk.rpc.Server(config.rpcUrl);
  const facilitator = deps.facilitator ?? httpFacilitator(config.facilitatorUrl, config.facilitatorApiKey);
  const log = config.logger;
  const passphrase = config.constants.passphrase;

  let ready: Promise<void> | null = deps.skipPreflight ? Promise.resolve() : null;
  const ensureReady = () => {
    ready ??= preflight(config, rpc, facilitator).then((results) => {
      for (const r of results.filter((r) => !r.ok)) {
        (r.severity === "error" ? log.error : log.warn)(`beaver402 ${r.name}: ${r.detail}`);
      }
      if (!passed(results)) {
        throw new MerchantConfigError(results.filter((r) => !r.ok && r.severity === "error").map((r) => r.detail).join("; "));
      }
    });
    // A failed check is retried on the next request rather than remembered.
    ready.catch(() => {
      ready = null;
    });
    return ready;
  };

  const observed = (req: Request): ObservedRequest => {
    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody;
    if (rawBody === undefined && hasBody(req)) {
      throw new MerchantConfigError(
        "the request has a body but its raw bytes were not kept. Mount express.json({ verify: captureRawBody }) (or express.raw / express.text with the same verify) before protect()"
      );
    }
    const url = config.publicUrl ? `${config.publicUrl}${req.originalUrl}` : `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    return { method: req.method, url, body: rawBody && rawBody.length > 0 ? rawBody : null };
  };

  const requirementsFor = (price: string): PaymentRequirements => ({
    scheme: "exact",
    network: config.constants.caip2,
    asset: config.usdcContract,
    amount: price,
    payTo: config.recipient,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { areFeesSponsored: true },
  });

  function askForPayment(res: Response, request: ObservedRequest, price: string, description: string, error?: string): void {
    const challenge = createSignedChallenge({
      keypair: config.keypair,
      method: request.method,
      url: request.url,
      body: request.body,
      recipient: config.recipient,
      asset: config.usdcContract,
      amount: price,
      network: passphrase,
      expirySeconds: config.challengeSeconds,
    });
    const required: PaymentRequired = {
      x402Version: X402_VERSION,
      error: error ?? "Payment Required",
      resource: { url: request.url, description, mimeType: "application/json" },
      accepts: [requirementsFor(price)],
      extensions: { [EXTENSION]: { challenge } },
    };
    res.setHeader(HEADERS.required, encodePaymentRequiredHeader(required));
    res.status(402).json(required);
  }

  async function proofFor(payer: string, nonce: string): Promise<string | undefined> {
    try {
      const tx = await publishProof(rpc, passphrase, config.keypair, payer, nonce, deps.confirmation);
      await config.store.markProof(nonce, tx);
      return tx;
    } catch (err) {
      log.error(
        `beaver402: the payment settled but its proof of intent was not published (${message(err)}). ` +
          `Publish it later without paying again: beaver402-merchant publish-proof --account ${payer} --nonce ${nonce}`
      );
      return undefined;
    }
  }

  function protect(route: RouteOptions = {}): RequestHandler {
    const price = checkPrice(route.price ?? config.price, "route price");
    const description = route.description ?? config.description;
    const requirements = requirementsFor(price);

    return async function beaver402(req: Request, res: Response, next: NextFunction): Promise<void> {
      let request: ObservedRequest;
      try {
        await ensureReady();
        request = observed(req);
      } catch (err) {
        log.error(`beaver402: ${message(err)}`);
        res.status(503).json({ error: "this paid endpoint is not configured correctly; the operator has been told why" });
        return;
      }
      const ask = (error?: string) => askForPayment(res, request, price, description, error);

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
      if (payload.x402Version !== X402_VERSION || !payload.accepted || !sameRequirements(payload.accepted, requirements)) {
        ask("the payment does not match what this resource costs");
        return;
      }

      let terms: AuthorizedTerms;
      let challengeHash: string;
      try {
        terms = authorizedTerms(String(payload.payload?.transaction ?? ""), passphrase);
        ({ challengeHash } = bindPaymentToRequest(terms, request, {
          keypair: config.keypair,
          recipient: config.recipient,
          asset: config.usdcContract,
          amount: price,
          network: passphrase,
        }));
      } catch (err) {
        ask(err instanceof PaymentRefused ? err.message : "the payment could not be read");
        return;
      }

      try {
        if (await config.store.hasNonce(terms.nonce)) {
          res.status(409).json({ error: "this payment has already been used" });
          return;
        }
        if (!(await isMerchantApproved(rpc, passphrase, terms.payer, config.keypair))) {
          ask("the paying account's owner has not approved this merchant");
          return;
        }
      } catch (err) {
        if (err instanceof NotAPolicyAccount) {
          ask("the payment does not come from a Beaver402 policy account");
          return;
        }
        log.error(`beaver402: could not check the payment before settling it: ${message(err)}`);
        res.status(502).json({ error: "the payment could not be checked; try again" });
        return;
      }

      let settlement: SettleResponse;
      try {
        const verdict = await facilitator.verify(payload, requirements);
        if (!verdict.isValid) {
          ask(`the facilitator refused the payment: ${verdict.invalidReason ?? "invalid"}`);
          return;
        }
        settlement = await facilitator.settle(payload, requirements);
      } catch (err) {
        log.error(`beaver402: facilitator call failed: ${message(err)}`);
        res.status(502).json({ error: "the facilitator could not be reached; nothing was charged unless a settlement appears on the ledger" });
        return;
      }
      if (!settlement.success) {
        res.setHeader(HEADERS.response, encodePaymentResponseHeader(settlement));
        ask(`settlement failed: ${settlement.errorReason ?? "unknown"}`);
        return;
      }

      try {
        await confirmSettlement(
          rpc,
          settlement.transaction,
          { asset: config.usdcContract, from: terms.payer, to: config.recipient, amount: price },
          deps.confirmation
        );
      } catch (err) {
        log.error(`beaver402: settlement ${settlement.transaction} was not confirmed: ${message(err)}`);
        res.status(502).json({ error: "the settlement could not be confirmed on the ledger", transaction: settlement.transaction });
        return;
      }

      const payment: SettledPayment = {
        txHash: settlement.transaction,
        nonce: terms.nonce,
        challengeHash,
        payer: terms.payer,
        recipient: config.recipient,
        asset: config.usdcContract,
        amount: price,
        network: config.constants.caip2,
        method: request.method,
        url: request.url,
        settledAt: new Date().toISOString(),
      };
      let fresh: boolean;
      try {
        fresh = await config.store.record(payment);
      } catch (err) {
        log.error(`beaver402: settlement ${payment.txHash} could not be recorded: ${message(err)}`);
        res.status(500).json({ error: "the payment settled but could not be recorded", transaction: payment.txHash });
        return;
      }
      if (!fresh) {
        res.status(409).json({ error: "this payment has already been used" });
        return;
      }

      const proofTransaction = await proofFor(terms.payer, terms.nonce);
      if (proofTransaction) payment.proofTransaction = proofTransaction;
      const receipt: Beaver402Receipt = { challengeHash, nonce: terms.nonce, proofTransaction };
      res.setHeader(
        HEADERS.response,
        encodePaymentResponseHeader({ ...settlement, extensions: { ...settlement.extensions, [EXTENSION]: receipt } })
      );
      res.locals.beaver402 = { payment, receipt } satisfies PaymentContext;
      next();
    };
  }

  const publishAgain = async (policyAccount: string, nonce: string): Promise<string> => {
    const tx = await publishProof(rpc, passphrase, config.keypair, policyAccount, nonce, deps.confirmation);
    await config.store.markProof(nonce, tx);
    return tx;
  };

  return {
    protect,
    check: () => preflight(config, rpc, facilitator),
    publishProof: publishAgain,
    pendingProofs: () => config.store.pendingProofs(),
    async publishPendingProofs() {
      const out: { nonce: string; proofTransaction?: string; error?: string }[] = [];
      for (const p of await config.store.pendingProofs()) {
        try {
          out.push({ nonce: p.nonce, proofTransaction: await publishAgain(p.payer, p.nonce) });
        } catch (err) {
          out.push({ nonce: p.nonce, error: message(err) });
        }
      }
      return out;
    },
    info: () => describe(config),
  };
}

function describe(config: ResolvedConfig): MerchantInfo {
  return {
    network: config.network,
    caip2: config.constants.caip2,
    merchantPubkey: config.keypair.publicKey(),
    merchantKeyHex: config.keypair.rawPublicKey().toString("hex"),
    recipient: config.recipient,
    asset: config.usdcContract,
    price: config.price,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
