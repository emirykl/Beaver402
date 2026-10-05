import type { Address } from "@solana/kit";
import type { Keypair } from "@stellar/stellar-sdk";

import { createSignedChallenge } from "../../merchant/challenge-signer.js";
import { bindPaymentToRequest, PaymentBindingError, type AuthorizedTerms } from "../../merchant/payment-binding.js";
import type { SignedChallenge } from "../../shared/types.js";
import {
  MAX_TIMEOUT_SECONDS,
  SOLANA_SCHEME,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from "../../x402/protocol.js";
import { solana, type SolanaConfig } from "./config.js";
import { solanaAddressOf, solanaKeyPair } from "./program.js";
import { readSolanaPayment, settleSolanaPayment } from "./settlement.js";

/** 0.1 USDC with six decimals, the same price as on Stellar. */
export const SOLANA_PRICE = "100000";

/** How long a challenge stays payable. The program allows at most 900. */
const CHALLENGE_SECONDS = 300;

export interface ObservedRequest {
  method: string;
  url: string;
  body: string | null;
}

export interface SolanaSettled {
  settlement: SettleResponse;
  terms: AuthorizedTerms;
  challengeHash: string;
}

/** The merchant's Solana side, replaceable in tests. */
export interface SolanaMerchant {
  caip2: string;
  requirements(): PaymentRequirements;
  challenge(request: ObservedRequest): SignedChallenge;
  /** Refusals are PaymentBindingError; anything else is a failure to settle. */
  settle(payload: PaymentPayload, request: ObservedRequest): Promise<SolanaSettled>;
}

export interface SolanaMerchantConfig {
  /** The merchant's ed25519 key, the same one that signs on Stellar. */
  keypair: Keypair;
  /** Where payments land. Defaults to the merchant's own address on devnet. */
  recipient?: Address;
  price?: string;
}

/**
 * Selling on Solana.
 *
 * The merchant signs the same kind of challenge, with the Solana settlement
 * terms, and settles the payment itself: it is the fee payer, so it checks
 * the transaction is exactly a Beaver402 payment for this request before
 * signing anything, then confirms on the ledger that the agreed transfer
 * happened.
 */
export function solanaMerchant(
  merchant: SolanaMerchantConfig,
  config: SolanaConfig = solana()
): SolanaMerchant {
  const merchantAddress = solanaAddressOf(merchant.keypair.publicKey());
  const recipient = merchant.recipient ?? merchantAddress;
  const price = merchant.price ?? SOLANA_PRICE;
  let feeKeys: Promise<CryptoKeyPair> | null = null;
  const feePayer = () => (feeKeys ??= solanaKeyPair(merchant.keypair.secret()).then((k) => k.keyPair));

  const terms = {
    keypair: merchant.keypair,
    merchantPubkey: merchantAddress,
    recipient,
    asset: config.usdcMint,
    amount: price,
    network: config.caip2,
  };

  return {
    caip2: config.caip2,

    requirements() {
      return {
        scheme: SOLANA_SCHEME,
        network: config.caip2,
        asset: config.usdcMint,
        amount: price,
        payTo: recipient,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: { feePayer: merchantAddress, decimals: config.usdcDecimals, programId: config.programId },
      } as PaymentRequirements;
    },

    challenge(request) {
      return createSignedChallenge({
        merchantKeypair: merchant.keypair,
        merchantPubkey: merchantAddress,
        httpMethod: request.method,
        endpoint: request.url,
        body: request.body,
        recipient,
        asset: config.usdcMint,
        amount: price,
        network: config.caip2,
        expirySeconds: CHALLENGE_SECONDS,
      });
    },

    async settle(payload, request) {
      const wire = payload.payload?.transaction;
      if (typeof wire !== "string") {
        throw new PaymentBindingError("the payment carries no transaction");
      }
      const payment = await readSolanaPayment(wire, { feePayer: merchantAddress, recipient }, config);
      const { challengeHash } = bindPaymentToRequest(payment.terms, request, terms);
      const signature = await settleSolanaPayment(payment, await feePayer(), config);
      return {
        settlement: {
          success: true,
          transaction: signature,
          network: config.caip2,
          payer: payment.terms.payer,
        } as SettleResponse,
        terms: payment.terms,
        challengeHash,
      };
    },
  };
}
