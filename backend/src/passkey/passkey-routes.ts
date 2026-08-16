import express, { type Request, type Response, type NextFunction } from "express";
import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
  getUserCredentials,
} from "./webauthn-server.js";

/**
 * Slow down guessing at the ceremonies, per address.
 *
 * Only the ceremonies are counted. Asking whether an account has a passkey
 * reveals nothing and happens on every visit, so counting it meant a handful
 * of ordinary sign in attempts could lock someone out of their own account
 * for a minute.
 */
const rateLimitWindow = 60_000;
const maxRequests = 30;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET") {
    next();
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + rateLimitWindow });
    next();
    return;
  }

  if (entry.count >= maxRequests) {
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
}

export function createPasskeyRouter() {
  const router = express.Router();
  router.use(rateLimit);

  router.post("/api/passkey/register/start", async (req: Request, res: Response) => {
    try {
      const { userId, userName } = req.body;
      if (!userId || !userName) {
        res.status(400).json({ error: "userId and userName are required" });
        return;
      }
      const options = await startRegistration(userId, userName);
      res.json(options);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/api/passkey/register/finish", async (req: Request, res: Response) => {
    try {
      const { userId, credential } = req.body;
      if (!userId || !credential) {
        res.status(400).json({ error: "userId and credential are required" });
        return;
      }
      const result = await finishRegistration(userId, credential);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/api/passkey/auth/start", async (req: Request, res: Response) => {
    try {
      const { userId } = req.body;
      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }
      const options = await startAuthentication(userId);
      res.json(options);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/api/passkey/auth/finish", async (req: Request, res: Response) => {
    try {
      const { userId, credential } = req.body;
      if (!userId || !credential) {
        res.status(400).json({ error: "userId and credential are required" });
        return;
      }
      const result = await finishAuthentication(userId, credential);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/api/passkey/credentials/:userId", async (req: Request, res: Response) => {
    try {
      const creds = await getUserCredentials(String(req.params.userId));
      res.json({ count: creds.length, hasCredentials: creds.length > 0 });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
