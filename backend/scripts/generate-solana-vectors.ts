/**
 * Regenerate the Solana test vectors.
 *
 * The same arrangement as generate-vectors.ts: produced from the TypeScript
 * encoder, reproduced by the program's own code in
 * solana/programs/beaver402_policy/tests/vectors.rs.
 *
 * Run with: npm run vectors:solana
 */
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import {
  ENCODING_VERSION,
  hashBody,
  hashChallenge,
  hashIntent,
  requestDigest,
} from "../src/shared/hashing.js";
import {
  addressBytes,
  limitsBytes,
  SOLANA_CHALLENGE_DOMAIN,
  SOLANA_INTENT_DOMAIN,
  SOLANA_OWNER_DOMAIN,
  solanaOwnerChallenge,
  solanaSettlementPreimage,
} from "../src/chains/solana/encoding.js";
import type { PayloadFields } from "../src/shared/types.js";

const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MERCHANT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const RECIPIENT = "7cVfgArCheMR6Cs4t6vz5rfnqd56vZq4ndaBrY5xkxXy";
const OTHER_RECIPIENT = "HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const NONCE = "9f2b7c1d4e6a8035bd91c7f0a3e5d284617b09cf3a2d5e8104f7b6c93a0d2e15";
const PROGRAM = "6PLoS71vwBV76RnRWuT3yoPHqzXrBdkW53Dn3BL9Uhx5";
const POLICY = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";

function fields(overrides: Partial<PayloadFields> = {}): PayloadFields {
  return {
    version: ENCODING_VERSION,
    merchantPubkey: MERCHANT,
    httpMethod: "GET",
    normalizedEndpoint: "https://api.merchant.com/data",
    bodyHash: hashBody(null),
    recipient: RECIPIENT,
    asset: USDC,
    amount: "100000",
    network: DEVNET,
    nonce: NONCE,
    expiry: "1700000000",
    ...overrides,
  };
}

function vector(name: string, note: string, f: PayloadFields) {
  return {
    name,
    note,
    fields: f,
    requestDigest: requestDigest(f).toString("hex"),
    settlementPreimage: solanaSettlementPreimage(f).toString("hex"),
    challengeHash: hashChallenge(f).toString("hex"),
    intentHash: hashIntent(f).toString("hex"),
  };
}

const body = JSON.stringify({ query: "weather", city: "Istanbul" });

const vectors = [
  vector("basic_payment", "A plain GET with no request body.", fields()),
  vector(
    "post_with_body",
    "A POST whose body is covered by the request digest.",
    fields({
      httpMethod: "POST",
      normalizedEndpoint: "https://api.merchant.com/query",
      bodyHash: hashBody(body),
    })
  ),
  vector("other_recipient", "Only the recipient differs from basic_payment.", fields({ recipient: OTHER_RECIPIENT })),
  vector("large_amount", "The largest amount a u64 carries.", fields({ amount: "18446744073709551615" })),
];

function ownerVector(name: string, action: string, args: Buffer, ownerNonce: bigint) {
  const validUntil = 1700000600n;
  return {
    name,
    programId: PROGRAM,
    policy: POLICY,
    action,
    args: args.toString("hex"),
    ownerNonce: ownerNonce.toString(),
    validUntil: validUntil.toString(),
    challenge: solanaOwnerChallenge({ programId: PROGRAM, policy: POLICY, action, args, ownerNonce, validUntil }).toString(
      "hex"
    ),
  };
}

const ownerVectors = [
  ownerVector("freeze", "freeze_payments", Buffer.alloc(0), 0n),
  ownerVector("add_merchant", "add_merchant", addressBytes(MERCHANT, "merchant"), 3n),
  ownerVector(
    "reduce_limits",
    "reduce_limits",
    limitsBytes({ maxPaymentAmount: "500000", maxTxCount: 3, maxTotalAmount: "2000000", windowSize: 86400 }),
    7n
  ),
];

const output = {
  description:
    "Shared vectors for the Solana family of the Beaver402 canonical encoding. Generated from the TypeScript implementation and verified from Rust.",
  version: ENCODING_VERSION,
  domains: {
    request: "beaver402:request:v1",
    challenge: SOLANA_CHALLENGE_DOMAIN,
    intent: SOLANA_INTENT_DOMAIN,
    owner: SOLANA_OWNER_DOMAIN,
  },
  vectors,
  ownerVectors,
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const target = resolve(currentDir, "../../test-vectors/vectors-solana.json");
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);

console.log(`wrote ${vectors.length} encoding vectors and ${ownerVectors.length} owner vectors`);
console.log(target);
