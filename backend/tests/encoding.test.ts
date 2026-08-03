import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  CHALLENGE_DOMAIN,
  INTENT_DOMAIN,
  domainSeparatedHash,
  hashChallenge,
  hashIntent,
  networkId,
  normalizeAmount,
  normalizeEndpoint,
  requestDigest,
  settlementPreimage,
} from "../src/shared/hashing.js";
import type { PayloadFields } from "../src/shared/types.js";

const TESTNET = "Test SDF Network ; September 2015";
const MERCHANT = "GBBGXTNC63DX4INOE5IFEG5JIVSFSLMZXL676T7Y5E7DDZXJMQWBIBBO";
const RECIPIENT = "GABQML4JXHSXP36ZD2SAXVPAKJCUSIOYXRU7YIQSJ7G267UW3WLB2GI4";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function fields(overrides: Partial<PayloadFields> = {}): PayloadFields {
  return {
    version: "1",
    merchantPubkey: MERCHANT,
    httpMethod: "GET",
    normalizedEndpoint: "https://api.merchant.com/data",
    bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    recipient: RECIPIENT,
    asset: USDC,
    amount: "1000000",
    network: TESTNET,
    nonce: "9f2b7c1d4e6a8035bd91c7f0a3e5d284617b09cf3a2d5e8104f7b6c93a0d2e15",
    expiry: "1700000000",
    ...overrides,
  };
}

describe("settlement preimage", () => {
  it("lays the fields out in the order the contract reads them", () => {
    const preimage = settlementPreimage(fields());

    // 32 digest, 56 recipient, 56 asset, 16 amount, 32 network, 32 nonce, 8 expiry
    expect(preimage.length).toBe(232);
    expect(preimage.subarray(0, 32)).toEqual(requestDigest(fields()));
    expect(preimage.subarray(32, 88).toString("ascii")).toBe(RECIPIENT);
    expect(preimage.subarray(88, 144).toString("ascii")).toBe(USDC);
    expect(preimage.subarray(144, 160).readBigUInt64BE(8)).toBe(1000000n);
    expect(preimage.subarray(160, 192)).toEqual(networkId(TESTNET));
    expect(preimage.subarray(224).readBigUInt64BE(0)).toBe(1700000000n);
  });

  it("encodes the largest amount i128 can carry", () => {
    const max = "170141183460469231731687303715884105727";
    const preimage = settlementPreimage(fields({ amount: max }));
    const amount = preimage.subarray(144, 160);

    expect(amount[0]).toBe(0x7f);
    expect(amount.subarray(1).every((b) => b === 0xff)).toBe(true);
  });

  it("refuses an asset that is not a stellar address", () => {
    expect(() => settlementPreimage(fields({ asset: "USDC" }))).toThrow(
      /asset must be a 56 character Stellar address/
    );
  });

  it("refuses a recipient that is not a stellar address", () => {
    expect(() => settlementPreimage(fields({ recipient: "GABC" }))).toThrow(
      /recipient must be a 56 character Stellar address/
    );
  });
});

describe("request digest", () => {
  it("normalizes method and host casing", () => {
    const plain = requestDigest(fields());
    const shouty = requestDigest(
      fields({ httpMethod: "get", normalizedEndpoint: "https://API.Merchant.COM/data" })
    );

    expect(shouty).toEqual(plain);
  });

  it("changes when the body changes", () => {
    const other = requestDigest(fields({ bodyHash: "00".repeat(32) }));
    expect(other).not.toEqual(requestDigest(fields()));
  });

  it("changes when the endpoint changes", () => {
    const other = requestDigest(
      fields({ normalizedEndpoint: "https://api.merchant.com/other" })
    );
    expect(other).not.toEqual(requestDigest(fields()));
  });
});

describe("domain separation", () => {
  it("gives the challenge and the intent different hashes", () => {
    expect(hashChallenge(fields())).not.toEqual(hashIntent(fields()));
  });

  it("derives each hash from the shared preimage", () => {
    const preimage = settlementPreimage(fields());

    expect(hashChallenge(fields())).toEqual(
      domainSeparatedHash(CHALLENGE_DOMAIN, preimage)
    );
    expect(hashIntent(fields())).toEqual(domainSeparatedHash(INTENT_DOMAIN, preimage));
  });

  it("writes the domain length ahead of the domain", () => {
    const data = Buffer.from("payload");
    const domain = "beaver402:test:v1";
    const expected = Buffer.concat([
      Buffer.from([domain.length]),
      Buffer.from(domain),
      data,
    ]);

    // Hashing the assembled preimage directly has to match the helper.
    expect(domainSeparatedHash(domain, data)).toEqual(
      createHash("sha256").update(expected).digest()
    );
  });

  it("produces a 32 byte hash", () => {
    expect(hashChallenge(fields()).length).toBe(32);
    expect(hashIntent(fields()).length).toBe(32);
  });
});

describe("normalization helpers", () => {
  it("lowercases the host and path but keeps the scheme", () => {
    expect(normalizeEndpoint("HTTPS://API.Merchant.COM/Data")).toBe(
      "https://api.merchant.com/data"
    );
  });

  it("strips query strings from the endpoint", () => {
    expect(normalizeEndpoint("https://api.merchant.com/data?page=2")).toBe(
      "https://api.merchant.com/data"
    );
  });

  it("normalizes amounts to a plain decimal string", () => {
    expect(normalizeAmount("0001000")).toBe("1000");
    expect(normalizeAmount(1000)).toBe("1000");
  });

  it("hashes the network passphrase the way stellar does", () => {
    expect(networkId(TESTNET).length).toBe(32);
    expect(networkId(TESTNET)).not.toEqual(networkId("other passphrase"));
  });
});
