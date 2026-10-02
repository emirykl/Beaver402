import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

import { cursorLedger, eventType, filtersFor, toJson, toRow } from "../src/ops/collector.js";
import { loadNetworkConfig } from "../src/config/network.js";
import { POLICY, USDC } from "./helpers/x402.js";

const { xdr } = StellarSdk;

describe("reading events for the record", () => {
  it("names an event by its symbol topics", () => {
    expect(eventType([xdr.ScVal.scvSymbol("poi"), xdr.ScVal.scvSymbol("verified"), xdr.ScVal.scvBytes(Buffer.alloc(32))])).toBe(
      "poi/verified"
    );
    expect(eventType([xdr.ScVal.scvSymbol("transfer"), StellarSdk.Address.fromString(POLICY).toScVal()])).toBe("transfer");
    expect(eventType([])).toBe("unknown");
  });

  it("turns event values into plain JSON", () => {
    expect(toJson({ amount: 5n, nonce: new Uint8Array([1, 2]), nested: [3n] })).toEqual({
      amount: "5",
      nonce: "0102",
      nested: ["3"],
    });
  });

  it("asks for the account's own events and USDC moving in and out of it", () => {
    const filters = filtersFor(POLICY, USDC);
    const account = StellarSdk.Address.fromString(POLICY).toScVal().toXDR("base64");
    expect(filters[0]).toEqual({ type: "contract", contractIds: [POLICY] });
    expect(filters[1]!.contractIds).toEqual([USDC]);
    expect(filters[1]!.topics![0]![1]).toBe(account);
    expect(filters[2]!.topics![0]![2]).toBe(account);
  });

  it("keeps the fields a reviewer needs and nothing private", () => {
    const row = toRow(
      {
        id: "0000000001-0000000001",
        type: "contract",
        ledger: 42,
        ledgerClosedAt: "2026-10-02T00:00:00Z",
        transactionIndex: 1,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        txHash: "ab".repeat(32),
        contractId: new StellarSdk.Contract(POLICY),
        topic: [xdr.ScVal.scvSymbol("frozen"), xdr.ScVal.scvSymbol("manual")],
        value: StellarSdk.nativeToScVal({ tx_count: 1, total_amount: 5n }),
      } as StellarSdk.rpc.Api.EventResponse,
      loadNetworkConfig({})
    );
    expect(row).toMatchObject({
      network: "testnet",
      contract_id: POLICY,
      ledger: 42,
      event_type: "frozen/manual",
      topics: ["frozen", "manual"],
    });
  });
});

describe("paging through the ledger", () => {
  it("reads the ledger a cursor has reached", () => {
    // Cursors as testnet RPC returned them on 2026-10-02, ten thousand
    // ledgers apart.
    expect(cursorLedger("0020894702362427391-4294967295")).toBe(4864926);
    expect(cursorLedger("0020937647740420095-4294967295")).toBe(4874925);
  });
});
