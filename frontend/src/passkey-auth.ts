import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";

const API_BASE = "/api/passkey";

export async function registerPasskey(userId: string): Promise<boolean> {
  try {
    const optionsRes = await fetch(`${API_BASE}/register/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, userName: userId }),
    });
    const options = await optionsRes.json();

    const credential = await startRegistration({ optionsJSON: options });

    const verifyRes = await fetch(`${API_BASE}/register/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, credential }),
    });
    const result = await verifyRes.json();

    return result.verified === true;
  } catch (err) {
    console.error("passkey registration failed:", err);
    return false;
  }
}

export async function authenticatePasskey(userId: string): Promise<boolean> {
  try {
    const optionsRes = await fetch(`${API_BASE}/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const options = await optionsRes.json();

    const assertion = await startAuthentication({ optionsJSON: options });

    const verifyRes = await fetch(`${API_BASE}/auth/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, credential: assertion }),
    });
    const result = await verifyRes.json();

    return result.verified === true;
  } catch (err) {
    console.error("passkey authentication failed:", err);
    return false;
  }
}
