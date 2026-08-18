import express, { type Request, type Response } from "express";
import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
  getUserCredentials,
} from "./webauthn-server.js";
import { createSession } from "../lib/sessions.js";
import { createRateLimit } from "../lib/rate-limit.js";

export function createPasskeyRouter() {
  const router = express.Router();
  // Enough for anyone signing in, not enough to guess at a ceremony.
  router.use(createRateLimit({ windowMs: 60_000, max: 30 }));

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
      // Enrolling proves the same thing signing in does: the passkey is on
      // this device and someone touched it.
      res.json({ ...result, sessionId: await createSession() });
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
      // The session is issued here, where the assertion was actually checked,
      // so it cannot be claimed by anyone who never held the passkey.
      res.json({ ...result, sessionId: await createSession() });
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
