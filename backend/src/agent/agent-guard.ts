import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { network } from "../config/network.js";

/**
 * Who may ask the agent to pay, and for what.
 *
 * The agent route spends from the policy account. The contract bounds what
 * it can spend, but on a public host anyone who could reach the route could
 * make it spend up to those bounds, so on mainnet the route needs a token
 * and only fetches from merchants it was told about.
 */
export interface AgentAccess {
  /** The bearer token callers have to present. */
  token: string | null;
  /** Origins the agent may fetch from, or null for any. */
  allowedOrigins: string[] | null;
}

type Env = Record<string, string | undefined>;

export function loadAgentAccess(env: Env = process.env): AgentAccess {
  const token = env.AGENT_API_TOKEN || null;
  const allowedOrigins = env.AGENT_ALLOWED_ORIGINS
    ? env.AGENT_ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map((origin) => new URL(origin).origin)
    : null;

  if (network().name === "mainnet") {
    if (!token || token.length < 32) {
      throw new Error("AGENT_API_TOKEN of at least 32 characters is required on mainnet");
    }
    if (!allowedOrigins || allowedOrigins.length === 0) {
      throw new Error("AGENT_ALLOWED_ORIGINS is required on mainnet");
    }
  }

  return { token, allowedOrigins };
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Refuse callers without the token. */
export function requireAgentToken(access: AgentAccess) {
  return function agentToken(req: Request, res: Response, next: NextFunction): void {
    if (!access.token) {
      next();
      return;
    }
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!presented || !sameSecret(presented, access.token)) {
      res.status(401).json({ error: "a valid agent token is required" });
      return;
    }
    next();
  };
}

/** Whether the agent may fetch this URL at all. */
export function isAllowedUrl(access: AgentAccess, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  if (network().name === "mainnet" && parsed.protocol !== "https:") {
    return false;
  }
  return access.allowedOrigins === null || access.allowedOrigins.includes(parsed.origin);
}
