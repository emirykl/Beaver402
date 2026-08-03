import { createHash } from "crypto";
import type { ChallengeFields, IntentFields, PayloadFields } from "./types.js";

// The merchant challenge and the buyer intent cover the same fields but are
// hashed under different domains, so a signature over one can never be
// replayed as a signature over the other. The contract derives both hashes
// the same way; see contracts/payment_policy/src/crypto.rs.
export const CHALLENGE_DOMAIN = "beaver402:challenge:v1";
export const INTENT_DOMAIN = "beaver402:intent:v1";
export const REQUEST_DOMAIN = "beaver402:request:v1";

/// Stellar strkey addresses are always 56 characters.
const STRKEY_LEN = 56;

export function normalizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

export function normalizeAmount(amount: string | number): string {
  return BigInt(amount).toString();
}

export function hashBody(body: string | Buffer | null | undefined): string {
  if (!body || (typeof body === "string" && body.length === 0)) {
    return createHash("sha256").update("").digest("hex");
  }
  const data = typeof body === "string" ? Buffer.from(body) : body;
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Hash data under a named domain. The domain length is written first so that
 * no domain can be confused with the start of the payload it protects.
 */
export function domainSeparatedHash(domain: string, data: Buffer): Buffer {
  const domainBytes = Buffer.from(domain, "utf-8");
  const domainLen = Buffer.alloc(1);
  domainLen.writeUInt8(domainBytes.length);

  return createHash("sha256")
    .update(Buffer.concat([domainLen, domainBytes, data]))
    .digest();
}

/**
 * The HTTP side of the paid request, reduced to a single hash.
 *
 * Only this digest travels to the ledger, so the endpoint and the request
 * body stay off chain while still being covered by both signatures.
 */
export function requestDigest(fields: PayloadFields): Buffer {
  const parts = [
    fields.version,
    fields.merchantPubkey,
    fields.httpMethod.toUpperCase(),
    normalizeEndpoint(fields.normalizedEndpoint),
    fields.bodyHash,
  ];

  return domainSeparatedHash(REQUEST_DOMAIN, Buffer.from(parts.join("|"), "utf-8"));
}

/** Stellar derives a network id by hashing the network passphrase. */
export function networkId(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase, "utf-8").digest();
}

function encodeAddress(value: string, label: string): Buffer {
  if (value.length !== STRKEY_LEN) {
    throw new Error(
      `${label} must be a 56 character Stellar address, got ${value.length} characters`
    );
  }
  return Buffer.from(value, "ascii");
}

function encodeI128(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  const unsigned = BigInt.asUintN(128, value);
  buf.writeBigUInt64BE(unsigned >> 64n, 0);
  buf.writeBigUInt64BE(unsigned & 0xffffffffffffffffn, 8);
  return buf;
}

function encodeU64(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(value);
  return buf;
}

/**
 * The byte string that both the challenge hash and the intent hash are
 * computed over.
 *
 * The settlement terms travel in the clear because the contract has to
 * compare them against the transfer it is being asked to authorize. Numbers
 * are big endian rather than decimal text, which keeps the encoding cheap to
 * reproduce on chain and unambiguous off chain.
 */
export function settlementPreimage(fields: PayloadFields): Buffer {
  return Buffer.concat([
    requestDigest(fields),
    encodeAddress(fields.recipient, "recipient"),
    encodeAddress(fields.asset, "asset"),
    encodeI128(BigInt(normalizeAmount(fields.amount))),
    networkId(fields.network),
    Buffer.from(fields.nonce, "hex"),
    encodeU64(BigInt(fields.expiry)),
  ]);
}

export function hashChallenge(fields: ChallengeFields): Buffer {
  return domainSeparatedHash(CHALLENGE_DOMAIN, settlementPreimage(fields));
}

export function hashIntent(fields: IntentFields): Buffer {
  return domainSeparatedHash(INTENT_DOMAIN, settlementPreimage(fields));
}

export function fieldsMatch(
  challenge: ChallengeFields,
  intent: IntentFields
): boolean {
  return (
    challenge.version === intent.version &&
    challenge.merchantPubkey === intent.merchantPubkey &&
    challenge.httpMethod.toUpperCase() === intent.httpMethod.toUpperCase() &&
    normalizeEndpoint(challenge.normalizedEndpoint) ===
      normalizeEndpoint(intent.normalizedEndpoint) &&
    challenge.bodyHash === intent.bodyHash &&
    challenge.recipient === intent.recipient &&
    challenge.asset === intent.asset &&
    normalizeAmount(challenge.amount) === normalizeAmount(intent.amount) &&
    challenge.network === intent.network &&
    challenge.nonce === intent.nonce &&
    challenge.expiry === intent.expiry
  );
}
