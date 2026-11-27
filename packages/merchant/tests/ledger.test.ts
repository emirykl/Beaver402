import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

import { confirmSettlement, isMerchantApproved, NotAPolicyAccount, SettlementNotConfirmed } from "../src/ledger.js";
import { preflight, passed } from "../src/preflight.js";
import { resolveConfig } from "../src/config.js";
import { fakeFacilitator, fakeLedger, MERCHANT, options, POLICY, RECIPIENT, TESTNET, transferEvent, USDC } from "./helpers/fixtures.js";

const TX = "aa".repeat(32);
const expected = { asset: USDC, from: POLICY, to: RECIPIENT, amount: "1000000" };
const ledgerWith = (status: string, events: StellarSdk.xdr.ContractEvent[] = []) => ({
  getTransaction: async () => ({ status, events: { contractEventsXdr: [events], transactionEventsXdr: [] } }) as never,
});
const fast = { attempts: 1, delayMs: 1 };

describe("confirming a settlement", () => {
  it("accepts one transfer of the agreed token, payer, recipient and amount", async () => {
    await expect(confirmSettlement(ledgerWith("SUCCESS", [transferEvent(POLICY, RECIPIENT, 1_000_000n)]), TX, expected, fast)).resolves.toBeUndefined();
  });

  it("refuses anything else", async () => {
    const other = StellarSdk.Keypair.random().publicKey();
    const cases = [
      ledgerWith("FAILED"),
      ledgerWith("NOT_FOUND"),
      ledgerWith("SUCCESS"),
      ledgerWith("SUCCESS", [transferEvent(POLICY, RECIPIENT, 1_000_000n), transferEvent(POLICY, RECIPIENT, 1_000_000n)]),
      ledgerWith("SUCCESS", [transferEvent(POLICY, RECIPIENT, 999_999n)]),
      ledgerWith("SUCCESS", [transferEvent(POLICY, other, 1_000_000n)]),
      ledgerWith("SUCCESS", [transferEvent(USDC, RECIPIENT, 1_000_000n)]),
      ledgerWith("SUCCESS", [transferEvent(POLICY, RECIPIENT, 1_000_000n, POLICY)]),
    ];
    for (const ledger of cases) {
      await expect(confirmSettlement(ledger, TX, expected, fast)).rejects.toThrow(SettlementNotConfirmed);
    }
  });

  it("refuses something that is not a transaction hash", async () => {
    await expect(confirmSettlement(ledgerWith("SUCCESS"), "", expected, fast)).rejects.toThrow(/returned nothing/);
  });
});

describe("merchant approval", () => {
  it("reads is_merchant from the policy account", async () => {
    expect(await isMerchantApproved(fakeLedger({ approved: true }).rpc, TESTNET, POLICY, MERCHANT)).toBe(true);
    expect(await isMerchantApproved(fakeLedger({ approved: false }).rpc, TESTNET, POLICY, MERCHANT)).toBe(false);
  });
  it("says when the account cannot answer", async () => {
    await expect(isMerchantApproved(fakeLedger({ simulationError: "no such function" }).rpc, TESTNET, POLICY, MERCHANT)).rejects.toThrow(NotAPolicyAccount);
  });
});

describe("preflight", () => {
  const config = resolveConfig(options());

  it("passes a ready setup", async () => {
    const results = await preflight(config, fakeLedger().rpc, fakeFacilitator().facilitator);
    expect(passed(results)).toBe(true);
    expect(results.map((r) => r.name)).toEqual(["network", "recipient trustline", "signer balance", "facilitator", "settlement store"]);
  });

  it("fails an RPC for another network", async () => {
    const ledger = fakeLedger();
    (ledger.rpc as { getNetwork: unknown }).getNetwork = async () => ({ passphrase: StellarSdk.Networks.PUBLIC });
    expect(passed(await preflight(config, ledger.rpc, fakeFacilitator().facilitator))).toBe(false);
  });

  it("fails a recipient without a USDC trustline", async () => {
    const ledger = fakeLedger();
    (ledger.rpc as { getTrustline: unknown }).getTrustline = async () => {
      throw new Error("missing");
    };
    const results = await preflight(config, ledger.rpc, fakeFacilitator().facilitator);
    expect(passed(results)).toBe(false);
    expect(results.find((r) => r.name === "recipient trustline")?.detail).toMatch(/no USDC trustline/);
  });

  it("fails a trustline the issuer has not authorized", async () => {
    const ledger = fakeLedger();
    (ledger.rpc as { getTrustline: unknown }).getTrustline = async () => ({ flags: () => 0 });
    expect(passed(await preflight(config, ledger.rpc, fakeFacilitator().facilitator))).toBe(false);
  });

  it("fails a recipient account that does not exist", async () => {
    const ledger = fakeLedger();
    (ledger.rpc as { getAccountEntry: unknown }).getAccountEntry = async () => {
      throw new Error("missing");
    };
    expect(passed(await preflight(config, ledger.rpc, fakeFacilitator().facilitator))).toBe(false);
  });

  it("fails a facilitator that does not settle on this network or refuses the key", async () => {
    expect(passed(await preflight(config, fakeLedger().rpc, fakeFacilitator({ supports: async () => false }).facilitator))).toBe(false);
    expect(passed(await preflight(config, fakeLedger().rpc, fakeFacilitator({ supports: async () => Promise.reject(new Error("401")) }).facilitator))).toBe(false);
  });

  it("only warns about a low signer balance", async () => {
    const ledger = fakeLedger();
    (ledger.rpc as { getAccountEntry: unknown }).getAccountEntry = async () => ({ balance: () => new StellarSdk.xdr.Int64(1n) });
    const results = await preflight(config, ledger.rpc, fakeFacilitator().facilitator);
    expect(passed(results)).toBe(true);
    expect(results.find((r) => r.name === "signer balance")?.ok).toBe(false);
  });
});
