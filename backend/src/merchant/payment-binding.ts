import * as StellarSdk from "@stellar/stellar-sdk";

import {
  ENCODING_VERSION,
  hashBody,
  hashChallenge,
  normalizeAmount,
  requestDigest,
} from "../shared/hashing.js";
import type { ChallengeFields } from "../shared/types.js";

/**
 * What the policy account's authorization entry says it agreed to.
 *
 * The payer's signature value carries the merchant's own signature and the
 * fields it covers, so the merchant can read back exactly which challenge a
 * payment answers without having kept any record of the challenges it gave
 * out.
 */
export interface AuthorizedTerms {
  payer: string;
  merchantPubkey: Buffer;
  merchantSignature: Buffer;
  requestDigest: Buffer;
  recipient: string;
  asset: string;
  amount: string;
  nonce: string;
  expiry: string;
}

export class PaymentBindingError extends Error {}

/** Read the terms out of an x402 exact payment transaction. */
export function authorizedTerms(transactionXdr: string, passphrase: string): AuthorizedTerms {
  let transaction: StellarSdk.Transaction;
  try {
    transaction = new StellarSdk.Transaction(transactionXdr, passphrase);
  } catch {
    throw new PaymentBindingError("the payment is not a transaction for this network");
  }

  const [operation] = transaction.operations;
  if (transaction.operations.length !== 1 || operation?.type !== "invokeHostFunction") {
    throw new PaymentBindingError("the payment is not a single contract call");
  }
  const auth = operation.auth ?? [];
  if (auth.length !== 1) {
    throw new PaymentBindingError(`the payment carries ${auth.length} authorizations, expected one`);
  }

  const credentials = auth[0]!.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    throw new PaymentBindingError("the payment is not authorized by an account");
  }
  const address = credentials.address();
  const payer = StellarSdk.Address.fromScAddress(address.address()).toString();

  const signature = StellarSdk.scValToNative(address.signature());
  if (!Array.isArray(signature) || signature[0] !== "Agent" || typeof signature[1] !== "object") {
    throw new PaymentBindingError("the payment was not authorized through the Beaver402 agent path");
  }
  const agent = signature[1] as Record<string, unknown>;

  return {
    payer,
    merchantPubkey: Buffer.from(agent.merchant_pubkey as Uint8Array),
    merchantSignature: Buffer.from(agent.merchant_signature as Uint8Array),
    requestDigest: Buffer.from(agent.request_digest as Uint8Array),
    recipient: String(agent.recipient),
    asset: String(agent.asset),
    amount: String(agent.amount),
    nonce: Buffer.from(agent.nonce as Uint8Array).toString("hex"),
    expiry: String(agent.expiry),
  };
}

export interface ObservedRequest {
  method: string;
  url: string;
  body?: string | null;
}

export interface MerchantTerms {
  keypair: StellarSdk.Keypair;
  recipient: string;
  asset: string;
  amount: string;
  network: string;
}

/**
 * Confirm a payment answers a challenge this merchant signed for this very
 * request.
 *
 * The merchant rebuilds the challenge from the request in front of it and
 * the terms it charges, and checks its own signature over the result. A
 * payment authorized for another endpoint, another body, another price or
 * another merchant fails here, before the facilitator is asked to settle it.
 */
export function bindPaymentToRequest(
  terms: AuthorizedTerms,
  request: ObservedRequest,
  merchant: MerchantTerms,
  now: number = Math.floor(Date.now() / 1000)
): { challengeHash: string } {
  const ownKey = Buffer.from(StellarSdk.StrKey.decodeEd25519PublicKey(merchant.keypair.publicKey()));
  if (!terms.merchantPubkey.equals(ownKey)) {
    throw new PaymentBindingError("the payment answers another merchant's challenge");
  }
  if (terms.recipient !== merchant.recipient) {
    throw new PaymentBindingError("the payment goes to another recipient");
  }
  if (terms.asset !== merchant.asset) {
    throw new PaymentBindingError("the payment is in another token");
  }
  if (normalizeAmount(terms.amount) !== normalizeAmount(merchant.amount)) {
    throw new PaymentBindingError("the payment is for another amount");
  }
  const expiry = Number(terms.expiry);
  if (!expiry || now > expiry) {
    throw new PaymentBindingError("the challenge this payment answers has expired");
  }

  const fields: ChallengeFields = {
    version: ENCODING_VERSION,
    merchantPubkey: merchant.keypair.publicKey(),
    httpMethod: request.method,
    normalizedEndpoint: request.url,
    bodyHash: hashBody(request.body ?? null),
    recipient: merchant.recipient,
    asset: merchant.asset,
    amount: merchant.amount,
    network: merchant.network,
    nonce: terms.nonce,
    expiry: terms.expiry,
  };

  if (!requestDigest(fields).equals(terms.requestDigest)) {
    throw new PaymentBindingError("the payment was authorized for a different request");
  }

  const hash = hashChallenge(fields);
  if (!merchant.keypair.verify(hash, terms.merchantSignature)) {
    throw new PaymentBindingError("the payment does not carry this merchant's signature");
  }

  return { challengeHash: hash.toString("hex") };
}
