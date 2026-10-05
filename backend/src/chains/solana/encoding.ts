/**
 * The Solana family of the canonical encoding.
 *
 * The request digest is shared with Stellar. What differs is the settlement
 * preimage, because Solana addresses are 32 byte keys rather than 56
 * character strkeys and amounts are u64, and the domains, so a challenge for
 * one chain can never verify on the other. The program derives the same
 * bytes in solana/programs/beaver402_policy/src/encoding.rs, and
 * test-vectors/vectors-solana.json is the shared fixture.
 */
import { getAddressEncoder, isAddress, type Address } from "@solana/kit";

import { domainSeparatedHash, networkId, normalizeAmount, requestDigest } from "../../shared/hashing.js";
import type { PayloadFields } from "../../shared/types.js";

export const SOLANA_CHALLENGE_DOMAIN = "beaver402:challenge:solana:v1";
export const SOLANA_INTENT_DOMAIN = "beaver402:intent:solana:v1";

export const SOLANA_PREIMAGE_LENGTH = 176;

const U64_MAX = (1n << 64n) - 1n;

/** A Solana challenge names its cluster by its CAIP-2 id. */
export function isSolanaNetwork(network: string): boolean {
  return network.startsWith("solana:");
}

/** A base58 address as the 32 bytes the program sees. */
export function addressBytes(value: string, label: string): Buffer {
  if (!isAddress(value)) {
    throw new Error(`${label} must be a Solana address, got ${value}`);
  }
  return Buffer.from(getAddressEncoder().encode(value as Address));
}

function u64(value: bigint, label: string): Buffer {
  if (value < 0n || value > U64_MAX) {
    throw new Error(`${label} does not fit in a u64`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(value);
  return buf;
}

/**
 * 176 bytes, concatenated with no separators: request digest (32),
 * recipient (32), mint (32), amount as a big endian u64 (8), network id (32),
 * nonce (32), expiry as a big endian u64 (8).
 */
export function solanaSettlementPreimage(fields: PayloadFields): Buffer {
  const nonce = Buffer.from(fields.nonce, "hex");
  if (nonce.length !== 32) {
    throw new Error("nonce must be 32 bytes");
  }
  return Buffer.concat([
    requestDigest(fields),
    addressBytes(fields.recipient, "recipient"),
    addressBytes(fields.asset, "asset"),
    u64(BigInt(normalizeAmount(fields.amount)), "amount"),
    networkId(fields.network),
    nonce,
    u64(BigInt(fields.expiry), "expiry"),
  ]);
}

export const SOLANA_OWNER_DOMAIN = "beaver402:owner:solana:v1";

/** The limits as an owner action's challenge covers them. */
export interface SolanaLimits {
  maxPaymentAmount: string;
  maxTxCount: number;
  maxTotalAmount: string;
  windowSize: number;
}

/** Fixed width and big endian, like the program's limits_bytes. */
export function limitsBytes(limits: SolanaLimits): Buffer {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(limits.maxTxCount);
  return Buffer.concat([
    u64(BigInt(limits.maxPaymentAmount), "maxPaymentAmount"),
    count,
    u64(BigInt(limits.maxTotalAmount), "maxTotalAmount"),
    u64(BigInt(limits.windowSize), "windowSize"),
  ]);
}

/**
 * What the owner passkey signs for an action:
 *
 * `domain_hash(OWNER_DOMAIN, program ‖ policy ‖ len(action) ‖ action ‖ args ‖ owner_nonce ‖ valid_until)`
 *
 * The counter is the account's, so an assertion authorizes exactly one call.
 */
export function solanaOwnerChallenge(input: {
  programId: string;
  policy: string;
  action: string;
  args: Buffer;
  ownerNonce: bigint;
  validUntil: bigint;
}): Buffer {
  const action = Buffer.from(input.action, "utf-8");
  return domainSeparatedHash(
    SOLANA_OWNER_DOMAIN,
    Buffer.concat([
      addressBytes(input.programId, "programId"),
      addressBytes(input.policy, "policy"),
      Buffer.from([action.length]),
      action,
      input.args,
      u64(input.ownerNonce, "ownerNonce"),
      u64(input.validUntil, "validUntil"),
    ])
  );
}
