import { afterEach, describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileStore, memoryStore, postgresStore, type SettledPayment, type SettlementStore } from "../src/store.js";

function payment(n: number): SettledPayment {
  return {
    txHash: n.toString(16).padStart(64, "a"),
    nonce: n.toString(16).padStart(64, "0"),
    challengeHash: "cc".repeat(32),
    payer: "CCYRWISLRHOL37FXT4FBOJBWTBIZCU2V3ST3TVNR25VQOFDZC7YE4Z2N",
    recipient: "GABQML4JXHSXP36ZD2SAXVPAKJCUSIOYXRU7YIQSJ7G267UW3WLB2GI4",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    amount: "1000000",
    network: "stellar:testnet",
    method: "GET",
    url: "https://api.example.com/data",
    settledAt: new Date(0).toISOString(),
  };
}

async function behavesAsAStore(store: SettlementStore) {
  expect(await store.record(payment(1))).toBe(true);
  expect(await store.hasNonce(payment(1).nonce)).toBe(true);
  expect(await store.record(payment(1))).toBe(false);
  expect(await store.record({ ...payment(2), txHash: payment(1).txHash })).toBe(false);
  expect(await store.record({ ...payment(2), nonce: payment(1).nonce })).toBe(false);
  expect(await store.record(payment(2))).toBe(true);
  expect((await store.pendingProofs()).map((p) => p.nonce)).toEqual([payment(1).nonce, payment(2).nonce]);
  await store.markProof(payment(1).nonce, "dd".repeat(32));
  expect((await store.pendingProofs()).map((p) => p.nonce)).toEqual([payment(2).nonce]);
}

describe("memory store", () => {
  it("records each payment once", () => behavesAsAStore(memoryStore()));
  it("says it is not persistent", () => expect(memoryStore().persistent).toBe(false));
});

describe("file store", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records each payment once, and still knows them after a restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-"));
    const path = join(dir, "payments.jsonl");
    const first = fileStore(path);
    await behavesAsAStore(first);
    await first.close!();

    const reopened = fileStore(path);
    expect(reopened.persistent).toBe(true);
    expect(await reopened.hasNonce(payment(1).nonce)).toBe(true);
    expect(await reopened.record(payment(1))).toBe(false);
    expect((await reopened.pendingProofs()).map((p) => p.nonce)).toEqual([payment(2).nonce]);
    await reopened.close!();
  });

  it("refuses a second open of the same file", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-"));
    const path = join(dir, "payments.jsonl");
    const store = fileStore(path);
    expect(() => fileStore(path)).toThrow(/already open/);
    await store.close!();
  });

  it("drops a last line cut short by a crash and keeps writing after it", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-"));
    const path = join(dir, "payments.jsonl");
    const store = fileStore(path);
    await store.record(payment(1));
    await store.close!();
    appendFileSync(path, '{"kind":"payment","payment":{"txHa');

    const reopened = fileStore(path);
    expect(await reopened.record(payment(2))).toBe(true);
    await reopened.close!();
    const again = fileStore(path);
    expect(await again.hasNonce(payment(2).nonce)).toBe(true);
    await again.close!();
    expect(readFileSync(path, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("refuses a damaged record in the middle", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-"));
    const path = join(dir, "payments.jsonl");
    appendFileSync(path, `not json\n${JSON.stringify({ kind: "payment", payment: payment(1) })}\n`);
    expect(() => fileStore(path)).toThrow(/line 1/);
  });
});

describe("postgres store", () => {
  /** Just enough of Postgres: two unique columns. */
  function fakePg() {
    const rows: Record<string, unknown>[] = [];
    return {
      async query(sql: string, params: unknown[] = []) {
        if (sql.startsWith("insert")) {
          if (rows.some((r) => r.tx_hash === params[0] || r.nonce === params[1])) throw Object.assign(new Error("dup"), { code: "23505" });
          const [tx_hash, nonce, challenge_hash, payer, recipient, asset, amount, network, method, url, settled_at] = params;
          rows.push({ tx_hash, nonce, challenge_hash, payer, recipient, asset, amount, network, method, url, settled_at, proof_transaction: null });
          return { rows: [] };
        }
        if (sql.startsWith("select 1")) return { rows: rows.filter((r) => r.nonce === params[0]) };
        if (sql.startsWith("update")) {
          rows.filter((r) => r.nonce === params[0]).forEach((r) => (r.proof_transaction = params[1]));
          return { rows: [] };
        }
        return { rows: rows.filter((r) => !r.proof_transaction) };
      },
    };
  }

  it("records each payment once, through the unique constraints", () => behavesAsAStore(postgresStore(fakePg())));

  it("passes other database errors on", async () => {
    const store = postgresStore({ query: async () => Promise.reject(new Error("connection lost")) });
    await expect(store.record(payment(1))).rejects.toThrow(/connection lost/);
  });

  it("refuses a table name it would have to quote", () => {
    expect(() => postgresStore(fakePg(), "x; drop table y")).toThrow();
  });
});
