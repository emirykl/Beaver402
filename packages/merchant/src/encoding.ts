import { createHash } from "node:crypto";

/**
 * The Beaver402 canonical encoding, as the payment policy contract derives
 * it (contracts/payment_policy/src/crypto.rs). The merchant challenge and
 * the buyer intent cover the same fields but are hashed under different
 * domains, so a signature over one can never be replayed as the other.
 *
 * test-vectors/vectors.json pins these bytes. The Rust contract and this
 * package both check against it.
 */
export const CHALLENGE_DOMAIN = "beaver402:challenge:v1";
export const INTENT_DOMAIN = "beaver402:intent:v1";
export const REQUEST_DOMAIN = "beaver402:request:v1";

/** Version 2 covers the query string and keeps the path's case. */
export const ENCODING_VERSION = "2";

const STRKEY_LEN = 56;

/** Every field the challenge signature covers. */
export interface ChallengeFields {
  version: string;
  /** The merchant signing key, as a G address. */
  merchantPubkey: string;
  httpMethod: string;
  normalizedEndpoint: string;
  /** sha256 of the raw request body, hex. */
  bodyHash: string;
  /** Where the payment lands, a G address. */
  recipient: string;
  /** The USDC Stellar Asset Contract, a C address. */
  asset: string;
  /** Integer units of 10^-7 USDC, as a decimal string. */
  amount: string;
  /** The network passphrase. */
  network: string;
  /** 32 random bytes, hex. */
  nonce: string;
  /** Unix seconds, as a decimal string. */
  expiry: string;
}

export interface SignedChallenge {
  fields: ChallengeFields;
  hash: string;
  merchantSignature: string;
  merchantPubkey: string;
}

/**
 * The endpoint as both sides hash it. Scheme and host are lowercased and a
 * default port dropped; the path keeps its case; the query is kept, sorted
 * by key then value; the fragment is dropped.
 */
export function normalizeEndpoint(url: string): string {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].sort(([ka, va], [kb, vb]) =>
    ka === kb ? (va < vb ? -1 : va > vb ? 1 : 0) : ka < kb ? -1 : 1
  );
  const query = new URLSearchParams(params).toString();
  return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${query ? `?${query}` : ""}`;
}

export function normalizeAmount(amount: string | number | bigint): string {
  return BigInt(amount).toString();
}

export function hashBody(body: string | Buffer | null | undefined): string {
  const data = body == null ? Buffer.alloc(0) : typeof body === "string" ? Buffer.from(body) : body;
  return createHash("sha256").update(data).digest("hex");
}

/** The domain length goes first, so no domain reads as the start of the data. */
export function domainSeparatedHash(domain: string, data: Buffer): Buffer {
  const domainBytes = Buffer.from(domain, "utf-8");
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from([domainBytes.length]), domainBytes, data]))
    .digest();
}

/** The HTTP side of the request, reduced to one hash that goes on chain. */
export function requestDigest(fields: ChallengeFields): Buffer {
  const parts = [
    fields.version,
    fields.merchantPubkey,
    fields.httpMethod.toUpperCase(),
    normalizeEndpoint(fields.normalizedEndpoint),
    fields.bodyHash,
  ];
  return domainSeparatedHash(REQUEST_DOMAIN, Buffer.from(parts.join("|"), "utf-8"));
}

export function networkId(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase, "utf-8").digest();
}

function encodeAddress(value: string, label: string): Buffer {
  if (value.length !== STRKEY_LEN) {
    throw new Error(`${label} must be a 56 character Stellar address, got ${value.length} characters`);
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

/** The bytes both the challenge hash and the intent hash are taken over. */
export function settlementPreimage(fields: ChallengeFields): Buffer {
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

export function hashIntent(fields: ChallengeFields): Buffer {
  return domainSeparatedHash(INTENT_DOMAIN, settlementPreimage(fields));
}
