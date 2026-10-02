import type { Request, Response, NextFunction } from "express";

import { getSupabase, isSupabaseConfigured } from "./supabase.js";

export interface RateLimitOptions {
  /** How long a window lasts, in milliseconds. */
  windowMs: number;
  /** How many counted requests one caller may make inside a window. */
  max: number;
  /** Keeps the counts of different routers apart in a shared store. */
  scope?: string;
  /** Where the counts are kept. Defaults to the database when there is one. */
  store?: RateLimitStore;
}

export interface Verdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Somewhere to count attempts. */
export interface RateLimitStore {
  hit(key: string, windowMs: number, max: number): Verdict | Promise<Verdict>;
}

/** Stop the table from growing a row per caller forever. */
const MAX_TRACKED_CALLERS = 1000;

/**
 * Counts in this process's memory. Enough for one long running process, and
 * what the tests use.
 */
export function memoryStore(): RateLimitStore {
  const counts = new Map<string, { count: number; resetAt: number }>();

  function prune(now: number): void {
    if (counts.size < MAX_TRACKED_CALLERS) return;
    for (const [caller, entry] of counts) {
      if (now > entry.resetAt) counts.delete(caller);
    }
  }

  return {
    hit(key, windowMs, max) {
      const now = Date.now();
      const entry = counts.get(key);

      if (!entry || now > entry.resetAt) {
        prune(now);
        counts.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      if (entry.count >= max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
        };
      }

      entry.count++;
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

/**
 * Counts in the database, shared by every instance. A serverless host runs
 * each request wherever it likes, so counts in memory would start from zero
 * on every one of them.
 */
export function databaseStore(): RateLimitStore {
  return {
    async hit(key, windowMs, max) {
      const { data, error } = await getSupabase().rpc("hit_rate_limit", {
        p_key: key,
        p_window_ms: windowMs,
        p_max: max,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      return {
        allowed: Boolean(row?.allowed),
        retryAfterSeconds: Number(row?.retry_after_seconds ?? 0),
      };
    },
  };
}

function defaultStore(): RateLimitStore {
  return isSupabaseConfigured() && process.env.RATE_LIMIT_STORE !== "memory"
    ? databaseStore()
    : memoryStore();
}

/**
 * Slow down whoever is hammering a route, counted per caller.
 *
 * Reads are never counted. Asking whether an account has a passkey, or what
 * the policy state is, reveals nothing and happens on every visit, so counting
 * it meant a handful of ordinary attempts could lock someone out of their own
 * account for a minute.
 *
 * If the store cannot be reached the request goes through. The limiter is a
 * brake on abuse, not what protects the account: every owner action still
 * needs the passkey, and every payment still has to pass the contract.
 */
export function createRateLimit({ windowMs, max, scope = "api", store }: RateLimitOptions) {
  const counts = store ?? defaultStore();

  function refuse(res: Response, seconds: number): void {
    // Saying how long turns a dead button into a wait.
    res.setHeader("Retry-After", String(seconds));
    res.status(429).json({
      error: `too many attempts, try again in ${seconds} seconds`,
    });
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (req.method === "GET") {
      next();
      return;
    }

    const caller = req.ip || req.socket.remoteAddress || "unknown";
    const key = `${scope}:${caller}`;

    let verdict: Verdict | Promise<Verdict>;
    try {
      verdict = counts.hit(key, windowMs, max);
    } catch (err) {
      console.error("rate limit store failed, letting the request through:", err);
      next();
      return;
    }

    if (!(verdict instanceof Promise)) {
      if (verdict.allowed) next();
      else refuse(res, verdict.retryAfterSeconds);
      return;
    }

    verdict.then(
      (v) => (v.allowed ? next() : refuse(res, v.retryAfterSeconds)),
      (err) => {
        console.error("rate limit store failed, letting the request through:", err);
        next();
      }
    );
  };
}
