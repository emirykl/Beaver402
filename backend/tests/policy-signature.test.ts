import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

import { buildAgentSignatureScVal } from "../src/adapter/policy-signature.js";
import type { PolicySignaturePayload } from "../src/shared/types.js";

const { xdr } = StellarSdk;

const RECIPIENT = "GABQML4JXHSXP36ZD2SAXVPAKJCUSIOYXRU7YIQSJ7G267UW3WLB2GI4";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function payload(overrides: Partial<PolicySignaturePayload> = {}): PolicySignaturePayload {
  return {
    agentSignature: Buffer.alloc(64, 1).toString("base64"),
    merchantPubkey: Buffer.alloc(32, 2).toString("hex"),
    merchantSignature: Buffer.alloc(64, 3).toString("base64"),
    requestDigest: Buffer.alloc(32, 4).toString("hex"),
    recipient: RECIPIENT,
    asset: USDC,
    amount: "1000000",
    nonce: Buffer.alloc(32, 5).toString("hex"),
    expiry: "1700000000",
    ...overrides,
  };
}

// The contract declares its signature type as an enum whose Agent variant
// carries a struct. Soroban encodes that as a vector holding the variant name
// and a map, and the map keys have to be sorted. A mistake here is rejected by
// the host before __check_auth runs, which is hard to diagnose on chain, so
// the shape is pinned down here instead.
describe("agent signature encoding", () => {
  it("wraps the struct in the Agent variant", () => {
    const value = buildAgentSignatureScVal(payload());

    expect(value.switch().name).toBe("scvVec");
    const parts = value.vec()!;
    expect(parts.length).toBe(2);
    expect(parts[0]!.sym().toString()).toBe("Agent");
    expect(parts[1]!.switch().name).toBe("scvMap");
  });

  it("lists every field the contract reads, in sorted order", () => {
    const value = buildAgentSignatureScVal(payload());
    const keys = value
      .vec()![1]!
      .map()!
      .map((entry) => entry.key().sym().toString());

    expect(keys).toEqual([
      "agent_signature",
      "amount",
      "asset",
      "expiry",
      "merchant_pubkey",
      "merchant_signature",
      "nonce",
      "recipient",
      "request_digest",
    ]);
    expect(keys).toEqual([...keys].sort());
  });

  it("carries the settlement terms as the contract types them", () => {
    const value = buildAgentSignatureScVal(payload());
    const fields = new Map(
      value
        .vec()![1]!
        .map()!
        .map((entry) => [entry.key().sym().toString(), entry.val()])
    );

    expect(fields.get("asset")!.switch().name).toBe("scvAddress");
    expect(fields.get("recipient")!.switch().name).toBe("scvAddress");
    expect(fields.get("amount")!.switch().name).toBe("scvI128");
    expect(fields.get("expiry")!.switch().name).toBe("scvU64");
    expect(fields.get("agent_signature")!.bytes().length).toBe(64);
    expect(fields.get("merchant_signature")!.bytes().length).toBe(64);
    expect(fields.get("merchant_pubkey")!.bytes().length).toBe(32);
    expect(fields.get("nonce")!.bytes().length).toBe(32);
    expect(fields.get("request_digest")!.bytes().length).toBe(32);
  });

  it("survives a round trip through xdr", () => {
    const value = buildAgentSignatureScVal(payload());
    const restored = xdr.ScVal.fromXDR(value.toXDR());

    expect(restored.toXDR("base64")).toBe(value.toXDR("base64"));
  });

  it("accepts hex and base64 for the same signature", () => {
    const raw = Buffer.alloc(64, 7);
    const fromHex = buildAgentSignatureScVal(
      payload({ agentSignature: raw.toString("hex") })
    );
    const fromBase64 = buildAgentSignatureScVal(
      payload({ agentSignature: raw.toString("base64") })
    );

    expect(fromHex.toXDR("base64")).toBe(fromBase64.toXDR("base64"));
  });

  it("refuses a signature of the wrong length", () => {
    expect(() =>
      buildAgentSignatureScVal(payload({ agentSignature: Buffer.alloc(32).toString("base64") }))
    ).toThrow(/agentSignature must decode to 64 bytes/);
  });

  it("refuses a negative amount", () => {
    expect(() => buildAgentSignatureScVal(payload({ amount: "-1" }))).toThrow(
      /amount cannot be negative/
    );
  });
});
