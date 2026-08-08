import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required"
      );
    }
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
  return client;
}

export function isSupabaseConfigured(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}

/**
 * Recover bytes from a value that came back out of a bytea column.
 *
 * A passkey public key is written as base64 text, but the column holding it
 * is bytea, so Postgres stores the characters of that text and hands them
 * back as a hex escape. Reading it as plain base64 yields nonsense, which is
 * how a perfectly good passkey ends up looking corrupt.
 *
 * Both shapes are accepted so credentials registered either way still work.
 */
export function decodeStoredBytes(value: string): Buffer {
  if (value.startsWith("\\x")) {
    const asText = Buffer.from(value.slice(2), "hex").toString("utf-8");
    return Buffer.from(asText, "base64");
  }
  return Buffer.from(value, "base64");
}
