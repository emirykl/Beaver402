import { Keypair } from "@stellar/stellar-sdk";
import { randomBytes } from "crypto";
import {
  hashChallenge,
  hashBody,
} from "../shared/hashing.js";
import type { ChallengeFields, SignedChallenge } from "../shared/types.js";

export interface CreateChallengeOptions {
  merchantKeypair: Keypair;
  httpMethod: string;
  endpoint: string;
  body?: string | Buffer | null;
  recipient: string;
  asset: string;
  amount: string;
  network: string;
  expirySeconds?: number;
}

export function createSignedChallenge(
  options: CreateChallengeOptions
): SignedChallenge {
  const nonce = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const expiry = (now + (options.expirySeconds ?? 300)).toString();

  const fields: ChallengeFields = {
    version: "1",
    merchantPubkey: options.merchantKeypair.publicKey(),
    httpMethod: options.httpMethod,
    normalizedEndpoint: options.endpoint,
    bodyHash: hashBody(options.body),
    recipient: options.recipient,
    asset: options.asset,
    amount: options.amount,
    network: options.network,
    nonce,
    expiry,
  };

  const hash = hashChallenge(fields);
  const signature = options.merchantKeypair.sign(hash);

  return {
    fields,
    hash: hash.toString("hex"),
    merchantSignature: signature.toString("base64"),
    merchantPubkey: options.merchantKeypair.publicKey(),
  };
}

export function verifyMerchantSignature(
  challenge: SignedChallenge
): boolean {
  try {
    const keypair = Keypair.fromPublicKey(challenge.merchantPubkey);
    const hash = hashChallenge(challenge.fields);
    const sigBuffer = Buffer.from(challenge.merchantSignature, "base64");
    return keypair.verify(hash, sigBuffer);
  } catch {
    return false;
  }
}
