import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { addressBytes } from "../chains/solana/encoding.js";
import { randomBytes } from "crypto";
import {
  ENCODING_VERSION,
  hashChallenge,
  hashBody,
} from "../shared/hashing.js";
import type { ChallengeFields, SignedChallenge } from "../shared/types.js";

export interface CreateChallengeOptions {
  merchantKeypair: Keypair;
  /**
   * How the merchant key is written on the chain the challenge is for. The
   * same ed25519 key is a G address on Stellar and base58 on Solana, and the
   * request digest covers the text. Defaults to the Stellar form.
   */
  merchantPubkey?: string;
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

  const merchantPubkey = options.merchantPubkey ?? options.merchantKeypair.publicKey();
  const fields: ChallengeFields = {
    version: ENCODING_VERSION,
    merchantPubkey,
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
    merchantPubkey,
  };
}

/** The raw ed25519 key behind a G address or a base58 Solana address. */
export function rawMerchantKey(pubkey: string): Buffer {
  if (/^G[A-Z2-7]{55}$/.test(pubkey)) {
    return Buffer.from(StrKey.decodeEd25519PublicKey(pubkey));
  }
  return addressBytes(pubkey, "merchantPubkey");
}

export function verifyMerchantSignature(
  challenge: SignedChallenge
): boolean {
  try {
    if (challenge.fields.merchantPubkey !== challenge.merchantPubkey) return false;
    const keypair = new Keypair({ type: "ed25519", publicKey: rawMerchantKey(challenge.merchantPubkey) });
    const hash = hashChallenge(challenge.fields);
    const sigBuffer = Buffer.from(challenge.merchantSignature, "base64");
    return keypair.verify(hash, sigBuffer);
  } catch {
    return false;
  }
}
