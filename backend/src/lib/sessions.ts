import { randomBytes } from "crypto";

import { getSupabase, isSupabaseConfigured } from "./supabase.js";

/** How long a session stays valid once the owner has proved the passkey. */
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Issue a session to someone who has just completed a passkey ceremony.
 *
 * The id is made here rather than named by the caller. A client that could
 * choose its own id could also announce one it never earned, which is what
 * made the gate on the owner routes decorative.
 */
export async function createSession(): Promise<string> {
  const sessionId = randomBytes(32).toString("hex");

  if (isSupabaseConfigured()) {
    const supabase = getSupabase();
    await supabase.from("sessions").upsert({
      id: sessionId,
      authenticated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString(),
    });
  }

  return sessionId;
}

/** Whether this session exists and has not run out. */
export async function isAuthenticated(sessionId: string): Promise<boolean> {
  if (!sessionId || !isSupabaseConfigured()) {
    return false;
  }

  const supabase = getSupabase();
  const { data } = await supabase
    .from("sessions")
    .select("id, expires_at")
    .eq("id", sessionId)
    .single();

  if (!data) return false;
  return new Date(data.expires_at) > new Date();
}
