import { createHash } from "node:crypto";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
} from "@solana/kit";

import { Keypair } from "@stellar/stellar-sdk";

import { derToRawSignature, toWebAuthnChallenge, type OwnerAssertion } from "../../passkey/owner-signature.js";
import { solanaOwnerChallenge, type SolanaLimits } from "./encoding.js";
import {
  requirePolicy,
  solana,
  solanaErrorText,
  solanaRpc,
  verifySolanaNetwork,
  type SolanaConfig,
  type SolanaRpc,
} from "./config.js";
import { decodePolicyAccount, type PolicyAccount } from "./policy-account.js";
import {
  associatedToken,
  computeUnitLimit,
  ownerActionArgs,
  ownerInstruction,
  secp256r1Instruction,
  solanaKeyPair,
  SOLANA_OWNER_ACTIONS,
  solanaAddressOf,
  type OwnerActionInput,
  type SolanaOwnerAction,
} from "./program.js";

/** How long a prepared action stays signable. The program allows 600. */
const VALIDITY_SECONDS = 300;

export function isSolanaOwnerAction(value: string): value is SolanaOwnerAction {
  return (SOLANA_OWNER_ACTIONS as readonly string[]).includes(value);
}

/** What the panel sends, the same shape as on Stellar. */
export interface SolanaActionInput {
  pubkey?: string;
  limits?: SolanaLimits;
}

export interface PreparedSolanaAction {
  chain: "solana";
  action: SolanaOwnerAction;
  /** The key the action names, in base58. */
  pubkey?: string;
  limits?: SolanaLimits;
  validUntil: string;
  /** The account's counter the challenge was made for. */
  ownerNonce: string;
  /** What the passkey has to sign, ready to hand to navigator.credentials. */
  challenge: string;
}

export async function readPolicyAccount(
  config: SolanaConfig = solana(),
  rpc: SolanaRpc = solanaRpc(config)
): Promise<PolicyAccount> {
  const policy = requirePolicy(config);
  const { value } = await rpc.getAccountInfo(policy, { encoding: "base64", commitment: "confirmed" }).send();
  if (!value) {
    throw new Error(`the policy account ${policy} does not exist on ${config.cluster}`);
  }
  if (value.owner !== config.programId) {
    throw new Error(`${policy} is not owned by the Beaver402 program`);
  }
  return decodePolicyAccount(Buffer.from(value.data[0], "base64"));
}

/** A key the panel names, as a Stellar G address or a Solana address. */
function toAddress(value: string): Address {
  return /^G[A-Z2-7]{55}$/.test(value) ? solanaAddressOf(value) : address(value);
}

function resolveInput(action: SolanaOwnerAction, input: SolanaActionInput): OwnerActionInput {
  const resolved: OwnerActionInput = {};
  if (action === "set_agent_signer" || action === "add_merchant" || action === "remove_merchant") {
    let pubkey = input.pubkey;
    if (!pubkey && action === "set_agent_signer") {
      // Restoring the agent this backend runs needs no typing.
      const secret = process.env.AGENT_SECRET;
      if (!secret) throw new Error("set_agent_signer needs a public key, and AGENT_SECRET is not set to fall back on");
      pubkey = Keypair.fromSecret(secret).publicKey();
    }
    if (!pubkey) throw new Error(`${action} needs a public key`);
    resolved.pubkey = toAddress(pubkey);
  }
  if (action === "reduce_limits") {
    if (!input.limits) throw new Error("reduce_limits needs the new limits");
    resolved.limits = input.limits;
  }
  return resolved;
}

/**
 * Work out what the owner's passkey has to sign for an action. The
 * challenge covers the program, the account, the action, its arguments, the
 * account's counter and a deadline, so the assertion authorizes this one
 * call and nothing else.
 */
export async function prepareSolanaOwnerAction(
  action: SolanaOwnerAction,
  input: SolanaActionInput,
  config: SolanaConfig = solana(),
  rpc: SolanaRpc = solanaRpc(config),
  now: number = Math.floor(Date.now() / 1000)
): Promise<PreparedSolanaAction> {
  await verifySolanaNetwork(config, rpc);
  const resolved = resolveInput(action, input);
  const account = await readPolicyAccount(config, rpc);
  const validUntil = BigInt(now + VALIDITY_SECONDS);
  const challenge = solanaOwnerChallenge({
    programId: config.programId,
    policy: requirePolicy(config),
    action,
    args: ownerActionArgs(action, resolved),
    ownerNonce: account.ownerNonce,
    validUntil,
  });
  return {
    chain: "solana",
    action,
    pubkey: resolved.pubkey,
    limits: resolved.limits,
    validUntil: validUntil.toString(),
    ownerNonce: account.ownerNonce.toString(),
    challenge: toWebAuthnChallenge(challenge),
  };
}

function decode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Finish an owner action with the assertion the browser produced.
 *
 * The secp256r1 precompile checks the passkey's signature, and the program
 * checks everything the signature covers. The fee account only pays for
 * the transaction; its key never stands in for the owner's.
 */
export async function submitSolanaOwnerAction(
  prepared: PreparedSolanaAction,
  assertion: OwnerAssertion,
  feeSecret: string,
  config: SolanaConfig = solana(),
  rpc: SolanaRpc = solanaRpc(config)
): Promise<{ txHash: string }> {
  if (!isSolanaOwnerAction(prepared.action)) {
    throw new Error(`unknown action ${prepared.action}`);
  }
  await verifySolanaNetwork(config, rpc);
  const policy = requirePolicy(config);
  const account = await readPolicyAccount(config, rpc);
  const input: OwnerActionInput = {
    pubkey: prepared.pubkey ? address(prepared.pubkey) : undefined,
    limits: prepared.limits,
  };

  const authenticatorData = decode(assertion.authenticatorData);
  const clientDataJSON = decode(assertion.clientDataJSON);
  const message = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
  const signature = derToRawSignature(decode(assertion.signature));

  const recover =
    prepared.action === "recover_funds"
      ? {
          mint: account.asset,
          vault: await associatedToken(policy, account.asset),
          recovery: account.recovery,
          recoveryToken: await associatedToken(account.recovery, account.asset),
        }
      : undefined;

  const fee = await solanaKeyPair(feeSecret);
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(fee.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          computeUnitLimit(40_000),
          secp256r1Instruction(account.owner, signature, message),
          ownerInstruction(
            config.programId,
            policy,
            prepared.action,
            input,
            clientDataJSON,
            BigInt(prepared.validUntil),
            recover
          ),
        ],
        m
      )
  );
  const signed = await signTransaction([fee.keyPair], compileTransaction(transactionMessage));
  const txHash = getSignatureFromTransaction(signed);
  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
  } catch (err) {
    throw new Error(`the policy refused the action: ${solanaErrorText(err)}`);
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    const { value } = await rpc.getSignatureStatuses([txHash]).send();
    const status = value[0];
    if (status?.err) {
      throw new Error(`the policy refused the action: ${JSON.stringify(status.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return { txHash };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`transaction ${txHash} was not confirmed`);
}
