const API_BASE = "/api/policy";

export interface PolicyState {
  frozen: boolean;
  agentSigner: string | null;
  velocityTxCount: number;
  velocityTotalAmount: string;
  contractId: string;
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
    };
  }
}

async function authedPost(
  path: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-session-id": "default",
      },
    });
    return await res.json();
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function freezePayments(): Promise<{
  success: boolean;
  txHash?: string;
  error?: string;
}> {
  return authedPost("freeze");
}

export async function restorePayments(): Promise<{
  success: boolean;
  txHash?: string;
  error?: string;
}> {
  return authedPost("restore");
}

export async function revokeAgentSigner(): Promise<{
  success: boolean;
  txHash?: string;
  error?: string;
}> {
  return authedPost("revoke");
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
