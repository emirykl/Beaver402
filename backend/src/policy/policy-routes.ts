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

  // poll for confirmation
  let getResponse = await server.getTransaction(sendResponse.hash);
  while (getResponse.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    getResponse = await server.getTransaction(sendResponse.hash);
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
      const frozenSim = await callContractView("is_frozen");
      const frozen =
        "result" in frozenSim &&
        frozenSim.result?.retval?.value() === true;

      let agentSigner: string | null = null;
      try {
        const signerSim = await callContractView("get_agent_signer");
        if ("result" in signerSim && signerSim.result?.retval) {
          const raw = signerSim.result.retval.value();
          if (raw && typeof raw === "object" && "toString" in raw) {
            agentSigner = Buffer.from(raw as Buffer).toString("hex");
          }
        }
      } catch {
        agentSigner = null; // signer revoked
      }

      let velocityTxCount = 0;
      let velocityTotalAmount = "0";
      try {
        const velSim = await callContractView("get_velocity_state");
        if ("result" in velSim && velSim.result?.retval) {
          const fields = velSim.result.retval.value();
          if (Array.isArray(fields)) {
            for (const field of fields) {
              const entry = field.value();
              const key = entry[0].value().toString();
              const val = entry[1].value();
              if (key === "tx_count") velocityTxCount = Number(val);
              if (key === "total_amount") velocityTotalAmount = String(val);
            }
          }
        }
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
