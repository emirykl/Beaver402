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

describe("scanning in bounded ranges", async () => {
  const { scanRange } = await import("../src/ops/collector.js");

  /** A ledger with one event at each listed ledger, refusing ranges over `cap`. */
  function fakeRpc(eventLedgers: number[], cap = 4000) {
    const calls: { startLedger: number; endLedger: number }[] = [];
    return {
      calls,
      server: {
        async getEvents(req: { startLedger: number; endLedger: number; limit: number }) {
          calls.push({ startLedger: req.startLedger, endLedger: req.endLedger });
          if (req.endLedger - req.startLedger > cap) throw new Error("[-32001] request exceeded processing limit threshold");
          const events = eventLedgers
            .map((ledger, i) => ({ id: `${ledger}-${i}`, ledger }))
            .filter((e) => e.ledger >= req.startLedger && e.ledger < req.endLedger)
            .slice(0, req.limit);
          return { events, cursor: "0", latestLedger: 0, oldestLedger: 0 } as never;
        },
      },
    };
  }

  it("never asks for more ledgers than the chunk", async () => {
    const { server, calls } = fakeRpc([1500, 9000, 20000]);
    const seen: number[] = [];
    const through = await scanRange(server, [], 1000, 21000, 4000, async (events) => void seen.push(...events.map((e) => e.ledger)));
    expect(through).toBe(21000);
    expect(seen).toEqual([1500, 9000, 20000]);
    expect(Math.max(...calls.map((c) => c.endLedger - c.startLedger))).toBeLessThanOrEqual(4000);
  });

  it("reports how far it got after each range, so a cut short run resumes", async () => {
    const { server } = fakeRpc([]);
    const marks: number[] = [];
    let n = 0;
    const through = await scanRange(server, [], 1, 10000, 4000, async (_e, t) => void marks.push(t), () => n++ >= 2);
    expect(marks).toEqual([4000, 8000]);
    expect(through).toBe(8000);
  });

  it("reads a range with more events than a page, without repeats", async () => {
    const many = Array.from({ length: 450 }, (_, i) => 100 + Math.floor(i / 3));
    const { server } = fakeRpc(many);
    const ids = new Set<string>();
    let count = 0;
    await scanRange(server, [], 100, 400, 4000, async (events) => {
      count += events.length;
      events.forEach((e) => ids.add(e.id));
    });
    expect(ids.size).toBe(450);
    expect(count).toBe(450);
  });
});

describe("a range the provider refuses as too large", async () => {
  const { scanRange } = await import("../src/ops/collector.js");
  it("is split until each part is accepted, and nothing is lost", async () => {
    const calls: number[] = [];
    const server = {
      async getEvents(req: { startLedger: number; endLedger: number; limit: number }) {
        calls.push(req.endLedger - req.startLedger);
        if (req.endLedger - req.startLedger > 600) throw { code: -32001, message: "[-32001] request exceeded processing limit threshold" };
        const events = [700, 1500, 1990]
          .filter((l) => l >= req.startLedger && l < req.endLedger)
          .map((ledger) => ({ id: String(ledger), ledger }));
        return { events, cursor: "0", latestLedger: 0, oldestLedger: 0 } as never;
      },
    };
    const seen: number[] = [];
    await scanRange(server, [], 1, 2000, 2000, async (events) => void seen.push(...events.map((e) => e.ledger)));
    expect(seen.sort((a, b) => a - b)).toEqual([700, 1500, 1990]);
  });
});

describe("a dropped connection", async () => {
  const { scanRange } = await import("../src/ops/collector.js");
  it("is tried again rather than ending the run", async () => {
    let calls = 0;
    const server = {
      async getEvents() {
        if (++calls === 1) throw Object.assign(new Error("socket hang up"), { isAxiosError: true });
        return { events: [], cursor: "0", latestLedger: 0, oldestLedger: 0 } as never;
      },
    };
    await expect(scanRange(server, [], 1, 100, 2000, async () => {})).resolves.toBe(100);
    expect(calls).toBe(2);
  });
});
