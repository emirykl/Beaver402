/**
 * Print the owner key for a registered passkey.
 *
 * The deploy script needs the account owner as an uncompressed secp256r1
 * point, and that only exists once a passkey has been registered in the
 * browser. This reads the stored credential and prints the key in the form
 * the contract constructor takes.
 *
 * Run with: npm run owner:key [userId]
 */
import {
  decodeStoredBytes,
  getSupabase,
  isSupabaseConfigured,
} from "../src/lib/supabase.js";
import { ownerKeyToHex } from "../src/passkey/owner-key.js";

const userId = process.argv[2] || "owner";

async function main() {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured, so there is nowhere to read the passkey from. " +
        "Set SUPABASE_URL and SUPABASE_SERVICE_KEY in backend/.env"
    );
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("credentials")
    .select("credential_id, public_key, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`could not read credentials: ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(
      `no passkey registered for "${userId}". Start the backend and the frontend, ` +
        "open the control panel and register one, then run this again."
    );
  }

  if (data.length > 1) {
    console.error(
      `note: ${data.length} passkeys are registered for "${userId}", using the newest one`
    );
  }

  const newest = data[0]!;
  const cose = new Uint8Array(decodeStoredBytes(newest.public_key));

  // Only the hex goes to stdout, so the deploy script can read it directly.
  console.error(`passkey ${newest.credential_id} registered for ${userId}`);
  console.log(ownerKeyToHex(cose));
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
