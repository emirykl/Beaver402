/**
 * Regenerate the shared test vectors.
 *
 * The vectors are the contract between the TypeScript encoder and the Rust
 * one. Both sides read this file and must arrive at the same bytes, so it is
 * generated from the TypeScript implementation and then checked from Rust.
 *
 * Run with: npx tsx scripts/generate-vectors.ts
 */
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

import {
  hashBody,
  hashChallenge,
  hashIntent,
  requestDigest,
  settlementPreimage,
} from "../src/shared/hashing.js";
import type { PayloadFields } from "../src/shared/types.js";

const TESTNET = "Test SDF Network ; September 2015";
const MERCHANT = "GBBGXTNC63DX4INOE5IFEG5JIVSFSLMZXL676T7Y5E7DDZXJMQWBIBBO";
const RECIPIENT = "GABQML4JXHSXP36ZD2SAXVPAKJCUSIOYXRU7YIQSJ7G267UW3WLB2GI4";
const OTHER_RECIPIENT = "GCNMK2LORF3QTG3LMFV7KWQIILL6OUPLY5G6VGFQYBQY7VCXPAAG3FSL";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const NONCE = "9f2b7c1d4e6a8035bd91c7f0a3e5d284617b09cf3a2d5e8104f7b6c93a0d2e15";

function fields(overrides: Partial<PayloadFields> = {}): PayloadFields {
  return {
    version: "1",
    merchantPubkey: MERCHANT,
    httpMethod: "GET",
    normalizedEndpoint: "https://api.merchant.com/data",
    bodyHash: hashBody(null),
    recipient: RECIPIENT,
    asset: USDC,
    amount: "1000000",
    network: TESTNET,
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
    settlementPreimage: settlementPreimage(f).toString("hex"),
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
  vector(
    "case_normalization",
    "Method and host casing are normalized, so this matches basic_payment.",
    fields({
      httpMethod: "get",
      normalizedEndpoint: "https://API.Merchant.COM/data",
    })
  ),
  vector(
    "large_amount",
    "An amount near the top of the range i128 has to carry.",
    fields({ amount: "170141183460469231731687303715884105727" })
  ),
  vector(
    "zero_amount",
    "A zero amount still has to encode to a stable hash.",
    fields({ amount: "0" })
  ),
];

const matchVectors = [
  {
    name: "matching_pair",
    note: "The buyer observed exactly what the merchant signed.",
    challenge: fields(),
    intent: fields(),
    shouldMatch: true,
  },
  {
    name: "mismatched_amount",
    note: "The buyer was asked to pay more than the merchant quoted.",
    challenge: fields(),
    intent: fields({ amount: "9000000" }),
    shouldMatch: false,
  },
  {
    name: "mismatched_endpoint",
    note: "The request was redirected to a different endpoint.",
    challenge: fields(),
    intent: fields({ normalizedEndpoint: "https://api.merchant.com/other" }),
    shouldMatch: false,
  },
  {
    name: "mismatched_recipient",
    note: "The payment was rerouted to a different account.",
    challenge: fields(),
    intent: fields({ recipient: OTHER_RECIPIENT }),
    shouldMatch: false,
  },
  {
    name: "mismatched_body",
    note: "The request body was altered after the merchant signed it.",
    challenge: fields(),
    intent: fields({ bodyHash: hashBody(body) }),
    shouldMatch: false,
  },
];

const output = {
  description:
    "Shared vectors for the Beaver402 canonical encoding. Generated from the TypeScript implementation and verified from Rust.",
  version: "2",
  domains: {
    request: "beaver402:request:v1",
    challenge: "beaver402:challenge:v1",
    intent: "beaver402:intent:v1",
  },
  vectors,
  matchVectors,
};

const currentDir = dirname(fileURLToPath(import.meta.url));
const target = resolve(currentDir, "../../test-vectors/vectors.json");
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);

console.log(`wrote ${vectors.length} encoding vectors and ${matchVectors.length} match vectors`);
console.log(target);
