import { registerPasskey, authenticatePasskey } from "./passkey-auth.js";
import {
  fetchPolicyState,
  freezePayments,
  restorePayments,
  revokeAgentSigner,
} from "./stellar-ops.js";
import { updateStatusBadge, updatePolicyInfo, addLogEntry, setAuthStatus } from "./ui.js";

let isAuthenticated = false;

async function refreshState() {
  try {
    const state = await fetchPolicyState();
    updateStatusBadge(state.frozen);
    updatePolicyInfo(state);
  } catch {
    addLogEntry("could not load policy state", "error");
  }
}

document.getElementById("btn-register")?.addEventListener("click", async () => {
  addLogEntry("starting passkey registration...");
  const userId = `user_${Date.now()}`;
  const success = await registerPasskey(userId);
  if (success) {
    isAuthenticated = true;
    setAuthStatus(true);
    addLogEntry("passkey registered successfully", "success");
  } else {
    addLogEntry("passkey registration failed", "error");
  }
});

document.getElementById("btn-login")?.addEventListener("click", async () => {
  addLogEntry("starting passkey authentication...");
  const userId = "default_user";
  const success = await authenticatePasskey(userId);
  if (success) {
    isAuthenticated = true;
    setAuthStatus(true);
    addLogEntry("signed in with passkey", "success");
  } else {
    addLogEntry("authentication failed", "error");
  }
});

document.getElementById("btn-freeze")?.addEventListener("click", async () => {
  if (!isAuthenticated) {
    addLogEntry("please sign in first", "error");
    return;
  }
  addLogEntry("submitting freeze transaction...");
  const result = await freezePayments();
  if (result.success) {
    addLogEntry(`payments frozen, tx: ${result.txHash}`, "success");
    await refreshState();
  } else {
    addLogEntry(`freeze failed: ${result.error}`, "error");
  }
});

document.getElementById("btn-restore")?.addEventListener("click", async () => {
  if (!isAuthenticated) {
    addLogEntry("please sign in first", "error");
    return;
  }
  addLogEntry("submitting restore transaction...");
  const result = await restorePayments();
  if (result.success) {
    addLogEntry(`payments restored, tx: ${result.txHash}`, "success");
    await refreshState();
  } else {
    addLogEntry(`restore failed: ${result.error}`, "error");
  }
});

document.getElementById("btn-revoke")?.addEventListener("click", async () => {
  if (!isAuthenticated) {
    addLogEntry("please sign in first", "error");
    return;
  }
  addLogEntry("submitting revoke transaction...");
  const result = await revokeAgentSigner();
  if (result.success) {
    addLogEntry(`agent signer revoked, tx: ${result.txHash}`, "success");
    await refreshState();
  } else {
    addLogEntry(`revoke failed: ${result.error}`, "error");
  }
});

// load initial state
refreshState();
addLogEntry("beaver402 control panel loaded");
