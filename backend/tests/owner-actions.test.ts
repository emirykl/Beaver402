import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { scValToNative } from "@stellar/stellar-sdk";

import { argsFor, isOwnerAction, OWNER_ACTIONS } from "../src/policy/owner-actions.js";

/** The bytes an ScVal is carrying, whatever wrapper the SDK put around them. */
function bytesOf(value: { value: () => unknown }): Buffer {
  return Buffer.from(value.value() as Uint8Array);
}

describe("naming an owner action", () => {
  it("accepts every action the panel can invoke", () => {
    for (const action of OWNER_ACTIONS) {
      expect(isOwnerAction(action)).toBe(true);
    }
  });

  it("refuses anything else, including a payment", () => {
    expect(isOwnerAction("transfer")).toBe(false);
    expect(isOwnerAction("")).toBe(false);
    expect(isOwnerAction("freeze")).toBe(false);
  });
});

describe("the arguments an owner action carries", () => {
  const merchant = Keypair.random();

  it("gives the actions that take nothing an empty list", () => {
    expect(argsFor("freeze_payments")).toEqual([]);
    expect(argsFor("restore_payments")).toEqual([]);
    expect(argsFor("revoke_agent_signer")).toEqual([]);
  });

  it("turns a stellar address into the raw key the contract stores", () => {
    const [arg] = argsFor("add_merchant", merchant.publicKey());

    expect(bytesOf(arg!)).toEqual(
      Buffer.from(StrKey.decodeEd25519PublicKey(merchant.publicKey()))
    );
  });

  it("reads the same key written as hex", () => {
    const hex = Buffer.from(
      StrKey.decodeEd25519PublicKey(merchant.publicKey())
    ).toString("hex");

    expect(bytesOf(argsFor("add_merchant", hex)[0]!)).toEqual(
      bytesOf(argsFor("add_merchant", merchant.publicKey())[0]!)
    );
  });

  it("refuses to name a merchant nobody supplied", () => {
    expect(() => argsFor("add_merchant")).toThrow(/needs a public key/);
    expect(() => argsFor("remove_merchant")).toThrow(/needs a public key/);
  });
});

describe("reinstating the agent signer", () => {
  const agent = Keypair.random();
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env.AGENT_SECRET;
    process.env.AGENT_SECRET = agent.secret();
  });

  afterAll(() => {
    if (previous === undefined) {
      delete process.env.AGENT_SECRET;
    } else {
      process.env.AGENT_SECRET = previous;
    }
  });

  it("falls back to the signer this backend is configured with", () => {
    const [arg] = argsFor("set_agent_signer");

    expect(bytesOf(arg!)).toEqual(
      Buffer.from(StrKey.decodeEd25519PublicKey(agent.publicKey()))
    );
  });

  it("prefers a key named explicitly, which is what a rotation does", () => {
    const other = Keypair.random();
    const [arg] = argsFor("set_agent_signer", other.publicKey());

    expect(bytesOf(arg!)).toEqual(
      Buffer.from(StrKey.decodeEd25519PublicKey(other.publicKey()))
    );
  });

  it("says so when there is no key to fall back on", () => {
    delete process.env.AGENT_SECRET;

    expect(() => argsFor("set_agent_signer")).toThrow(/AGENT_SECRET/);

    process.env.AGENT_SECRET = agent.secret();
  });
});

describe("lowering the limits", () => {
  it("encodes the new limits the way the contract reads them", () => {
    const [arg] = argsFor("reduce_limits", {
      limits: { maxPaymentAmount: "5000000", maxTxCount: 3, maxTotalAmount: "20000000", windowSize: 86400 },
    });
    expect(scValToNative(arg!)).toEqual({
      max_payment_amount: 5000000n,
      max_total_amount: 20000000n,
      max_tx_count: 3,
      window_size: 86400n,
    });
  });

  it("refuses to guess the limits", () => {
    expect(() => argsFor("reduce_limits")).toThrow(/needs the new limits/);
  });

  it("refuses amounts that are not whole numbers", () => {
    expect(() =>
      argsFor("reduce_limits", {
        limits: { maxPaymentAmount: "0.5", maxTxCount: 3, maxTotalAmount: "1", windowSize: 86400 },
      })
    ).toThrow(/whole positive number/);
  });
});

describe("recovering the funds", () => {
  it("recovers the account's USDC unless told otherwise", () => {
    const [arg] = argsFor("recover_funds");
    expect(scValToNative(arg!)).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
  });

  it("refuses something that is not a token contract", () => {
    expect(() => argsFor("recover_funds", { token: Keypair.random().publicKey() })).toThrow(
      /token contract address/
    );
  });
});
