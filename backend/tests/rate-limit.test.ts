import { describe, it, expect } from "vitest";
import type { Request, Response, NextFunction } from "express";

import { createRateLimit } from "../src/lib/rate-limit.js";

/** Just enough of a request for the limiter to decide about it. */
function request(method: string, ip = "1.2.3.4"): Request {
  return { method, ip, socket: { remoteAddress: ip } } as unknown as Request;
}

interface Recorded {
  status?: number;
  body?: { error?: string };
  headers: Record<string, string>;
}

function response(): { res: Response; recorded: Recorded } {
  const recorded: Recorded = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
    },
    status(code: number) {
      recorded.status = code;
      return res;
    },
    json(body: { error?: string }) {
      recorded.body = body;
      return res;
    },
  } as unknown as Response;

  return { res, recorded };
}

function run(
  limiter: ReturnType<typeof createRateLimit>,
  req: Request
): { passed: boolean; recorded: Recorded } {
  let passed = false;
  const { res, recorded } = response();
  limiter(req, res, (() => {
    passed = true;
  }) as NextFunction);

  return { passed, recorded };
}

describe("holding back a caller who is hammering a route", () => {
  it("lets the allowance through and refuses the next one", () => {
    const limiter = createRateLimit({ windowMs: 60_000, max: 2 });

    expect(run(limiter, request("POST")).passed).toBe(true);
    expect(run(limiter, request("POST")).passed).toBe(true);

    const third = run(limiter, request("POST"));
    expect(third.passed).toBe(false);
    expect(third.recorded.status).toBe(429);
  });

  it("says how long the wait is rather than failing silently", () => {
    const limiter = createRateLimit({ windowMs: 60_000, max: 1 });
    run(limiter, request("POST"));

    const refused = run(limiter, request("POST"));
    expect(refused.recorded.headers["Retry-After"]).toBeDefined();
    expect(refused.recorded.body?.error).toMatch(/try again in \d+ seconds/);
  });

  it("never counts a read, so refreshing cannot lock anyone out", () => {
    const limiter = createRateLimit({ windowMs: 60_000, max: 1 });

    for (let i = 0; i < 50; i++) {
      expect(run(limiter, request("GET")).passed).toBe(true);
    }
  });

  it("counts each caller separately", () => {
    const limiter = createRateLimit({ windowMs: 60_000, max: 1 });
    run(limiter, request("POST", "1.1.1.1"));

    expect(run(limiter, request("POST", "1.1.1.1")).passed).toBe(false);
    expect(run(limiter, request("POST", "2.2.2.2")).passed).toBe(true);
  });

  it("forgets a caller once their window has passed", async () => {
    const limiter = createRateLimit({ windowMs: 10, max: 1 });
    run(limiter, request("POST"));
    expect(run(limiter, request("POST")).passed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run(limiter, request("POST")).passed).toBe(true);
  });
});
