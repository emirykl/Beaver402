import express, { type Request, type Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import {
  isOwnerAction,
  prepareOwnerAction,
  submitOwnerAction,
  OWNER_ACTIONS,
} from "./owner-actions.js";

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.POLICY_CONTRACT_ID || "";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export async function markAuthenticated(sessionId: string) {
  if (!isSupabaseConfigured()) {
    return;
  }
  const supabase = getSupabase();
  await supabase.from("sessions").upsert({
    id: sessionId,
    authenticated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
}

export async function isAuthenticated(sessionId: string): Promise<boolean> {
  if (!isSupabaseConfigured()) {
    return false;
  }
  const supabase = getSupabase();
  const { data } = await supabase
    .from("sessions")
    .select("id, expires_at")
    .eq("id", sessionId)
    .single();

  if (!data) return false;
  return new Date(data.expires_at) > new Date();
}

function getSessionId(req: Request): string {
  return req.headers["x-session-id"] as string || "default";
}

async function callContractView(functionName: string, args: StellarSdk.xdr.ScVal[] = []) {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);

  const account = new StellarSdk.Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: functionName,
        args,
      })
    )
    .setTimeout(30)
    .build();

  const response = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(response)) {
    throw new Error(`simulation failed: ${response.error}`);
  }
  return response;
}

function getRetval(sim: Awaited<ReturnType<typeof callContractView>>): StellarSdk.xdr.ScVal | null {
  if ("result" in sim && sim.result?.retval) {
    return sim.result.retval;
  }
  return null;
}

async function safeContractBool(fn: string): Promise<boolean> {
  try {
    const sim = await callContractView(fn);
    const retval = getRetval(sim);
    if (!retval) return false;
    return retval.switch().name === "scvBool" && retval.value() === true;
  } catch {
    return false;
  }
}

function extractBytes(sim: Awaited<ReturnType<typeof callContractView>>): string | null {
  const retval = getRetval(sim);
  if (!retval) return null;
  try {
    const raw = retval.value();
    if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
      return Buffer.from(raw).toString("hex");
    }
    return null;
  } catch {
    return null;
  }
}

function extractMap(sim: Awaited<ReturnType<typeof callContractView>>): Map<string, unknown> {
  const result = new Map<string, unknown>();
  const retval = getRetval(sim);
  if (!retval) return result;
  try {
    // Contract structs come back as ScVal maps. Letting the SDK convert them
    // keeps the numeric fields as bigints instead of raw XDR wrappers.
    const native = StellarSdk.scValToNative(retval);
    if (native && typeof native === "object" && !Array.isArray(native)) {
      for (const [key, value] of Object.entries(native)) {
        result.set(key, value);
      }
    }
  } catch {
    // return empty map
  }
  return result;
}

/**
 * Values that hardly ever change, kept for a few seconds.
 *
 * The control panel refreshes after every action, and each refresh was
 * making five calls to the network. The velocity limit and the merchant
 * allowlist only move when the owner moves them, so asking every time is
 * what pushes the node into refusing.
 */
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit.value as T;
  }

  const value = await read();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Forget the cache after an owner action, since one may have changed it. */
function invalidateCache(): void {
  cache.clear();
}

/** Whether the owner has approved the merchant this backend demonstrates. */
async function isDemoMerchantApproved(): Promise<boolean> {
  const secret = process.env.MERCHANT_SECRET;
  if (!secret) return false;

  try {
    const raw = StellarSdk.StrKey.decodeEd25519PublicKey(
      StellarSdk.Keypair.fromSecret(secret).publicKey()
    );
    const sim = await callContractView("is_merchant", [
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(raw)),
    ]);
    const retval = getRetval(sim);
    return retval?.switch().name === "scvBool" && retval.value() === true;
  } catch {
    return false;
  }
}

async function readMaxTxCount(): Promise<number> {
  try {
    const sim = await callContractView("get_velocity_config");
    const parsed = extractMap(sim);
    return Number(parsed.get("max_tx_count") ?? 0);
  } catch {
    return 0;
  }
}

export function createPolicyRouter() {
  const router = express.Router();

  router.get("/api/policy/state", async (_req: Request, res: Response) => {
    if (!CONTRACT_ID) {
      res.json({
        frozen: false,
        agentSigner: null,
        velocityTxCount: 0,
        velocityTotalAmount: "0",
        contractId: "not deployed",
        merchantApproved: false,
        velocityMaxTxCount: 0,
      });
      return;
    }

    try {
      // query contract state through simulation
      const frozen = await safeContractBool("is_frozen");

      let agentSigner: string | null = null;
      try {
        const signerSim = await callContractView("get_agent_signer");
        agentSigner = extractBytes(signerSim);
      } catch {
        agentSigner = null; // signer revoked or not set
      }

      let velocityTxCount = 0;
      let velocityTotalAmount = "0";
      try {
        const velSim = await callContractView("get_velocity_state");
        const parsed = extractMap(velSim);
        velocityTxCount = Number(parsed.get("tx_count") ?? 0);
        velocityTotalAmount = String(parsed.get("total_amount") ?? "0");
      } catch {
        // use defaults
      }

      // The control panel needs these to tell the owner what is still to do
      // and how much of the budget is left.
      const merchantApproved = await cached("merchant", isDemoMerchantApproved);
      const velocityMaxTxCount = await cached("maxTxCount", readMaxTxCount);

      res.json({
        frozen,
        agentSigner,
        velocityTxCount,
        velocityTotalAmount,
        contractId: CONTRACT_ID,
        merchantApproved,
        velocityMaxTxCount,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Owner actions take two calls. The first works out what the passkey has
  // to sign, the second carries the assertion back. The session check is a
  // gate on the interface; the authority itself comes from the passkey, and
  // the contract is what enforces that.
  router.post("/api/policy/prepare", async (req: Request, res: Response) => {
    const session = getSessionId(req);
    if (!(await isAuthenticated(session))) {
      res.status(401).json({ success: false, error: "authentication required" });
      return;
    }

    const action = String(req.body?.action ?? "");
    if (!isOwnerAction(action)) {
      res.status(400).json({
        success: false,
        error: `action must be one of ${OWNER_ACTIONS.join(", ")}`,
      });
      return;
    }

    try {
      const prepared = await prepareOwnerAction(
        action,
        CONTRACT_ID,
        feeSource(),
        req.body?.merchantPubkey
      );
      res.json({ success: true, prepared });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post("/api/policy/submit", async (req: Request, res: Response) => {
    const session = getSessionId(req);
    if (!(await isAuthenticated(session))) {
      res.status(401).json({ success: false, error: "authentication required" });
      return;
    }

    const { prepared, assertion } = req.body ?? {};
    if (!prepared?.authEntry || !assertion?.signature) {
      res.status(400).json({
        success: false,
        error: "prepared action and passkey assertion are both required",
      });
      return;
    }

    try {
      const result = await submitOwnerAction(
        prepared,
        assertion,
        CONTRACT_ID,
        StellarSdk.Keypair.fromSecret(requireFeeSecret())
      );
      invalidateCache();
      res.json({ success: true, txHash: result.txHash });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}

/**
 * The account that pays for owner actions. It funds the transaction and
 * nothing else, so it cannot approve anything on the owner's behalf.
 */
function requireFeeSecret(): string {
  const secret = process.env.FEE_SOURCE_SECRET || process.env.OWNER_SECRET;
  if (!secret) {
    throw new Error("FEE_SOURCE_SECRET is required to pay for owner actions");
  }
  return secret;
}

function feeSource(): string {
  return StellarSdk.Keypair.fromSecret(requireFeeSecret()).publicKey();
}
