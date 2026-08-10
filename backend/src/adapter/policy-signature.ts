import * as StellarSdk from "@stellar/stellar-sdk";

import type { PolicySignaturePayload } from "../shared/types.js";

const { xdr, Address } = StellarSdk;

/**
 * Turn the agent side of a proof of intent into the value the contract
 * expects in the authorization entry.
 *
 * The contract declares its signature type as an enum, which Soroban encodes
 * as a vector holding the variant name followed by its payload. The payload
 * itself is a struct, encoded as a map whose keys have to be in sorted order.
 * Getting either of those wrong makes the host reject the entry before
 * __check_auth ever runs, so the layout is spelled out rather than inferred.
 */
export function buildAgentSignatureScVal(
  payload: PolicySignaturePayload
): StellarSdk.xdr.ScVal {
  const fields: Record<string, StellarSdk.xdr.ScVal> = {
    agent_signature: bytes(payload.agentSignature, 64, "agentSignature"),
    amount: amountToScVal(payload.amount),
    asset: new Address(payload.asset).toScVal(),
    expiry: xdr.ScVal.scvU64(new xdr.Uint64(BigInt(payload.expiry))),
    merchant_pubkey: bytes(payload.merchantPubkey, 32, "merchantPubkey"),
    merchant_signature: bytes(payload.merchantSignature, 64, "merchantSignature"),
    nonce: bytes(payload.nonce, 32, "nonce"),
    recipient: new Address(payload.recipient).toScVal(),
    request_digest: bytes(payload.requestDigest, 32, "requestDigest"),
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
    xdr.ScVal.scvSymbol("Agent"),
    xdr.ScVal.scvMap(entries),
  ]);
}

/**
 * The same value reaches us written three different ways depending on who
 * produced it. A merchant identifies itself with a Stellar address, keys
 * copied out of a config tend to be hex, and signatures come back from the
 * signer as base64. The contract wants raw bytes in every case.
 */
function toBuffer(value: string, expectedLength: number): Buffer {
  if (expectedLength === 32 && /^G[A-Z2-7]{55}$/.test(value)) {
    return Buffer.from(StellarSdk.StrKey.decodeEd25519PublicKey(value));
  }

  const looksHex = /^[0-9a-fA-F]+$/.test(value) && value.length === expectedLength * 2;
  return looksHex ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
}

function bytes(value: string, expectedLength: number, label: string): StellarSdk.xdr.ScVal {
  const buf = toBuffer(value, expectedLength);
  if (buf.length !== expectedLength) {
    throw new Error(
      `${label} must decode to ${expectedLength} bytes, got ${buf.length}`
    );
  }
  return xdr.ScVal.scvBytes(buf);
}

function amountToScVal(amount: string): StellarSdk.xdr.ScVal {
  const value = BigInt(amount);
  if (value < 0n) {
    throw new Error("amount cannot be negative");
  }
  return StellarSdk.nativeToScVal(value, { type: "i128" });
}
