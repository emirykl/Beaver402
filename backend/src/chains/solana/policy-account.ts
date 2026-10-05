/**
 * Reading the policy account.
 *
 * The account is zero copy: the program reads it in place, so its bytes are
 * the struct's memory layout. The offsets below are pinned on the program
 * side by the_account_layout_is_the_one_the_backend_reads in
 * solana/programs/beaver402_policy/tests/policy.rs.
 */
import { createHash } from "node:crypto";
import { getAddressDecoder, type Address } from "@solana/kit";

const DISCRIMINATOR = createHash("sha256").update("account:Policy").digest().subarray(0, 8);
const ACCOUNT_LENGTH = 8 + 2960;
const SLOTS = 16;
const SLOT_LENGTH = 152;
const MERCHANTS = 8;

const AT = {
  ownerNonce: 0,
  maxPaymentAmount: 8,
  maxTotalAmount: 16,
  windowSize: 24,
  maxTxCount: 32,
  slots: 40,
  merchants: 2472,
  policyId: 2728,
  rpIdHash: 2760,
  networkId: 2792,
  agentSigner: 2824,
  asset: 2856,
  recovery: 2888,
  ownerPrefix: 2920,
  ownerX: 2921,
  frozen: 2953,
  merchantCount: 2954,
  bump: 2955,
};

export interface PolicySlot {
  timestamp: number;
  amount: bigint;
  nonce: string;
  challengeHash: string;
  intentHash: string;
  merchant: Address;
  frozeAccount: boolean;
}

export interface PolicyAccount {
  ownerNonce: bigint;
  limits: {
    maxPaymentAmount: string;
    maxTxCount: number;
    maxTotalAmount: string;
    windowSize: number;
  };
  slots: PolicySlot[];
  merchants: Address[];
  policyId: Buffer;
  rpIdHash: Buffer;
  networkId: Buffer;
  /** Null once the owner revoked it. */
  agentSigner: Address | null;
  asset: Address;
  recovery: Address;
  /** The compressed secp256r1 point. */
  owner: Buffer;
  frozen: boolean;
}

const decoder = getAddressDecoder();
const DEFAULT_KEY = "11111111111111111111111111111111";

export function decodePolicyAccount(raw: Uint8Array): PolicyAccount {
  const data = Buffer.from(raw);
  if (data.length !== ACCOUNT_LENGTH || !data.subarray(0, 8).equals(DISCRIMINATOR)) {
    throw new Error("not a Beaver402 policy account");
  }
  const body = data.subarray(8);
  const key = (at: number) => decoder.decode(body.subarray(at, at + 32));

  const slots: PolicySlot[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const s = body.subarray(AT.slots + i * SLOT_LENGTH, AT.slots + (i + 1) * SLOT_LENGTH);
    slots.push({
      timestamp: Number(s.readBigUInt64LE(0)),
      amount: s.readBigUInt64LE(8),
      nonce: s.subarray(16, 48).toString("hex"),
      challengeHash: s.subarray(48, 80).toString("hex"),
      intentHash: s.subarray(80, 112).toString("hex"),
      merchant: decoder.decode(s.subarray(112, 144)),
      frozeAccount: s[144] !== 0,
    });
  }

  const merchantCount = body[AT.merchantCount]!;
  const merchants: Address[] = [];
  for (let i = 0; i < Math.min(merchantCount, MERCHANTS); i++) {
    merchants.push(key(AT.merchants + i * 32));
  }

  const agent = key(AT.agentSigner);
  return {
    ownerNonce: body.readBigUInt64LE(AT.ownerNonce),
    limits: {
      maxPaymentAmount: body.readBigUInt64LE(AT.maxPaymentAmount).toString(),
      maxTxCount: body.readUInt32LE(AT.maxTxCount),
      maxTotalAmount: body.readBigUInt64LE(AT.maxTotalAmount).toString(),
      windowSize: Number(body.readBigUInt64LE(AT.windowSize)),
    },
    slots,
    merchants,
    policyId: Buffer.from(body.subarray(AT.policyId, AT.policyId + 32)),
    rpIdHash: Buffer.from(body.subarray(AT.rpIdHash, AT.rpIdHash + 32)),
    networkId: Buffer.from(body.subarray(AT.networkId, AT.networkId + 32)),
    agentSigner: agent === DEFAULT_KEY ? null : agent,
    asset: key(AT.asset),
    recovery: key(AT.recovery),
    owner: Buffer.concat([body.subarray(AT.ownerPrefix, AT.ownerPrefix + 1), body.subarray(AT.ownerX, AT.ownerX + 32)]),
    frozen: body[AT.frozen] !== 0,
  };
}

/** The velocity window at a moment, the way the program counts it. */
export function velocityState(account: PolicyAccount, now: number) {
  let txCount = 0;
  let totalAmount = 0n;
  let windowStart = 0;
  for (const slot of account.slots) {
    if (slot.amount > 0n && now - slot.timestamp < account.limits.windowSize) {
      txCount += 1;
      totalAmount += slot.amount;
      if (windowStart === 0 || slot.timestamp < windowStart) windowStart = slot.timestamp;
    }
  }
  return { txCount, totalAmount: totalAmount.toString(), windowStart };
}
