/**
 * The session the backend issued when the passkey was checked.
 *
 * It is kept for the life of the tab only. Closing it means signing in again,
 * which costs one touch of the authenticator and keeps a shared machine from
 * inheriting somebody else's session.
 */
const STORAGE_KEY = "beaver402.session";

let current = "";

export function setSessionId(sessionId: string): void {
  current = sessionId;
  try {
    sessionStorage.setItem(STORAGE_KEY, sessionId);
  } catch {
    // Private modes refuse storage. The session still works for this page.
  }
}

export function getSessionId(): string {
  if (current) return current;
  try {
    current = sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    current = "";
  }
  return current;
}
