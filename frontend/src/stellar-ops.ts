import { startAuthentication } from "@simplewebauthn/browser";

const API_BASE = "/api/policy";

export interface PolicyState {
  frozen: boolean;
  agentSigner: string | null;
  velocityTxCount: number;
  velocityTotalAmount: string;
  contractId: string;
  /** Whether the owner has approved the merchant this demo uses. */
  merchantApproved: boolean;
  /** How many payments the budget allows per window. */
  velocityMaxTxCount: number;
}

export async function fetchPolicyState(): Promise<PolicyState> {
  try {
    const res = await fetch(`${API_BASE}/state`);
    if (!res.ok) throw new Error("failed to fetch policy state");
    return await res.json();
  } catch {
    return {
      frozen: false,
      agentSigner: null,
      velocityTxCount: 0,
      velocityTotalAmount: "0",
      contractId: "not connected",
      merchantApproved: false,
      velocityMaxTxCount: 0,
    };
  }
}

export type OwnerAction =
  | "freeze_payments"
  | "restore_payments"
  | "revoke_agent_signer"
  | "add_merchant"
  | "remove_merchant";

export interface OwnerActionResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

interface PreparedAction {
  action: OwnerAction;
  args: string[];
  challenge: string;
  authEntry: string;
  validUntilLedger: number;
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "x-session-id": "default",
};

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
  merchantPubkey?: string
): Promise<OwnerActionResult> {
  try {
    const prepareRes = await fetch(`${API_BASE}/prepare`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ action, merchantPubkey }),
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
      headers: JSON_HEADERS,
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

export async function allowMerchant(
  merchantPubkey: string
): Promise<OwnerActionResult> {
  return runOwnerAction("add_merchant", merchantPubkey);
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

export async function fetchTransactions(): Promise<Transaction[]> {
  try {
    const res = await fetch("/api/transactions");
    if (!res.ok) return [];
    const data = await res.json();
    return data.transactions ?? [];
  } catch {
    return [];
  }
}
