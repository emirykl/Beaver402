import {
  fieldsMatch,
  hashBody,
  hashIntent,
  normalizeAmount,
  normalizeEndpoint,
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
    // Every field the two sides have to agree on is named here, so a refusal
    // says which one disagreed rather than just that something did.
    const comparisons: Array<[string, string, string]> = [
      ["version", challenge.fields.version, intent.fields.version],
      ["merchantPubkey", challenge.fields.merchantPubkey, intent.fields.merchantPubkey],
      [
        "httpMethod",
        challenge.fields.httpMethod.toUpperCase(),
        intent.fields.httpMethod.toUpperCase(),
      ],
      [
        "endpoint",
        normalizeEndpoint(challenge.fields.normalizedEndpoint),
        normalizeEndpoint(intent.fields.normalizedEndpoint),
      ],
      ["bodyHash", challenge.fields.bodyHash, intent.fields.bodyHash],
      ["recipient", challenge.fields.recipient, intent.fields.recipient],
      ["asset", challenge.fields.asset, intent.fields.asset],
      [
        "amount",
        normalizeAmount(challenge.fields.amount),
        normalizeAmount(intent.fields.amount),
      ],
      ["network", challenge.fields.network, intent.fields.network],
      ["nonce", challenge.fields.nonce, intent.fields.nonce],
      ["expiry", challenge.fields.expiry, intent.fields.expiry],
    ];

    const mismatches = comparisons
      .filter(([, left, right]) => left !== right)
      .map(([field]) => field);

    return {
      matches: false,
      reason: `field mismatch: ${mismatches.join(", ")}`,
    };
  }

  return { matches: true };
}
