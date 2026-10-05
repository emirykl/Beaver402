import express, { type Request, type Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { isAuthenticated } from "../lib/sessions.js";
import { createRateLimit } from "../lib/rate-limit.js";
import { network, rpcServer, explorerContract } from "../config/network.js";
import { describeOwnerActionError } from "../shared/policy-errors.js";
import { failPublicly, redact } from "../lib/public-error.js";
import { enabledChains, isChainEnabled } from "../chains/registry.js";
import { solana, solanaExplorerAccount } from "../chains/solana/config.js";
import {
  isSolanaOwnerAction,
  prepareSolanaOwnerAction,
  readPolicyAccount,
  submitSolanaOwnerAction,
} from "../chains/solana/owner-actions.js";
import { velocityState } from "../chains/solana/policy-account.js";
import { solanaAddressOf } from "../chains/solana/program.js";
import {
  isOwnerAction,
  prepareOwnerAction,
  submitOwnerAction,
  OWNER_ACTIONS,
} from "./owner-actions.js";

function contractId(): string {
  return process.env.POLICY_CONTRACT_ID || "";
}

/**
 * The session the caller is claiming. A missing header is nobody, which the
 * session lookup then refuses, rather than a shared name everyone can guess.
 */
function getSessionId(req: Request): string {
  const header = req.headers["x-session-id"];
  return typeof header === "string" ? header : "";
}

async function callContractView(functionName: string, args: StellarSdk.xdr.ScVal[] = []) {
  const server = rpcServer();

  const account = new StellarSdk.Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: network().passphrase,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: contractId(),
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

/**
 * The merchant this deployment works with, as a public key.
 *
 * The merchant runs as its own service with its own secret, so this backend
 * is told the public key. A single process running both halves for local
 * development can still derive it from the secret.
 */
function merchantPublicKey(): string | null {
  if (process.env.MERCHANT_PUBKEY) return process.env.MERCHANT_PUBKEY;
  const secret = process.env.MERCHANT_SECRET;
  return secret ? StellarSdk.Keypair.fromSecret(secret).publicKey() : null;
}

/** Whether the owner has approved the merchant this deployment uses. */
async function isMerchantApproved(): Promise<boolean> {
  const pubkey = merchantPublicKey();
  if (!pubkey) return false;

  try {
    const raw = StellarSdk.StrKey.decodeEd25519PublicKey(pubkey);
    const sim = await callContractView("is_merchant", [
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(raw)),
    ]);
    const retval = getRetval(sim);
    return retval?.switch().name === "scvBool" && retval.value() === true;
  } catch {
    return false;
  }
}

export interface LimitsReading {
  maxPaymentAmount: string;
  maxTxCount: number;
  maxTotalAmount: string;
  windowSize: number;
}

async function readLimits(): Promise<LimitsReading | null> {
  try {
    const parsed = extractMap(await callContractView("get_velocity_config"));
    if (parsed.size === 0) return null;
    return {
      maxPaymentAmount: String(parsed.get("max_payment_amount") ?? "0"),
      maxTxCount: Number(parsed.get("max_tx_count") ?? 0),
      maxTotalAmount: String(parsed.get("max_total_amount") ?? "0"),
      windowSize: Number(parsed.get("window_size") ?? 0),
    };
  } catch {
    return null;
  }
}

/** The Solana side of the account, the same shape the panel reads. */
export async function readSolanaPolicyState() {
  const config = solana();
  if (!config.policy) {
    return {
      chain: "solana",
      frozen: false,
      agentSigner: null,
      velocityTxCount: 0,
      velocityTotalAmount: "0",
      velocityWindowStart: 0,
      contractId: "not deployed",
      merchantApproved: false,
      velocityMaxTxCount: 0,
      limits: null,
    };
  }
  const account = await readPolicyAccount(config);
  const window = velocityState(account, Math.floor(Date.now() / 1000));
  const merchant = merchantPublicKey();
  return {
    chain: "solana",
    frozen: account.frozen,
    agentSigner: account.agentSigner,
    velocityTxCount: window.txCount,
    velocityTotalAmount: window.totalAmount,
    velocityWindowStart: window.windowStart,
    contractId: config.policy,
    merchantApproved: merchant ? account.merchants.includes(solanaAddressOf(merchant)) : false,
    velocityMaxTxCount: account.limits.maxTxCount,
    limits: account.limits,
  };
}

function solanaPublicConfig() {
  const config = solana();
  const merchant = merchantPublicKey();
  return {
    cluster: config.cluster,
    caip2: config.caip2,
    explorer: config.explorer,
    programId: config.programId,
    policy: config.policy,
    policyUrl: config.policy ? solanaExplorerAccount(config.policy) : null,
    asset: config.usdcMint,
    decimals: config.usdcDecimals,
    merchantPubkey: merchant ? solanaAddressOf(merchant) : null,
  };
}

/** What the public may see about the deployment. Nothing here is secret. */
export function publicConfig() {
  const config = network();
  const id = contractId();
  const chains = enabledChains();
  return {
    chains,
    ...(chains.includes("solana") ? { solana: solanaPublicConfig() } : {}),
    network: config.name,
    caip2: config.caip2,
    explorer: config.explorer,
    contractId: id || null,
    contractUrl: id ? explorerContract(id) : null,
    asset: config.usdcContract,
    facilitator: config.facilitatorUrl,
    merchantPubkey: merchantPublicKey(),
  };
}

/** Everything the panel and the status page show about the account. */
export async function readPolicyState() {
  if (!contractId()) {
    return {
      frozen: false,
      agentSigner: null,
      velocityTxCount: 0,
      velocityTotalAmount: "0",
      velocityWindowStart: 0,
      contractId: "not deployed",
      merchantApproved: false,
      velocityMaxTxCount: 0,
      limits: null,
    };
  }

  // query contract state through simulation
  const frozen = await safeContractBool("is_frozen");

  let agentSigner: string | null = null;
  try {
    const signerSim = await callContractView("get_agent_signer");
    agentSigner = extractBytes(signerSim);
  } catch {
    agentSigner = null; // signer revoked or not set
  }

  // The contract works the window out itself, at the time of the ledger the
  // simulation runs against, so what it reports is what it will apply to the
  // next payment.
  let reading = { txCount: 0, totalAmount: "0", windowStart: 0 };
  try {
    const parsed = extractMap(await callContractView("get_velocity_state"));
    reading = {
      txCount: Number(parsed.get("tx_count") ?? 0),
      totalAmount: String(parsed.get("total_amount") ?? "0"),
      windowStart: Number(parsed.get("window_start") ?? 0),
    };
  } catch {
    // use defaults
  }

  // The control panel needs these to tell the owner what is still to do and
  // how much of the budget is left.
  const merchantApproved = await cached("merchant", isMerchantApproved);
  const limits = await cached("limits", readLimits);

  return {
    frozen,
    agentSigner,
    velocityTxCount: reading.txCount,
    velocityTotalAmount: reading.totalAmount,
    velocityWindowStart: reading.windowStart,
    contractId: contractId(),
    merchantApproved,
    velocityMaxTxCount: limits?.maxTxCount ?? 0,
    limits,
  };
}

export function createPolicyRouter() {
  const router = express.Router();

  // Owner actions cost a passkey touch each, so nobody legitimate comes close
  // to this. Reading the state is a GET and stays uncounted, which is what the
  // panel does on every refresh.
  router.use(createRateLimit({ windowMs: 60_000, max: 30, scope: "policy" }));

  router.get("/api/config", (_req: Request, res: Response) => {
    res.json(publicConfig());
  });

  router.get("/api/policy/state", async (req: Request, res: Response) => {
    try {
      if (req.query.chain === "solana") {
        if (!isChainEnabled("solana")) {
          res.status(404).json({ error: "this deployment does not run on Solana" });
          return;
        }
        res.json(await readSolanaPolicyState());
        return;
      }
      res.json(await readPolicyState());
    } catch (err) {
      failPublicly(res, 500, "could not read the account", err);
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
    if (req.body?.chain === "solana") {
      if (!isChainEnabled("solana") || !isSolanaOwnerAction(action)) {
        res.status(400).json({ success: false, error: "not an owner action on Solana here" });
        return;
      }
      try {
        const prepared = await prepareSolanaOwnerAction(action, {
          pubkey: req.body?.pubkey ?? req.body?.merchantPubkey,
          limits: req.body?.limits,
        });
        res.json({ success: true, prepared });
      } catch (err) {
        res.status(500).json({ success: false, error: redact(describeOwnerActionError(String(err))) });
      }
      return;
    }
    if (!isOwnerAction(action)) {
      res.status(400).json({
        success: false,
        error: `action must be one of ${OWNER_ACTIONS.join(", ")}`,
      });
      return;
    }

    try {
      const prepared = await prepareOwnerAction(action, contractId(), feeSource(), {
        pubkey: req.body?.pubkey ?? req.body?.merchantPubkey,
        limits: req.body?.limits,
        token: req.body?.token,
      });
      res.json({ success: true, prepared });
    } catch (err) {
      res.status(500).json({ success: false, error: redact(describeOwnerActionError(String(err))) });
    }
  });

  router.post("/api/policy/submit", async (req: Request, res: Response) => {
    const session = getSessionId(req);
    if (!(await isAuthenticated(session))) {
      res.status(401).json({ success: false, error: "authentication required" });
      return;
    }

    const { prepared, assertion } = req.body ?? {};
    if (prepared?.chain === "solana") {
      if (!isChainEnabled("solana") || !assertion?.signature) {
        res.status(400).json({ success: false, error: "prepared action and passkey assertion are both required" });
        return;
      }
      try {
        const result = await submitSolanaOwnerAction(prepared, assertion, requireFeeSecret());
        res.json({ success: true, txHash: result.txHash });
      } catch (err) {
        res.status(500).json({ success: false, error: redact(describeOwnerActionError(String(err))) });
      }
      return;
    }
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
        contractId(),
        StellarSdk.Keypair.fromSecret(requireFeeSecret())
      );
      invalidateCache();
      res.json({ success: true, txHash: result.txHash });
    } catch (err) {
      res.status(500).json({ success: false, error: redact(describeOwnerActionError(String(err))) });
    }
  });

  return router;
}

/**
 * The account that pays for owner actions. It funds the transaction and
 * nothing else, so it cannot approve anything on the owner's behalf.
 */
function requireFeeSecret(): string {
  const secret = process.env.FEE_SOURCE_SECRET;
  if (!secret) {
    throw new Error("FEE_SOURCE_SECRET is required to pay for owner actions");
  }
  return secret;
}

function feeSource(): string {
  return StellarSdk.Keypair.fromSecret(requireFeeSecret()).publicKey();
}
