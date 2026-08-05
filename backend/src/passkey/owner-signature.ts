import * as StellarSdk from "@stellar/stellar-sdk";

const { xdr } = StellarSdk;

/** Order of the P-256 curve. */
const CURVE_ORDER = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);
const HALF_ORDER = CURVE_ORDER / 2n;

export interface OwnerAssertion {
  /** Raw authenticatorData from the WebAuthn assertion, base64url or base64. */
  authenticatorData: string;
  /** Raw clientDataJSON from the WebAuthn assertion, base64url or base64. */
  clientDataJSON: string;
  /** The assertion signature, DER encoded as WebAuthn produces it. */
  signature: string;
}

/**
 * Convert a DER encoded ECDSA signature into the raw pair Soroban expects.
 *
 * Authenticators hand back ASN.1, which carries r and s as variable length
 * integers with an optional leading zero, while the host wants exactly
 * thirty two bytes each.
 */
export function derToRawSignature(der: Buffer): Buffer {
  if (der[0] !== 0x30) {
    throw new Error("signature is not DER encoded");
  }

  // 0x30 len 0x02 rLen r 0x02 sLen s
  let offset = 2;
  if (der[1]! > 0x80) {
    // Long form length, skip the extra length bytes.
    offset = 2 + (der[1]! & 0x7f);
  }

  if (der[offset] !== 0x02) {
    throw new Error("signature is missing the r component");
  }
  const rLength = der[offset + 1]!;
  const r = der.subarray(offset + 2, offset + 2 + rLength);

  const sStart = offset + 2 + rLength;
  if (der[sStart] !== 0x02) {
    throw new Error("signature is missing the s component");
  }
  const sLength = der[sStart + 1]!;
  const s = der.subarray(sStart + 2, sStart + 2 + sLength);

  return Buffer.concat([pad32(r), pad32(normalizeS(s))]);
}

/**
 * Fold the upper half of the curve back onto the lower half.
 *
 * Both s and its complement verify the same message, so the network only
 * accepts the lower one. Some authenticators emit the upper one, and an
 * otherwise valid assertion would be rejected without this.
 */
export function normalizeS(s: Buffer): Buffer {
  const value = BigInt(`0x${s.toString("hex")}`);
  if (value <= HALF_ORDER) {
    return s;
  }

  const flipped = CURVE_ORDER - value;
  return Buffer.from(flipped.toString(16).padStart(64, "0"), "hex");
}

function pad32(value: Buffer): Buffer {
  // DER keeps a leading zero when the high bit is set, and drops leading
  // zeroes otherwise, so both trimming and padding can be needed.
  let trimmed = value;
  while (trimmed.length > 32 && trimmed[0] === 0x00) {
    trimmed = trimmed.subarray(1);
  }
  if (trimmed.length > 32) {
    throw new Error(`signature component is ${trimmed.length} bytes, expected 32`);
  }
  if (trimmed.length === 32) {
    return trimmed;
  }

  const padded = Buffer.alloc(32);
  trimmed.copy(padded, 32 - trimmed.length);
  return padded;
}

/** Browsers hand these fields back base64url encoded. */
function decode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Turn a WebAuthn assertion into the value the contract expects for an owner
 * action.
 *
 * The raw authenticator fields travel to the chain because the signature
 * covers them, and the contract rebuilds the digest from them rather than
 * trusting one it was handed.
 */
export function buildOwnerSignatureScVal(
  assertion: OwnerAssertion
): StellarSdk.xdr.ScVal {
  const signature = derToRawSignature(decode(assertion.signature));
  if (signature.length !== 64) {
    throw new Error(`signature must be 64 bytes, got ${signature.length}`);
  }

  const fields: Record<string, StellarSdk.xdr.ScVal> = {
    authenticator_data: xdr.ScVal.scvBytes(decode(assertion.authenticatorData)),
    client_data_json: xdr.ScVal.scvBytes(decode(assertion.clientDataJSON)),
    signature: xdr.ScVal.scvBytes(signature),
  };

  const entries = Object.keys(fields)
    .sort()
    .map(
      (key) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val: fields[key]!,
        })
    );

  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Owner"),
    xdr.ScVal.scvMap(entries),
  ]);
}

/**
 * The challenge a passkey has to sign for an owner action.
 *
 * WebAuthn echoes the challenge back inside clientDataJSON base64url encoded,
 * and the contract compares it against the payload the host gave it, so the
 * browser has to be handed exactly this.
 */
export function toWebAuthnChallenge(payload: Buffer): string {
  return payload.toString("base64url");
}
