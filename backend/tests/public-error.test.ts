import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";

import { redact } from "../src/lib/public-error.js";
import { collectorFailure } from "../src/ops/collector.js";

const SECRET_URL = "https://mainnet.provider.example/v1/9f3c2b7a6d5e4f3a2b1c0d9e8f7a6b5c";

describe("keeping secrets out of what the public sees", () => {
  it("removes a provider URL carrying its key", () => {
    const text = redact(`request to ${SECRET_URL} failed, reason: socket hang up`);
    expect(text).not.toContain("9f3c2b7a");
    expect(text).toContain("[redacted]");
  });

  it("removes Stellar secrets, database keys and bearer tokens", () => {
    const text = redact(
      "SB4ULAQT6ASFTQ2IJSIJSXNAB4RCQH3W2EKXHGP24KBWX4FYLU4KCNZ3 sb_secret_abcDEF123 Bearer abc.def.ghi eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlc2lnbg"
    );
    expect(text).not.toMatch(/SB4ULAQ|sb_secret_abc|abc\.def\.ghi|eyJhbGci/);
  });

  it("leaves an ordinary explanation alone", () => {
    expect(redact("AccountFrozen, payments are halted until the owner resumes them")).toBe(
      "AccountFrozen, payments are halted until the owner resumes them"
    );
  });

  it("stores a fixed summary for a failed collection, never the raw error", () => {
    const summary = collectorFailure(new Error(`request to ${SECRET_URL} failed, reason: fetch failed`));
    expect(summary).toBe("the RPC could not be reached");
    expect(collectorFailure(new Error(`relation "chain_events" does not exist`))).toBe("the database refused the write");
    expect(collectorFailure(new Error(`something odd at ${SECRET_URL}`))).toBe("the collection failed");
  });
});

describe("the payment log", () => {
  it("is refused without an owner session", async () => {
    const { createApp } = await import("../src/app.js");
    const server = createApp("agent").listen(0);
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/transactions`);
    server.close();
    expect(response.status).toBe(401);
  });
});

describe("running against mainnet locally", () => {
  it("forces the mainnet network whatever the env file says", () => {
    const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
    expect(scripts["dev:mainnet"]).toMatch(/^BEAVER_NETWORK=mainnet /);
    expect(scripts["dev:mainnet"]).toContain("--env-file=.env.mainnet");
  });
});
