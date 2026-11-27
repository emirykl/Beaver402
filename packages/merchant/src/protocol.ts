/**
 * The x402 v2 messages as a Beaver402 merchant uses them. The payment is a
 * standard `exact` USDC payment on Stellar; Beaver402 adds a challenge,
 * signed over the exact request, in `extensions.beaver402` of the 402 answer
 * and a receipt in the same place of the settlement response.
 */
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";

import type { SignedChallenge } from "./encoding.js";

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

export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

export const EXTENSION = "beaver402";

/** Seconds the payer has to get the payment settled. */
export const MAX_TIMEOUT_SECONDS = 60;

export interface Beaver402Extension {
  challenge: SignedChallenge;
}

/** What Beaver402 adds to the settlement response. */
export interface Beaver402Receipt {
  challengeHash: string;
  nonce: string;
  /** The proof of intent transaction, when it was published. */
  proofTransaction?: string;
}

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
