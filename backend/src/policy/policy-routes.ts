import express, { type Request, type Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = process.env.POLICY_CONTRACT_ID || "";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

// authenticated session store (in-memory for testnet MVP)
const authenticatedSessions = new Set<string>();

export function markAuthenticated(sessionId: string) {
  authenticatedSessions.add(sessionId);
}

export function isAuthenticated(sessionId: string): boolean {
  return authenticatedSessions.has(sessionId);
}

function getSessionId(req: Request): string {
  return req.headers["x-session-id"] as string || "default";
}

async function callContractView(functionName: string, args: StellarSdk.xdr.ScVal[] = []) {
  const server = new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);

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
  if (StellarSdk.SorobanRpc.Api.isSimulationError(response)) {
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
    const fields = retval.value();
    if (!Array.isArray(fields)) return result;
    for (const field of fields) {
      try {
        const entry = field.value();
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const key = String(entry[0].value());
        const val = entry[1].value();
        result.set(key, val);
      } catch {
        continue;
      }
    }
  } catch {
    // return empty map
  }
  return result;
}

async function submitContractCall(
  functionName: string,
  args: StellarSdk.xdr.ScVal[] = []
) {
  const sourceSecret = process.env.OWNER_SECRET;
  if (!sourceSecret) {
    throw new Error("OWNER_SECRET environment variable is required");
  }

  const sourceKeypair = StellarSdk.Keypair.fromSecret(sourceSecret);
  const server = new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
  const sourceAccount = await server.getAccount(sourceKeypair.publicKey());

  const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: functionName,
        args,
      })
    )
    .setTimeout(300)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(simulated)) {
    throw new Error(`simulation failed: ${simulated.error}`);
  }

  const prepared = StellarSdk.SorobanRpc.assembleTransaction(
    tx,
    simulated as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse
  ).build();
  prepared.sign(sourceKeypair);

  const sendResponse = await server.sendTransaction(prepared);

  if (sendResponse.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(sendResponse)}`);
  }

  // poll for confirmation (max 30 attempts)
  let getResponse = await server.getTransaction(sendResponse.hash);
  let attempts = 0;
  while (getResponse.status === "NOT_FOUND" && attempts < 30) {
    await new Promise((r) => setTimeout(r, 1000));
    getResponse = await server.getTransaction(sendResponse.hash);
    attempts++;
  }

  if (getResponse.status !== "SUCCESS") {
    throw new Error(`transaction failed: ${getResponse.status}`);
  }

  return { txHash: sendResponse.hash };
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

      res.json({
        frozen,
        agentSigner,
        velocityTxCount,
        velocityTotalAmount,
        contractId: CONTRACT_ID,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/api/policy/freeze", async (req: Request, res: Response) => {
    const session = getSessionId(req);
    if (!isAuthenticated(session)) {
      res.status(401).json({ success: false, error: "authentication required" });
      return;
    }

    try {
      const result = await submitContractCall("freeze_payments");
      res.json({ success: true, txHash: result.txHash });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post("/api/policy/restore", async (req: Request, res: Response) => {
    const session = getSessionId(req);
    if (!isAuthenticated(session)) {
      res.status(401).json({ success: false, error: "authentication required" });
      return;
    }

    try {
      const result = await submitContractCall("restore_payments");
      res.json({ success: true, txHash: result.txHash });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  router.post("/api/policy/revoke", async (req: Request, res: Response) => {
    const session = getSessionId(req);
    if (!isAuthenticated(session)) {
      res.status(401).json({ success: false, error: "authentication required" });
      return;
    }

    try {
      const result = await submitContractCall("revoke_agent_signer");
      res.json({ success: true, txHash: result.txHash });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  return router;
}
