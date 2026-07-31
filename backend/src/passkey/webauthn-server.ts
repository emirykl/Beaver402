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
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";

const RP_NAME = "Beaver402";
const RP_ID = process.env.RP_ID || "localhost";
const ORIGIN = process.env.ORIGIN || `http://${RP_ID}:5173`;

export interface StoredCredential {
  credentialID: string;
  credentialPublicKey: number[];
  counter: number;
  transports?: string[];
}

// pending challenges are ephemeral (only valid for current session)
const pendingChallenges = new Map<string, string>();

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
    credentialPublicKey: Array.from(Buffer.from(row.public_key, "base64")),
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
    rpID: RP_ID,
    userName,
    attestationType: "direct",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: existingCreds.map((c) => ({
      id: c.credentialID,
    })),
  });

  pendingChallenges.set(userId, options.challenge);
  return options;
}

export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON
) {
  const expectedChallenge = pendingChallenges.get(userId);
  if (!expectedChallenge) {
    throw new Error("no pending registration challenge");
  }

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
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

  pendingChallenges.delete(userId);

  return {
    verified: true,
    credentialID: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
  };
}

export async function startAuthentication(userId: string) {
  const creds = await getUserCredentials(userId);

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: creds.map((c) => ({
      id: c.credentialID,
    })),
    userVerification: "required",
  });

  pendingChallenges.set(userId, options.challenge);
  return options;
}

export async function finishAuthentication(
  userId: string,
  response: AuthenticationResponseJSON
) {
  const expectedChallenge = pendingChallenges.get(userId);
  if (!expectedChallenge) {
    throw new Error("no pending authentication challenge");
  }

  const creds = await getUserCredentials(userId);
  const credential = creds.find((c) => c.credentialID === response.id);
  if (!credential) {
    throw new Error("credential not found");
  }

  const publicKeyUint8 = new Uint8Array(credential.credentialPublicKey);

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
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

  pendingChallenges.delete(userId);

  return { verified: true };
}

export { getUserCredentials };
