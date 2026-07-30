import express, { type Request, type Response, type NextFunction } from "express";
import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
  getUserCredentials,
} from "./webauthn-server.js";

// simple per-IP rate limiter for auth endpoints
const rateLimitWindow = 60_000; // 1 minute
const maxRequests = 10;
const requestCounts = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = requestCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + rateLimitWindow });
    next();
    return;
  }

  if (entry.count >= maxRequests) {
    res.status(429).json({ error: "too many requests, try again later" });
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

  router.get("/api/passkey/credentials/:userId", (req: Request, res: Response) => {
    const creds = getUserCredentials(req.params.userId);
    res.json({ count: creds.length, hasCredentials: creds.length > 0 });
  });

  return router;
}
