import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

import { ENCODING_VERSION, hashBody, hashChallenge, type ChallengeFields, type SignedChallenge } from "./encoding.js";

export interface ChallengeTerms {
  keypair: Keypair;
  method: string;
  url: string;
  body: string | Buffer | null;
  recipient: string;
  asset: string;
  amount: string;
  /** The network passphrase. */
  network: string;
  expirySeconds: number;
  now?: number;
}

/** Sign a challenge over this request and these settlement terms. */
export function createSignedChallenge(terms: ChallengeTerms): SignedChallenge {
  const now = terms.now ?? Math.floor(Date.now() / 1000);
  const merchantPubkey = terms.keypair.publicKey();
  const fields: ChallengeFields = {
    version: ENCODING_VERSION,
    merchantPubkey,
    httpMethod: terms.method,
    normalizedEndpoint: terms.url,
    bodyHash: hashBody(terms.body),
    recipient: terms.recipient,
    asset: terms.asset,
    amount: terms.amount,
    network: terms.network,
    nonce: randomBytes(32).toString("hex"),
    expiry: String(now + terms.expirySeconds),
  };
  const hash = hashChallenge(fields);
  return {
    fields,
    hash: hash.toString("hex"),
    merchantSignature: terms.keypair.sign(hash).toString("base64"),
    merchantPubkey,
  };
}

/** Check a challenge carries its own merchant's signature. */
export function verifyChallengeSignature(challenge: SignedChallenge): boolean {
  try {
    if (challenge.fields.merchantPubkey !== challenge.merchantPubkey) return false;
    const key = Keypair.fromPublicKey(challenge.merchantPubkey);
    return key.verify(hashChallenge(challenge.fields), Buffer.from(challenge.merchantSignature, "base64"));
  } catch {
    return false;
  }
}
