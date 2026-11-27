import * as StellarSdk from "@stellar/stellar-sdk";

/** A merchant the owner panel shows, and may approve. */
export interface KnownMerchant {
  label: string;
  pubkey: string;
}

type Env = Record<string, string | undefined>;

/** The merchant this deployment itself runs, when it runs one. */
export function ownMerchantKey(env: Env = process.env): string | null {
  if (env.MERCHANT_PUBKEY) return env.MERCHANT_PUBKEY;
  return env.MERCHANT_SECRET ? StellarSdk.Keypair.fromSecret(env.MERCHANT_SECRET).publicKey() : null;
}

/**
 * The merchants the owner panel lists: this deployment's own, then any
 * named in MERCHANTS as `Label=G...` pairs separated by commas.
 *
 * The list is set by whoever operates the account. The panel approves only
 * merchants on it, so an owner never approves a key they were not shown with
 * its name, and there is no registry of merchants anywhere else.
 */
export function knownMerchants(env: Env = process.env): KnownMerchant[] {
  const merchants: KnownMerchant[] = [];
  const own = ownMerchantKey(env);
  if (own) merchants.push({ label: env.MERCHANT_LABEL?.trim() || "Reference merchant", pubkey: own });

  for (const entry of (env.MERCHANTS ?? "").split(",")) {
    if (!entry.trim()) continue;
    const at = entry.lastIndexOf("=");
    const label = entry.slice(0, at).trim();
    const pubkey = entry.slice(at + 1).trim();
    if (at < 1 || !label || label.length > 40) {
      throw new Error(`MERCHANTS entry "${entry.trim()}" is not Label=G...`);
    }
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(pubkey)) {
      throw new Error(`MERCHANTS entry "${label}" does not carry a G address`);
    }
    if (merchants.some((m) => m.pubkey === pubkey)) continue;
    merchants.push({ label, pubkey });
  }
  return merchants;
}

export function isKnownMerchant(pubkey: string, env: Env = process.env): boolean {
  return knownMerchants(env).some((m) => m.pubkey === pubkey);
}
