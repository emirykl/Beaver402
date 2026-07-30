import {
  hashIntent,
  hashBody,
  fieldsMatch,
} from "../shared/hashing.js";
import type {
  IntentFields,
  SignedIntent,
  SignedChallenge,
} from "../shared/types.js";

export interface CreateIntentOptions {
  merchantPubkey: string;
  httpMethod: string;
  endpoint: string;
  body?: string | Buffer | null;
  recipient: string;
  asset: string;
  amount: string;
  network: string;
  nonce: string;
  expiry: string;
}

export function createIntent(options: CreateIntentOptions): SignedIntent {
  const fields: IntentFields = {
    version: "1",
    merchantPubkey: options.merchantPubkey,
    httpMethod: options.httpMethod,
    normalizedEndpoint: options.endpoint,
    bodyHash: hashBody(options.body),
    recipient: options.recipient,
    asset: options.asset,
    amount: options.amount,
    network: options.network,
    nonce: options.nonce,
    expiry: options.expiry,
  };

  const hash = hashIntent(fields);

  return {
    fields,
    hash: hash.toString("hex"),
  };
}

export function createIntentFromChallenge(
  challenge: SignedChallenge,
  observedHttpMethod: string,
  observedEndpoint: string,
  observedBody?: string | Buffer | null
): SignedIntent {
  return createIntent({
    merchantPubkey: challenge.merchantPubkey,
    httpMethod: observedHttpMethod,
    endpoint: observedEndpoint,
    body: observedBody,
    recipient: challenge.fields.recipient,
    asset: challenge.fields.asset,
    amount: challenge.fields.amount,
    network: challenge.fields.network,
    nonce: challenge.fields.nonce,
    expiry: challenge.fields.expiry,
  });
}

export function verifyChallengeIntentMatch(
  challenge: SignedChallenge,
  intent: SignedIntent
): { matches: boolean; reason?: string } {
  if (!fieldsMatch(challenge.fields, intent.fields)) {
    const mismatches: string[] = [];

    if (
      challenge.fields.httpMethod.toUpperCase() !==
      intent.fields.httpMethod.toUpperCase()
    ) {
      mismatches.push("httpMethod");
    }
    if (challenge.fields.bodyHash !== intent.fields.bodyHash) {
      mismatches.push("bodyHash");
    }
    if (challenge.fields.recipient !== intent.fields.recipient) {
      mismatches.push("recipient");
    }
    if (challenge.fields.asset !== intent.fields.asset) {
      mismatches.push("asset");
    }
    if (challenge.fields.amount !== intent.fields.amount) {
      mismatches.push("amount");
    }
    if (challenge.fields.network !== intent.fields.network) {
      mismatches.push("network");
    }

    return {
      matches: false,
      reason: `field mismatch: ${mismatches.join(", ")}`,
    };
  }

  return { matches: true };
}
