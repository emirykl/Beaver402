import type { PolicyState } from "./stellar-ops.js";

export function updateStatusBadge(frozen: boolean) {
  const badge = document.getElementById("status-badge");
  if (!badge) return;

  if (frozen) {
    badge.textContent = "frozen";
    badge.className = "status-badge status-frozen";
  } else {
    badge.textContent = "active";
    badge.className = "status-badge status-active";
  }
}

export function updatePolicyInfo(state: PolicyState) {
  const contractEl = document.getElementById("contract-id");
  const signerEl = document.getElementById("agent-signer");
  const velocityEl = document.getElementById("velocity-info");

  if (contractEl) contractEl.textContent = state.contractId;
  if (signerEl) signerEl.textContent = state.agentSigner || "revoked";
  if (velocityEl)
    velocityEl.textContent = `${state.velocityTxCount} tx / ${state.velocityTotalAmount} stroops`;
}

export function addLogEntry(message: string, type: "info" | "success" | "error" = "info") {
  const log = document.getElementById("activity-log");
  if (!log) return;

  // remove "waiting" placeholder
  const placeholder = log.querySelector(".log-entry:only-child");
  if (placeholder && placeholder.textContent === "waiting for events...") {
    placeholder.remove();
  }

  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;

  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;

  log.insertBefore(entry, log.firstChild);

  // keep max 50 entries
  while (log.children.length > 50) {
    log.removeChild(log.lastChild!);
  }
}

export function setAuthStatus(authenticated: boolean) {
  const statusEl = document.getElementById("auth-status");
  if (!statusEl) return;

  if (authenticated) {
    statusEl.innerHTML = '<p style="color: var(--success)">authenticated with passkey</p>';
  } else {
    statusEl.innerHTML =
      '<p style="color: var(--text-muted)">Register or sign in with your passkey to manage the payment policy.</p>';
  }
}
