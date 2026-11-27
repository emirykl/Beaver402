import * as StellarSdk from "@stellar/stellar-sdk";

import { ENCODING_VERSION, hashBody, hashChallenge, normalizeAmount, requestDigest, type ChallengeFields } from "./encoding.js";

/**
 * What the payer's authorization entry says it agreed to. The Beaver402
 * agent signature carries the merchant's own signature and the fields it
 * covers, so the merchant can read back which challenge a payment answers
 * without having stored the challenges it handed out.
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

/** A payment that does not answer this merchant's challenge for this request. */
export class PaymentRefused extends Error {
  override name = "PaymentRefused";
}

/** Read the terms out of an x402 exact payment transaction. */
export function authorizedTerms(transactionXdr: string, passphrase: string): AuthorizedTerms {
  let transaction: StellarSdk.Transaction;
  try {
    transaction = new StellarSdk.Transaction(transactionXdr, passphrase);
  } catch {
    throw new PaymentRefused("the payment is not a transaction for this network");
  }

  const [operation] = transaction.operations;
  if (transaction.operations.length !== 1 || operation?.type !== "invokeHostFunction") {
    throw new PaymentRefused("the payment is not a single contract call");
  }
  const auth = operation.auth ?? [];
  if (auth.length !== 1) {
    throw new PaymentRefused(`the payment carries ${auth.length} authorizations, expected one`);
  }
  const credentials = auth[0]!.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    throw new PaymentRefused("the payment is not authorized by an account");
  }
  const address = credentials.address();
  const payer = StellarSdk.Address.fromScAddress(address.address()).toString();
  if (!payer.startsWith("C")) {
    throw new PaymentRefused("the payment does not come from a Beaver402 policy account");
  }

  let agent: Record<string, unknown>;
  try {
    const signature = StellarSdk.scValToNative(address.signature());
    if (!Array.isArray(signature) || signature[0] !== "Agent" || typeof signature[1] !== "object") throw new Error();
    agent = signature[1] as Record<string, unknown>;
  } catch {
    throw new PaymentRefused("the payment was not authorized through the Beaver402 agent path");
  }

  const bytes = (key: string, length: number): Buffer => {
    const value = agent[key];
    if (!(value instanceof Uint8Array) || value.length !== length) {
      throw new PaymentRefused(`the payment's ${key} is not ${length} bytes`);
    }
    return Buffer.from(value);
  };

  return {
    payer,
    merchantPubkey: bytes("merchant_pubkey", 32),
    merchantSignature: bytes("merchant_signature", 64),
    requestDigest: bytes("request_digest", 32),
    recipient: String(agent.recipient),
    asset: String(agent.asset),
    amount: String(agent.amount),
    nonce: bytes("nonce", 32).toString("hex"),
    expiry: String(agent.expiry),
  };
}

export interface ObservedRequest {
  method: string;
  url: string;
  body: string | Buffer | null;
}

export interface ExpectedTerms {
  keypair: StellarSdk.Keypair;
  recipient: string;
  asset: string;
  amount: string;
  network: string;
}

/**
 * Confirm a payment answers a challenge this merchant signed for the very
 * request in front of it. The merchant rebuilds the challenge from the
 * request and its own terms, and checks its own signature over the result,
 * so a payment authorized for another endpoint, body, price, recipient or
 * merchant fails here, before the facilitator is asked to settle anything.
 */
export function bindPaymentToRequest(
  terms: AuthorizedTerms,
  request: ObservedRequest,
  expected: ExpectedTerms,
  now: number = Math.floor(Date.now() / 1000)
): { challengeHash: string } {
  if (!terms.merchantPubkey.equals(expected.keypair.rawPublicKey())) {
    throw new PaymentRefused("the payment answers another merchant's challenge");
  }
  if (terms.recipient !== expected.recipient) {
    throw new PaymentRefused("the payment goes to another recipient");
  }
  if (terms.asset !== expected.asset) {
    throw new PaymentRefused("the payment is in another token");
  }
  let amount: string;
  try {
    amount = normalizeAmount(terms.amount);
  } catch {
    throw new PaymentRefused("the payment amount is not a number");
  }
  if (amount !== normalizeAmount(expected.amount)) {
    throw new PaymentRefused("the payment is for another amount");
  }
  const expiry = Number(terms.expiry);
  if (!Number.isSafeInteger(expiry) || now > expiry) {
    throw new PaymentRefused("the challenge this payment answers has expired");
  }

  const fields: ChallengeFields = {
    version: ENCODING_VERSION,
    merchantPubkey: expected.keypair.publicKey(),
    httpMethod: request.method,
    normalizedEndpoint: request.url,
    bodyHash: hashBody(request.body),
    recipient: expected.recipient,
    asset: expected.asset,
    amount: expected.amount,
    network: expected.network,
    nonce: terms.nonce,
    expiry: terms.expiry,
  };
  if (!requestDigest(fields).equals(terms.requestDigest)) {
    throw new PaymentRefused("the payment was authorized for a different request");
  }
  const hash = hashChallenge(fields);
  if (!expected.keypair.verify(hash, terms.merchantSignature)) {
    throw new PaymentRefused("the payment does not carry this merchant's signature");
  }
  return { challengeHash: hash.toString("hex") };
}
