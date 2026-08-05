import { describe, it, expect } from "vitest";
import { createSign, createPrivateKey, generateKeyPairSync } from "crypto";

import {
  buildOwnerSignatureScVal,
  derToRawSignature,
  normalizeS,
  toWebAuthnChallenge,
} from "../src/passkey/owner-signature.js";

const CURVE_ORDER = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);
const HALF_ORDER = CURVE_ORDER / 2n;

/** Sign something the way a real authenticator would, in DER. */
function signDer(message: Buffer): Buffer {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signer = createSign("SHA256");
  signer.update(message);
  return signer.sign(createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" })));
}

function toBigInt(buf: Buffer): bigint {
  return BigInt(`0x${buf.toString("hex")}`);
}

describe("turning an authenticator signature into what the chain accepts", () => {
  it("splits a real der signature into two 32 byte halves", () => {
    const raw = derToRawSignature(signDer(Buffer.from("hello")));

    expect(raw.length).toBe(64);
  });

  it("keeps s in the lower half of the curve", () => {
    // Fifty signatures is enough to hit the upper half by chance many times.
    for (let i = 0; i < 50; i += 1) {
      const raw = derToRawSignature(signDer(Buffer.from(`message ${i}`)));
      const s = toBigInt(raw.subarray(32));

      expect(s).toBeLessThanOrEqual(HALF_ORDER);
    }
  });

  it("folds an s above the halfway point back down", () => {
    const high = CURVE_ORDER - 1n;
    const buf = Buffer.from(high.toString(16).padStart(64, "0"), "hex");

    const folded = toBigInt(normalizeS(buf));

    expect(folded).toBe(1n);
    expect(folded).toBeLessThanOrEqual(HALF_ORDER);
  });

  it("leaves an s already in the lower half alone", () => {
    const low = Buffer.alloc(32);
    low[31] = 9;

    expect(normalizeS(low)).toEqual(low);
  });

  it("pads a component that der shortened", () => {
    // r encoded as a single byte, which der does when the value is small.
    const der = Buffer.from("3006020103020104", "hex");
    const raw = derToRawSignature(der);

    expect(raw.length).toBe(64);
    expect(toBigInt(raw.subarray(0, 32))).toBe(3n);
    expect(toBigInt(raw.subarray(32))).toBe(4n);
  });

  it("refuses something that is not der", () => {
    expect(() => derToRawSignature(Buffer.alloc(64, 1))).toThrow(/not DER encoded/);
  });
});

describe("owner signature encoding", () => {
  const assertion = () => ({
    authenticatorData: Buffer.alloc(37, 5).toString("base64url"),
    clientDataJSON: Buffer.from('{"type":"webauthn.get"}').toString("base64url"),
    signature: signDer(Buffer.from("payload")).toString("base64url"),
  });

  it("wraps the assertion in the Owner variant", () => {
    const value = buildOwnerSignatureScVal(assertion());
    const parts = value.vec()!;

    expect(parts.length).toBe(2);
    expect(parts[0]!.sym().toString()).toBe("Owner");
    expect(parts[1]!.switch().name).toBe("scvMap");
  });

  it("lists the fields the contract reads, in sorted order", () => {
    const keys = buildOwnerSignatureScVal(assertion())
      .vec()![1]!
      .map()!
      .map((entry) => entry.key().sym().toString());

    expect(keys).toEqual(["authenticator_data", "client_data_json", "signature"]);
  });

  it("carries the signature as 64 raw bytes", () => {
    const fields = new Map(
      buildOwnerSignatureScVal(assertion())
        .vec()![1]!
        .map()!
        .map((entry) => [entry.key().sym().toString(), entry.val()])
    );

    expect(fields.get("signature")!.bytes().length).toBe(64);
    expect(fields.get("authenticator_data")!.bytes().length).toBe(37);
  });
});

describe("the challenge handed to the browser", () => {
  it("is the payload base64url encoded, which is what lands in clientDataJSON", () => {
    const payload = Buffer.alloc(32, 0);
    expect(toWebAuthnChallenge(payload)).toBe("A".repeat(43));
  });

  it("uses the url safe alphabet and no padding", () => {
    const payload = Buffer.alloc(32);
    payload[0] = 0xfb;
    payload[1] = 0xf0;

    const challenge = toWebAuthnChallenge(payload);

    expect(challenge).not.toContain("=");
    expect(challenge.startsWith("-_")).toBe(true);
  });
});
