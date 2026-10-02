import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

import { confirmSettlement } from "../src/merchant/settlement.js";
import { POLICY, USDC } from "./helpers/x402.js";

const { xdr } = StellarSdk;
const RECIPIENT = StellarSdk.Keypair.random().publicKey();
const TX = "aa".repeat(32);

function transferEvent(from: string, to: string, amount: bigint, contract = USDC): StellarSdk.xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StellarSdk.Address.fromString(contract).toScAddress().contractId(),
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [
          xdr.ScVal.scvSymbol("transfer"),
          StellarSdk.Address.fromString(from).toScVal(),
          StellarSdk.Address.fromString(to).toScVal(),
          StellarSdk.nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
        ],
        data: StellarSdk.nativeToScVal(amount, { type: "i128" }),
      })
    ),
  });
}

function ledger(status: string, events: StellarSdk.xdr.ContractEvent[] = []) {
  return {
    getTransaction: async () => ({ status, events: { contractEventsXdr: [events], transactionEventsXdr: [] } }) as never,
  };
}

const expected = { asset: USDC, from: POLICY, to: RECIPIENT, amount: "1000000" };
const skip = async () => {};

describe("confirming a settlement on the ledger", () => {
  it("accepts one transfer of the agreed token, amount, payer and recipient", async () => {
    await expect(
      confirmSettlement(TX, expected, ledger("SUCCESS", [transferEvent(POLICY, RECIPIENT, 1_000_000n)]), skip)
    ).resolves.toBeUndefined();
  });

  it("refuses a failed transaction", async () => {
    await expect(confirmSettlement(TX, expected, ledger("FAILED"), skip)).rejects.toThrow(/FAILED/);
  });

  it("refuses a transaction with no transfer", async () => {
    await expect(confirmSettlement(TX, expected, ledger("SUCCESS"), skip)).rejects.toThrow(/0 transfers/);
  });

  it("refuses a transaction with two transfers", async () => {
    const two = [transferEvent(POLICY, RECIPIENT, 1_000_000n), transferEvent(POLICY, RECIPIENT, 1_000_000n)];
    await expect(confirmSettlement(TX, expected, ledger("SUCCESS", two), skip)).rejects.toThrow(/2 transfers/);
  });

  it("refuses the wrong amount, recipient, payer or token", async () => {
    const other = StellarSdk.Keypair.random().publicKey();
    for (const event of [
      transferEvent(POLICY, RECIPIENT, 999_999n),
      transferEvent(POLICY, other, 1_000_000n),
      transferEvent("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", RECIPIENT, 1_000_000n),
      transferEvent(POLICY, RECIPIENT, 1_000_000n, "CCYRWISLRHOL37FXT4FBOJBWTBIZCU2V3ST3TVNR25VQOFDZC7YE4Z2N"),
    ]) {
      await expect(confirmSettlement(TX, expected, ledger("SUCCESS", [event]), skip)).rejects.toThrow();
    }
  });

  it("refuses something that is not a transaction hash", async () => {
    await expect(confirmSettlement("", expected, ledger("SUCCESS"), skip)).rejects.toThrow(/returned nothing/);
  });
});
