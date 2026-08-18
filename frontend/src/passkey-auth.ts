import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

import { setSessionId } from "./session.js";

const API_BASE = "/api/passkey";

export interface PasskeyResult {
  ok: boolean;
  /** Why it did not work, in words worth showing someone. */
  error?: string;
}

/** Whether this account already has a passkey on record. */
export async function hasPasskey(userId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/credentials/${encodeURIComponent(userId)}`);
    if (!res.ok) return false;
    const body = await res.json();
    return body.hasCredentials === true;
  } catch {
    return false;
  }
}

export async function registerPasskey(userId: string): Promise<PasskeyResult> {
  try {
    const optionsRes = await fetch(`${API_BASE}/register/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, userName: userId }),
    });
    const options = await optionsRes.json();
    if (!optionsRes.ok) {
      return { ok: false, error: options.error ?? "the server refused to start" };
    }

    const credential = await startRegistration({ optionsJSON: options });

    const verifyRes = await fetch(`${API_BASE}/register/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, credential }),
    });
    const result = await verifyRes.json();

    if (result.verified === true) {
      setSessionId(result.sessionId ?? "");
      return { ok: true };
    }
    return { ok: false, error: result.error ?? "the server did not accept the passkey" };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

export async function authenticatePasskey(userId: string): Promise<PasskeyResult> {
  try {
    const optionsRes = await fetch(`${API_BASE}/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    const options = await optionsRes.json();
    if (!optionsRes.ok) {
      return { ok: false, error: options.error ?? "the server refused to start" };
    }

    const assertion = await startAuthentication({ optionsJSON: options });

    const verifyRes = await fetch(`${API_BASE}/auth/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, credential: assertion }),
    });
    const result = await verifyRes.json();

    if (result.verified === true) {
      setSessionId(result.sessionId ?? "");
      return { ok: true };
    }
    return { ok: false, error: result.error ?? "the server did not accept the signature" };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}

/**
 * Say what went wrong in a way that points somewhere.
 *
 * The browser reports most passkey trouble as one of a few named errors, and
 * the name alone tells someone nothing about what to do next.
 */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  switch (err.name) {
    case "NotAllowedError":
      return "the prompt was dismissed, or it timed out";
    case "InvalidStateError":
      return "this device already holds a passkey for this account";
    case "NotSupportedError":
      return "this browser cannot make the kind of key the contract checks";
    case "SecurityError":
      return "the page origin does not match the one the passkey was made for";
    case "AbortError":
      return "the request was cancelled";
    default:
      return err.message || err.name;
  }
}
