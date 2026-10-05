import {
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  type Address,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { PaymentBindingError, type AuthorizedTerms } from "../../merchant/payment-binding.js";
import { solana, solanaErrorText, solanaRpc, verifySolanaNetwork, type SolanaConfig, type SolanaRpc } from "./config.js";
import {
  associatedToken,
  COMPUTE_BUDGET_PROGRAM,
  decodePayArgs,
  ED25519_PROGRAM,
  INSTRUCTIONS_SYSVAR,
} from "./program.js";

/** A Solana payment as the merchant reads it, before it settles anything. */
export interface SolanaPayment {
  terms: AuthorizedTerms;
  transaction: Transaction;
  vault: Address;
  recipientToken: Address;
}

export interface SolanaMerchantSide {
  /** The account that pays the fee, the merchant's own. */
  feePayer: Address;
  recipient: Address;
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

/**
 * Read a payment, and refuse anything but the one shape Beaver402 makes:
 * compute budget instructions, one ed25519 precompile instruction with the
 * merchant's signature, and one pay instruction, with this merchant paying
 * the fee and nothing else in the transaction.
 *
 * The program enforces the same layout on chain. Checking it here as well
 * means the merchant never signs, and never pays the fee for, a
 * transaction it would not want to exist.
 */
export async function readSolanaPayment(
  wire: string,
  merchant: SolanaMerchantSide,
  config: SolanaConfig = solana()
): Promise<SolanaPayment> {
  let transaction: Transaction;
  let message;
  try {
    transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire)) as Transaction;
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch {
    throw new PaymentBindingError("the payment is not a Solana transaction");
  }

  if (message.version !== 0 && message.version !== "legacy") {
    throw new PaymentBindingError("the payment is not a version 0 transaction");
  }
  if ("addressTableLookups" in message && (message.addressTableLookups?.length ?? 0) > 0) {
    throw new PaymentBindingError("the payment uses address lookup tables");
  }
  const keys = message.staticAccounts;
  if (keys[0] !== merchant.feePayer) {
    throw new PaymentBindingError("the payment is not paid for by this merchant");
  }

  let ed25519: Uint8Array | null = null;
  let pay: { accounts: Address[]; data: Uint8Array } | null = null;
  for (const instruction of message.instructions) {
    const program = keys[instruction.programAddressIndex];
    const data = Uint8Array.from(instruction.data ?? []);
    if (program === COMPUTE_BUDGET_PROGRAM) continue;
    if (program === ED25519_PROGRAM && !ed25519) {
      ed25519 = data;
      continue;
    }
    if (program === config.programId && !pay) {
      pay = { accounts: (instruction.accountIndices ?? []).map((i: number) => keys[i]!), data };
      continue;
    }
    throw new PaymentBindingError("the payment carries an instruction Beaver402 does not make");
  }
  if (!ed25519 || !pay) {
    throw new PaymentBindingError("the payment is not a Beaver402 payment");
  }

  const args = decodePayArgs(pay.data);
  if (!args || pay.accounts.length !== 8) {
    throw new PaymentBindingError("the payment instruction is malformed");
  }
  const [agent, policy, mint, vault, recipient, recipientToken, tokenProgram, sysvar] = pay.accounts as [
    Address, Address, Address, Address, Address, Address, Address, Address,
  ];

  // The fee payer signs the whole transaction, so it may not be what the
  // payment spends from or the key that authorizes it. Being the recipient
  // is fine, and on devnet the merchant is both.
  if ([agent, policy, vault].includes(merchant.feePayer)) {
    throw new PaymentBindingError("the fee payer appears inside the payment");
  }
  if (mint !== config.usdcMint || tokenProgram !== TOKEN_PROGRAM_ADDRESS || sysvar !== INSTRUCTIONS_SYSVAR) {
    throw new PaymentBindingError("the payment is in another token");
  }
  if (recipient !== merchant.recipient) {
    throw new PaymentBindingError("the payment goes to another recipient");
  }
  if (recipientToken !== (await associatedToken(recipient, mint)) || vault !== (await associatedToken(policy, mint))) {
    throw new PaymentBindingError("the payment moves money between other token accounts");
  }

  // The agent has to have signed already; the merchant only adds the fee.
  const agentSignature = transaction.signatures[agent];
  if (!agentSignature) {
    throw new PaymentBindingError("the payment is not signed by the paying account's agent");
  }

  // The merchant signature the precompile will check, read from the same
  // bytes the precompile reads.
  const precompile = Buffer.from(ed25519);
  if (precompile.length < 16 + 32 + 64 + 32 || precompile[0] !== 1) {
    throw new PaymentBindingError("the merchant signature instruction is malformed");
  }
  const at = (offset: number) => precompile.readUInt16LE(2 + offset);
  const keyAt = at(4);
  const sigAt = at(0);
  const msgAt = at(8);
  const msgLen = at(10);
  const merchantPubkey = precompile.subarray(keyAt, keyAt + 32);
  const merchantSignature = precompile.subarray(sigAt, sigAt + 64);
  if (msgLen !== 32 || !merchantPubkey.equals(args.merchantPubkey)) {
    throw new PaymentBindingError("the merchant signature instruction does not match the payment");
  }

  return {
    terms: {
      payer: policy,
      merchantPubkey,
      merchantSignature,
      requestDigest: Buffer.from(args.requestDigest),
      recipient,
      asset: mint,
      amount: args.amount.toString(),
      nonce: Buffer.from(args.nonce).toString("hex"),
      expiry: args.expiry.toString(),
    },
    transaction,
    vault,
    recipientToken,
  };
}

/** How long to wait for the cluster to report the settlement. */
const CONFIRMATION_ATTEMPTS = 30;

/**
 * Sign as the fee payer, submit, and confirm on the ledger that exactly the
 * agreed transfer happened: the vault down by the amount, the recipient's
 * token account up by it, and no other token balance moved.
 */
export async function settleSolanaPayment(
  payment: SolanaPayment,
  feePayer: CryptoKeyPair,
  config: SolanaConfig = solana(),
  rpc: SolanaRpc = solanaRpc(config)
): Promise<Signature> {
  await verifySolanaNetwork(config, rpc);
  const signed = await partiallySignTransaction([feePayer], payment.transaction);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);

  try {
    await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (err) {
    throw new Error(`the payment was refused on submission: ${solanaErrorText(err)}`);
  }

  let found: Awaited<ReturnType<ReturnType<SolanaRpc["getTransaction"]>["send"]>> = null;
  for (let attempt = 0; attempt < CONFIRMATION_ATTEMPTS && !found; attempt++) {
    found = await rpc
      .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    if (!found) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!found) {
    throw new Error(`settlement ${signature} was not confirmed`);
  }
  if (found.meta?.err) {
    throw new Error(`settlement ${signature} failed: ${json(found.meta.err)}`);
  }

  confirmTransfer(signature, found.meta, payment);
  return signature;
}

type TokenBalance = { accountIndex: number; mint: string; uiTokenAmount: { amount: string } };

/** The token balance changes of a confirmed transaction, by account. */
export function confirmTransfer(
  signature: string,
  meta: { preTokenBalances?: readonly TokenBalance[] | null; postTokenBalances?: readonly TokenBalance[] | null } | null,
  payment: Pick<SolanaPayment, "vault" | "recipientToken" | "terms" | "transaction">
): void {
  const message = getCompiledTransactionMessageDecoder().decode(payment.transaction.messageBytes);
  const keys = message.staticAccounts;
  const change = new Map<string, bigint>();
  const pre = meta?.preTokenBalances ?? [];
  const post = meta?.postTokenBalances ?? [];
  for (const b of post) {
    if (b.mint !== payment.terms.asset) throw new Error(`settlement ${signature} moved another token`);
    change.set(keys[b.accountIndex]!, BigInt(b.uiTokenAmount.amount));
  }
  for (const b of pre) {
    const key = keys[b.accountIndex]!;
    change.set(key, (change.get(key) ?? 0n) - BigInt(b.uiTokenAmount.amount));
  }

  const amount = BigInt(payment.terms.amount);
  const moved = [...change.entries()].filter(([, delta]) => delta !== 0n);
  if (moved.length !== 2) {
    throw new Error(`settlement ${signature} moved ${moved.length} token balances, expected two`);
  }
  if (change.get(payment.vault) !== -amount) {
    throw new Error(`settlement ${signature} did not take ${amount} from the paying account`);
  }
  if (change.get(payment.recipientToken) !== amount) {
    throw new Error(`settlement ${signature} did not pay ${amount} to the recipient`);
  }
}
