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

export async function freezePayments(): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/freeze`, { method: "POST" });
    return await res.json();
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function restorePayments(): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/restore`, { method: "POST" });
    return await res.json();
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function revokeAgentSigner(): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/revoke`, { method: "POST" });
    return await res.json();
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
