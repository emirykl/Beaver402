/**
 * The x402 v2 messages as Beaver402 uses them.
 *
 * The payment itself is standard: the `exact` scheme on Stellar, a single
 * token transfer whose authorization entry the payer signs, verified, fee
 * sponsored and settled by an x402 facilitator. Beaver402 adds one thing on
 * top. The merchant's 402 answer carries a challenge signed over this exact
 * request in `extensions.beaver402`, and the payer's smart account only
 * authorizes the transfer when that challenge and the payer's own
 * reconstruction of the request agree.
 */
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

import type { SignedChallenge } from "../shared/types.js";

export type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse };
export {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
};

export const X402_VERSION = 2;

/** The headers of the x402 v2 HTTP transport. */
export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

/** Where the Beaver402 challenge travels inside a PaymentRequired. */
export const EXTENSION = "beaver402";

/**
 * Seconds the payer has to get the payment settled. It also bounds how far
 * ahead the authorization entry may be valid, which the facilitator checks.
 */
export const MAX_TIMEOUT_SECONDS = 60;

export interface Beaver402Extension {
  /** The challenge for the Stellar payment, where Beaver402 started. */
  challenge: SignedChallenge;
  /**
   * One challenge per network the merchant accepts, keyed by CAIP-2. Each
   * is signed over the same request but that network's settlement terms,
   * so a payment on one network can never answer another network's.
   */
  challenges?: Record<string, SignedChallenge>;
}

/**
 * The x402 scheme for a Beaver402 payment on Solana. Not `exact`: the
 * payment is the policy program's pay instruction rather than a bare token
 * transfer, so a standard exact facilitator would refuse it, and the
 * merchant settles it itself. See docs/solana/design.md.
 */
export const SOLANA_SCHEME = "beaver402";

/** What Beaver402 adds to a settlement response. */
export interface Beaver402Receipt {
  challengeHash: string;
  intentHash?: string;
  nonce: string;
  /** The transaction that published the proof of intent, when it went out. */
  proofTransaction?: string;
}

/** The Beaver402 challenge inside a 402 answer, if the merchant sent one. */
export function challengeFrom(required: PaymentRequired): SignedChallenge | null {
  const extension = required.extensions?.[EXTENSION] as Partial<Beaver402Extension> | undefined;
  const challenge = extension?.challenge;
  if (
    !challenge ||
    typeof challenge !== "object" ||
    !challenge.fields ||
    typeof challenge.hash !== "string" ||
    typeof challenge.merchantSignature !== "string" ||
    typeof challenge.merchantPubkey !== "string"
  ) {
    return null;
  }
  return challenge as SignedChallenge;
}

function isSignedChallenge(value: unknown): value is SignedChallenge {
  const c = value as Partial<SignedChallenge> | undefined;
  return (
    !!c &&
    typeof c === "object" &&
    !!c.fields &&
    typeof c.hash === "string" &&
    typeof c.merchantSignature === "string" &&
    typeof c.merchantPubkey === "string"
  );
}

/** The challenge the merchant signed for one network, if it sent one. */
export function challengeFor(required: PaymentRequired, caip2: string): SignedChallenge | null {
  const extension = required.extensions?.[EXTENSION] as Partial<Beaver402Extension> | undefined;
  const keyed = extension?.challenges?.[caip2];
  return isSignedChallenge(keyed) ? keyed : null;
}

/** Whether two sets of requirements ask for the same payment. */
export function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.amount === b.amount &&
    a.payTo === b.payTo &&
    a.maxTimeoutSeconds === b.maxTimeoutSeconds
  );
}
