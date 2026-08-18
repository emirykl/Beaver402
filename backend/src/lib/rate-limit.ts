import type { Request, Response, NextFunction } from "express";

export interface RateLimitOptions {
  /** How long a window lasts, in milliseconds. */
  windowMs: number;
  /** How many counted requests one caller may make inside a window. */
  max: number;
}

/** Stop the table from growing a row per caller forever. */
const MAX_TRACKED_CALLERS = 1000;

/**
 * Slow down whoever is hammering a route, counted per caller.
 *
 * Reads are never counted. Asking whether an account has a passkey, or what
 * the policy state is, reveals nothing and happens on every visit, so counting
 * it meant a handful of ordinary attempts could lock someone out of their own
 * account for a minute.
 *
 * The counters live in memory, which is enough for one process and is not
 * pretending to be more than that.
 */
export function createRateLimit({ windowMs, max }: RateLimitOptions) {
  const counts = new Map<string, { count: number; resetAt: number }>();

  function prune(now: number): void {
    if (counts.size < MAX_TRACKED_CALLERS) return;
    for (const [caller, entry] of counts) {
      if (now > entry.resetAt) counts.delete(caller);
    }
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (req.method === "GET") {
      next();
      return;
    }

    const caller = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = counts.get(caller);

    if (!entry || now > entry.resetAt) {
      prune(now);
      counts.set(caller, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (entry.count >= max) {
      // Saying how long turns a dead button into a wait.
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(seconds));
      res.status(429).json({
        error: `too many attempts, try again in ${seconds} seconds`,
      });
      return;
    }

    entry.count++;
    next();
  };
}
