import * as StellarSdk from "@stellar/stellar-sdk";

import {
  buildOwnerSignatureScVal,
  toWebAuthnChallenge,
  type OwnerAssertion,
} from "../passkey/owner-signature.js";

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;
const BASE_FEE = "10000000";
const AUTH_VALIDITY_LEDGERS = 60;

/** The owner functions the control panel can invoke. */
export const OWNER_ACTIONS = [
  "freeze_payments",
  "restore_payments",
  "revoke_agent_signer",
] as const;

export type OwnerAction = (typeof OWNER_ACTIONS)[number];

export function isOwnerAction(value: string): value is OwnerAction {
  return (OWNER_ACTIONS as readonly string[]).includes(value);
}

export interface PreparedOwnerAction {
  action: OwnerAction;
  /** What the passkey has to sign, ready to hand to navigator.credentials. */
  challenge: string;
  /** The unsigned authorization entry, carried back on submit. */
  authEntry: string;
  validUntilLedger: number;
}

/**
 * Work out what the owner's passkey needs to sign for an action.
 *
 * The transaction is built and simulated so the host tells us the exact
 * payload it will pass to the account, and that payload becomes the WebAuthn
 * challenge. Nothing is signed or submitted here.
 */
export async function prepareOwnerAction(
  action: OwnerAction,
  contractId: string,
  feeSource: string
): Promise<PreparedOwnerAction> {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const account = await server.getAccount(feeSource);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: contractId,
        function: action,
        args: [],
      })
    )
    .setTimeout(300)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
    throw new Error(`simulation failed: ${simulated.error}`);
  }

  const entries = simulated.result?.auth ?? [];
  const entry = entries[0];
  if (!entry) {
    throw new Error(`${action} produced no authorization entry to sign`);
  }

  const { sequence } = await server.getLatestLedger();
  const validUntilLedger = sequence + AUTH_VALIDITY_LEDGERS;

  const preimage = StellarSdk.buildAuthorizationEntryPreimage(
    entry,
    validUntilLedger,
    NETWORK_PASSPHRASE
  );
  const payload = StellarSdk.hash(preimage.toXDR());

  return {
    action,
    challenge: toWebAuthnChallenge(Buffer.from(payload)),
    authEntry: entry.toXDR("base64"),
    validUntilLedger,
  };
}

/**
 * Finish an owner action with the assertion the browser produced.
 *
 * The passkey authorizes the call. The fee source only pays for it, which is
 * why its key never stands in for the owner's.
 */
export async function submitOwnerAction(
  prepared: PreparedOwnerAction,
  assertion: OwnerAssertion,
  contractId: string,
  feeKeypair: StellarSdk.Keypair
): Promise<{ txHash: string }> {
  const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
  const account = await server.getAccount(feeKeypair.publicKey());

  const entry = StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(
    prepared.authEntry,
    "base64"
  );

  const signed = await StellarSdk.authorizeEntry(
    entry,
    async () => ({ signatureScVal: buildOwnerSignatureScVal(assertion) }),
    prepared.validUntilLedger,
    NETWORK_PASSPHRASE
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: contractId,
        function: prepared.action,
        args: [],
        auth: [signed],
      })
    )
    .setTimeout(300)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
    throw new Error(`the policy refused the action: ${simulated.error}`);
  }

  const prepared_tx = StellarSdk.rpc.assembleTransaction(tx, simulated).build();
  prepared_tx.sign(feeKeypair);

  const sent = await server.sendTransaction(prepared_tx);
  if (sent.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(sent)}`);
  }

  let result = await server.getTransaction(sent.hash);
  let attempts = 0;
  while (result.status === "NOT_FOUND" && attempts < 30) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await server.getTransaction(sent.hash);
    attempts += 1;
  }

  if (result.status !== "SUCCESS") {
    throw new Error(`transaction ${result.status}`);
  }

  return { txHash: sent.hash };
}
