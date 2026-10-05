import { startAuthentication } from "@simplewebauthn/browser";

import { getSessionId } from "./session.js";

const API_BASE = "/api/policy";

/** The chain the panel is looking at. The same passkey owns both accounts. */
export type Chain = "stellar" | "solana";

const CHAIN_KEY = "beaver402.chain";
let chain: Chain = (() => {
  try {
    return localStorage.getItem(CHAIN_KEY) === "solana" ? "solana" : "stellar";
  } catch {
    return "stellar";
  }
})();

export function getChain(): Chain {
  return chain;
}

export function setChain(next: Chain): void {
  chain = next;
  try {
    localStorage.setItem(CHAIN_KEY, next);
  } catch {
    // a remembered choice is a convenience, not a requirement
  }
}

function chainQuery(): string {
  return chain === "solana" ? "?chain=solana" : "";
}

/** The account's limits. Amounts are in stroops, seven decimals. */
export interface Limits {
  maxPaymentAmount: string;
  maxTxCount: number;
  maxTotalAmount: string;
  windowSize: number;
}

export interface PolicyState {
  frozen: boolean;
  agentSigner: string | null;
  velocityTxCount: number;
  velocityTotalAmount: string;
  /** When the oldest payment still counted was made, unix seconds. */
  velocityWindowStart?: number;
  limits?: Limits | null;
  contractId: string;
  /**
   * Whether the owner has approved the merchant this demo uses. Absent when
   * the backend predates the check, which is not the same as false.
   */
  merchantApproved?: boolean;
  /** How many payments the budget allows per window. */
  velocityMaxTxCount: number;
}

export async function fetchPolicyState(): Promise<PolicyState> {
  try {
    const res = await fetch(`${API_BASE}/state${chainQuery()}`);
    if (!res.ok) throw new Error("failed to fetch policy state");
    return await res.json();
  } catch {
    return {
      frozen: false,
      agentSigner: null,
      velocityTxCount: 0,
      velocityTotalAmount: "0",
      contractId: "not connected",
      merchantApproved: undefined,
      velocityMaxTxCount: 0,
    };
  }
}

export type OwnerAction =
  | "freeze_payments"
  | "restore_payments"
  | "revoke_agent_signer"
  | "set_agent_signer"
  | "add_merchant"
  | "remove_merchant"
  | "reduce_limits"
  | "recover_funds";

/** What the backend says about where it runs. Nothing in it is secret. */
export interface PublicConfig {
  network: "testnet" | "mainnet";
  explorer: string;
  contractId: string | null;
  asset: string;
  /** The merchant this deployment works with, so the agent side can name it. */
  merchantPubkey: string | null;
  /** The chains this deployment runs on. Absent means Stellar alone. */
  chains?: Chain[];
  solana?: {
    cluster: string;
    explorer: string;
    policy: string | null;
    asset: string;
    decimals: number;
    merchantPubkey: string | null;
  };
}

export async function fetchConfig(): Promise<PublicConfig | null> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** What an owner action carries besides its name. */
interface ActionInput {
  pubkey?: string;
  limits?: Limits;
  token?: string;
}

export interface OwnerActionResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/** What the backend prepared. Its shape differs by chain; only the
 *  challenge is read here, the rest goes back as it came. */
interface PreparedAction {
  challenge: string;
  [key: string]: unknown;
}

/** Owner routes want the session the passkey earned, not a fixed name. */
function jsonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-session-id": getSessionId(),
  };
}

/**
 * Carry out an owner action with the passkey.
 *
 * The account is asked what it wants signed, the authenticator signs exactly
 * that, and the assertion goes back for submission. The browser never holds a
 * Stellar key, and the backend cannot approve the action on its own, so
 * touching the authenticator is what actually moves the account.
 */
async function runOwnerAction(
  action: OwnerAction,
  input: ActionInput = {}
): Promise<OwnerActionResult> {
  try {
    const prepareRes = await fetch(`${API_BASE}/prepare`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ action, ...input, ...(chain === "solana" ? { chain } : {}) }),
    });
    const preparation = await prepareRes.json();

    if (!prepareRes.ok || !preparation.success) {
      return { success: false, error: preparation.error ?? "could not prepare the action" };
    }

    const prepared: PreparedAction = preparation.prepared;

    // The challenge is the payload the contract will be asked about, so the
    // assertion cannot be lifted and reused for anything else.
    const assertion = await startAuthentication({
      optionsJSON: {
        challenge: prepared.challenge,
        rpId: window.location.hostname,
        userVerification: "required",
        timeout: 60000,
      },
    });

    const submitRes = await fetch(`${API_BASE}/submit`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        prepared,
        assertion: {
          authenticatorData: assertion.response.authenticatorData,
          clientDataJSON: assertion.response.clientDataJSON,
          signature: assertion.response.signature,
        },
      }),
    });

    return await submitRes.json();
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function freezePayments(): Promise<OwnerActionResult> {
  return runOwnerAction("freeze_payments");
}

export async function restorePayments(): Promise<OwnerActionResult> {
  return runOwnerAction("restore_payments");
}

export async function revokeAgentSigner(): Promise<OwnerActionResult> {
  return runOwnerAction("revoke_agent_signer");
}

/**
 * Give the account a delegated signer again.
 *
 * Revoking is meant to be survivable, so the same passkey that cut the agent
 * off can hand the key back. With no key named, the account is set back to the
 * signer the backend is configured with.
 */
export async function restoreAgentSigner(): Promise<OwnerActionResult> {
  return runOwnerAction("set_agent_signer");
}

export async function allowMerchant(
  merchantPubkey: string
): Promise<OwnerActionResult> {
  return runOwnerAction("add_merchant", { pubkey: merchantPubkey });
}

/** Stop paying a merchant. It can be approved again later. */
export async function removeMerchant(
  merchantPubkey: string
): Promise<OwnerActionResult> {
  return runOwnerAction("remove_merchant", { pubkey: merchantPubkey });
}

/** Lower the limits. The contract refuses anything that raises one. */
export async function reduceLimits(limits: Limits): Promise<OwnerActionResult> {
  return runOwnerAction("reduce_limits", { limits });
}

/**
 * Send the whole balance to the recovery address fixed when the account was
 * created. Only works while payments are halted.
 */
export async function recoverFunds(): Promise<OwnerActionResult> {
  return runOwnerAction("recover_funds");
}

export interface MerchantInfo {
  merchantPubkey: string;
  recipient: string;
  asset: string;
  network: string;
  price: string;
}

/** Who the demo merchant is, so the owner can see what they are approving. */
export async function fetchMerchantInfo(): Promise<MerchantInfo | null> {
  try {
    const res = await fetch("/api/merchant-info");
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface Transaction {
  id: string;
  tx_hash: string | null;
  recipient: string | null;
  asset: string | null;
  amount: string | null;
  status: string | null;
  error: string | null;
  created_at: string;
}

/** The owner's payment log. It needs the session the passkey earned. */
export async function fetchTransactions(): Promise<Transaction[]> {
  try {
    const res = await fetch(`/api/transactions${chainQuery()}`, { headers: jsonHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.transactions ?? [];
  } catch {
    return [];
  }
}
