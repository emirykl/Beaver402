import { describe, it, expect } from "vitest";

import { alertAfterRun, resendMailer, type Mailer } from "../src/ops/alerts.js";
import { memoryAlertStore } from "../src/ops/alert-memory.js";

function setup() {
  const sent: { subject: string; text: string }[] = [];
  const mailer: Mailer = { send: async (subject, text) => void sent.push({ subject, text }) };
  const store = memoryAlertStore();
  return { sent, store, deps: { store, mailer } };
}

describe("collector alerts", () => {
  it("emails a failed run once, however many runs fail after it", async () => {
    const { sent, store, deps } = setup();
    for (let i = 0; i < 4; i++) {
      await alertAfterRun({ ok: false, summary: "the RPC could not be reached" }, "mainnet", deps);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("[Beaver402 mainnet] event collector failed");
    expect(sent[0]!.text).toMatch(/the RPC could not be reached/);
    expect(sent[0]!.text).toMatch(/What to do/);
    expect(store.all()[0]!.repeats).toBe(3);
  });

  it("closes the incident on the next good run and says so once", async () => {
    const { sent, store, deps } = setup();
    await alertAfterRun({ ok: false, summary: "the collection failed" }, "mainnet", deps);
    await alertAfterRun({ ok: true, gap: null }, "mainnet", deps);
    await alertAfterRun({ ok: true, gap: null }, "mainnet", deps);
    expect(sent.map((m) => m.subject)).toEqual([
      "[Beaver402 mainnet] event collector failed",
      "[Beaver402 mainnet] event collector recovered",
    ]);
    expect(store.all()[0]!.resolved).toBe(true);

    // A later failure is a new incident and is emailed again.
    await alertAfterRun({ ok: false, summary: "the collection failed" }, "mainnet", deps);
    expect(sent).toHaveLength(3);
  });

  it("emails each gap once, keyed by its ledgers", async () => {
    const { sent, deps } = setup();
    await alertAfterRun({ ok: true, gap: { from: 100, to: 250 } }, "testnet", deps);
    await alertAfterRun({ ok: true, gap: { from: 100, to: 250 } }, "testnet", deps);
    await alertAfterRun({ ok: true, gap: { from: 900, to: 950 } }, "testnet", deps);
    expect(sent.map((m) => m.subject)).toEqual([
      "[Beaver402 testnet] gap in the ledger history",
      "[Beaver402 testnet] gap in the ledger history",
    ]);
    expect(sent[0]!.text).toMatch(/Ledgers 100 to 250/);
    expect(sent[1]!.text).toMatch(/Ledgers 900 to 950/);
  });

  it("keeps the networks apart", async () => {
    const { sent, deps } = setup();
    await alertAfterRun({ ok: false, summary: "x" }, "testnet", deps);
    await alertAfterRun({ ok: true, gap: null }, "mainnet", deps);
    expect(sent).toHaveLength(1);
  });

  it("never lets a failing email hide the run's result", async () => {
    const store = memoryAlertStore();
    const deps = { store, mailer: { send: async () => Promise.reject(new Error("smtp down")) } };
    await expect(alertAfterRun({ ok: false, summary: "x" }, "mainnet", deps)).resolves.toBeUndefined();
  });

  it("does nothing without a store", async () => {
    await expect(alertAfterRun({ ok: false, summary: "x" }, "mainnet", null)).resolves.toBeUndefined();
  });
});

describe("the Resend mailer", () => {
  it("is off until a key and a recipient are set", () => {
    expect(resendMailer({})).toBeNull();
    expect(resendMailer({ RESEND_API_KEY: "k" })).toBeNull();
  });

  it("posts the email with the key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await resendMailer({ RESEND_API_KEY: "re_test", ALERT_EMAIL_TO: "ops@example.com" }, fake)!.send("s", "t");
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ to: ["ops@example.com"], subject: "s", text: "t" });
  });

  it("reports a refused email", async () => {
    const fake = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await expect(resendMailer({ RESEND_API_KEY: "k", ALERT_EMAIL_TO: "a@b.c" }, fake)!.send("s", "t")).rejects.toThrow(/401/);
  });
});
