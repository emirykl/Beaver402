import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import {
  decodeStoredBytes,
  getSupabase,
  isSupabaseConfigured,
} from "../lib/supabase.js";
import { passkey } from "../config/passkey.js";

const RP_NAME = "Beaver402";

/** How long a ceremony may take between its start and its answer. */
const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

export interface StoredCredential {
  credentialID: string;
  credentialPublicKey: number[];
  counter: number;
  transports?: string[];
}

/**
 * The challenge a ceremony was started with, until its answer arrives.
 *
 * Kept in the database when there is one. A serverless host can answer the
 * start and the finish of the same ceremony from two different instances,
 * and a challenge held in one instance's memory is gone from the other.
 */
const memoryChallenges = new Map<string, { challenge: string; expiresAt: number }>();

async function rememberChallenge(userId: string, challenge: string): Promise<void> {
  const expiresAt = Date.now() + CHALLENGE_LIFETIME_MS;
  if (!isSupabaseConfigured()) {
    memoryChallenges.set(userId, { challenge, expiresAt });
    return;
  }
  const { error } = await getSupabase()
    .from("webauthn_challenges")
    .upsert({ user_id: userId, challenge, expires_at: new Date(expiresAt).toISOString() });
  if (error) {
    throw new Error(`failed to store the passkey challenge: ${error.message}`);
  }
}

/** Hand back the pending challenge once, and forget it. */
async function takeChallenge(userId: string): Promise<string | null> {
  if (!isSupabaseConfigured()) {
    const entry = memoryChallenges.get(userId);
    memoryChallenges.delete(userId);
    return entry && entry.expiresAt > Date.now() ? entry.challenge : null;
  }
  const { data, error } = await getSupabase()
    .from("webauthn_challenges")
    .delete()
    .eq("user_id", userId)
    .select("challenge, expires_at");
  if (error) {
    throw new Error(`failed to read the passkey challenge: ${error.message}`);
  }
  const row = data?.[0];
  return row && new Date(row.expires_at).getTime() > Date.now() ? row.challenge : null;
}

async function getUserCredentials(userId: string): Promise<StoredCredential[]> {
  if (!isSupabaseConfigured()) {
    return [];
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("credentials")
    .select("credential_id, public_key, counter, transports")
    .eq("user_id", userId);

  if (error || !data) {
    return [];
  }

  return data.map((row) => ({
    credentialID: row.credential_id,
    credentialPublicKey: Array.from(decodeStoredBytes(row.public_key)),
    counter: row.counter,
    transports: row.transports ?? undefined,
  }));
}

async function saveCredential(
  userId: string,
  cred: StoredCredential
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from("credentials").insert({
    user_id: userId,
    credential_id: cred.credentialID,
    public_key: Buffer.from(new Uint8Array(cred.credentialPublicKey)).toString(
      "base64"
    ),
    counter: cred.counter,
    transports: cred.transports ?? null,
  });

  if (error) {
    throw new Error(`failed to save credential: ${error.message}`);
  }
}

async function updateCredentialCounter(
  credentialID: string,
  newCounter: number
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("credentials")
    .update({ counter: newCounter })
    .eq("credential_id", credentialID);

  if (error) {
    throw new Error(`failed to update counter: ${error.message}`);
  }
}

export async function startRegistration(userId: string, userName: string) {
  const existingCreds = await getUserCredentials(userId);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: passkey().rpId,
    userName,
    attestationType: "direct",
    // The contract verifies secp256r1 and nothing else, so only ES256 is
    // offered. Left to its own devices an authenticator may hand back an
    // Ed25519 or RSA key, and the passkey would be useless as an owner.
    supportedAlgorithmIDs: [-7],
    // The owner touches this Mac to approve, so offer its own authenticator
    // first rather than a phone or a security key.
    preferredAuthenticatorType: "localDevice",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: existingCreds.map((c) => ({
      id: c.credentialID,
    })),
  });

  await rememberChallenge(userId, options.challenge);
  return options;
}

export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON
) {
  const expectedChallenge = await takeChallenge(userId);
  if (!expectedChallenge) {
    throw new Error("no pending registration challenge");
  }

  const { rpId, origin } = passkey();
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("registration verification failed");
  }

  const { credential } = verification.registrationInfo;

  const stored: StoredCredential = {
    credentialID: credential.id,
    credentialPublicKey: Array.from(credential.publicKey),
    counter: credential.counter,
  };

  await saveCredential(userId, stored);

  return {
    verified: true,
    credentialID: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
  };
}

export async function startAuthentication(userId: string) {
  const creds = await getUserCredentials(userId);

  const options = await generateAuthenticationOptions({
    rpID: passkey().rpId,
    allowCredentials: creds.map((c) => ({
      id: c.credentialID,
    })),
    userVerification: "required",
  });

  await rememberChallenge(userId, options.challenge);
  return options;
}

export async function finishAuthentication(
  userId: string,
  response: AuthenticationResponseJSON
) {
  const expectedChallenge = await takeChallenge(userId);
  if (!expectedChallenge) {
    throw new Error("no pending authentication challenge");
  }

  const creds = await getUserCredentials(userId);
  const credential = creds.find((c) => c.credentialID === response.id);
  if (!credential) {
    throw new Error("credential not found");
  }

  const publicKeyUint8 = new Uint8Array(credential.credentialPublicKey);

  const { rpId, origin } = passkey();
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential: {
      id: credential.credentialID,
      publicKey: publicKeyUint8,
      counter: credential.counter,
    },
  });

  if (!verification.verified) {
    throw new Error("authentication verification failed");
  }

  await updateCredentialCounter(
    response.id,
    verification.authenticationInfo.newCounter
  );

  return { verified: true };
}

export { getUserCredentials };
