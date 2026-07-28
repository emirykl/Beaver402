import express, { type Request, type Response } from "express";
import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
  getUserCredentials,
} from "./webauthn-server.js";

export function createPasskeyRouter() {
  const router = express.Router();

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
