import * as StellarSdk from "@stellar/stellar-sdk";

import {
  buildOwnerSignatureScVal,
  toWebAuthnChallenge,
  type OwnerAssertion,
} from "../passkey/owner-signature.js";
import { network, rpcServer, verifyNetwork } from "../config/network.js";

const BASE_FEE = "10000000";
const AUTH_VALIDITY_LEDGERS = 60;

/** The owner functions the control panel can invoke. */
export const OWNER_ACTIONS = [
  "freeze_payments",
  "restore_payments",
  "revoke_agent_signer",
  "set_agent_signer",
  "add_merchant",
  "remove_merchant",
  "reduce_limits",
  "recover_funds",
] as const;

export type OwnerAction = (typeof OWNER_ACTIONS)[number];

/** The owner actions that name an ed25519 key. The rest take nothing. */
const ACTIONS_TAKING_A_KEY: readonly OwnerAction[] = [
  "add_merchant",
  "remove_merchant",
  "set_agent_signer",
];

export function isOwnerAction(value: string): value is OwnerAction {
  return (OWNER_ACTIONS as readonly string[]).includes(value);
}

/** A key reaches us either as a Stellar G address or as raw hex. */
function toRawPubkey(value: string): Buffer {
  return /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(StellarSdk.StrKey.decodeEd25519PublicKey(value));
}

/**
 * The signer this backend would use, so restoring the agent does not ask the
 * owner to type a key. Naming one explicitly still works, which is what a
 * rotation to a different backend would do.
 */
function configuredAgentPubkey(): string {
  const secret = process.env.AGENT_SECRET;
  if (!secret) {
    throw new Error(
      "set_agent_signer needs a public key, and AGENT_SECRET is not set to fall back on"
    );
  }
  return StellarSdk.Keypair.fromSecret(secret).publicKey();
}

/** New limits, as the panel sends them. Amounts are in stroops. */
export interface LimitsInput {
  maxPaymentAmount: string;
  maxTxCount: number;
  maxTotalAmount: string;
  windowSize: number;
}

/** What an owner action may carry besides its name. */
export interface OwnerActionInput {
  /** A merchant or agent key, for the actions that name one. */
  pubkey?: string;
  /** For reduce_limits. */
  limits?: LimitsInput;
  /** For recover_funds. Defaults to the account's USDC. */
  token?: string;
}

/**
 * The contract's VelocityConfig. A struct travels as a map whose keys have
 * to be in sorted order.
 */
export function limitsToScVal(limits: LimitsInput): StellarSdk.xdr.ScVal {
  const whole = (value: string | number, label: string): bigint => {
    const text = String(value);
    if (!/^\d+$/.test(text)) {
      throw new Error(`${label} has to be a whole positive number, got ${text}`);
    }
    return BigInt(text);
  };

  const fields: Record<string, StellarSdk.xdr.ScVal> = {
    max_payment_amount: StellarSdk.nativeToScVal(whole(limits.maxPaymentAmount, "maxPaymentAmount"), { type: "i128" }),
    max_total_amount: StellarSdk.nativeToScVal(whole(limits.maxTotalAmount, "maxTotalAmount"), { type: "i128" }),
    max_tx_count: StellarSdk.nativeToScVal(Number(whole(limits.maxTxCount, "maxTxCount")), { type: "u32" }),
    window_size: StellarSdk.nativeToScVal(whole(limits.windowSize, "windowSize"), { type: "u64" }),
  };

  return StellarSdk.xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol(key), val: fields[key]! }))
  );
}

export function argsFor(
  action: OwnerAction,
  input: string | OwnerActionInput = {}
): StellarSdk.xdr.ScVal[] {
  const { pubkey, limits, token } = typeof input === "string" ? { pubkey: input } : input;

  if (action === "reduce_limits") {
    if (!limits) {
      throw new Error("reduce_limits needs the new limits");
    }
    return [limitsToScVal(limits)];
  }

  if (action === "recover_funds") {
    const target = token ?? network().usdcContract;
    if (!StellarSdk.StrKey.isValidContract(target)) {
      throw new Error(`recover_funds needs a token contract address, got ${target}`);
    }
    return [StellarSdk.Address.fromString(target).toScVal()];
  }

  if (!ACTIONS_TAKING_A_KEY.includes(action)) {
    return [];
  }

  const key =
    pubkey ?? (action === "set_agent_signer" ? configuredAgentPubkey() : undefined);
  if (!key) {
    throw new Error(`${action} needs a public key`);
  }

  return [StellarSdk.xdr.ScVal.scvBytes(toRawPubkey(key))];
}

export interface PreparedOwnerAction {
  action: OwnerAction;
  /** Carried back on submit so the same call is rebuilt exactly. */
  args: string[];
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
  feeSource: string,
  input: string | OwnerActionInput = {}
): Promise<PreparedOwnerAction> {
  const args = argsFor(action, input);
  await verifyNetwork();
  const server = rpcServer();
  const passphrase = network().passphrase;
  const account = await server.getAccount(feeSource);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: contractId,
        function: action,
        args,
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
    passphrase
  );
  const payload = StellarSdk.hash(preimage.toXDR());

  return {
    action,
    args: args.map((arg) => arg.toXDR("base64")),
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
  await verifyNetwork();
  const server = rpcServer();
  const passphrase = network().passphrase;
  const account = await server.getAccount(feeKeypair.publicKey());

  const entry = StellarSdk.xdr.SorobanAuthorizationEntry.fromXDR(
    prepared.authEntry,
    "base64"
  );

  const signed = await StellarSdk.authorizeEntry(
    entry,
    async () => ({ signatureScVal: buildOwnerSignatureScVal(assertion) }),
    prepared.validUntilLedger,
    passphrase
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: contractId,
        function: prepared.action,
        args: prepared.args.map((arg) =>
          StellarSdk.xdr.ScVal.fromXDR(arg, "base64")
        ),
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
