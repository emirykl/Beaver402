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

const RP_NAME = "Beaver402";
const RP_ID = process.env.RP_ID || "localhost";
const ORIGIN = process.env.ORIGIN || `http://${RP_ID}:3000`;

interface StoredCredential {
  credentialID: string;
  credentialPublicKey: Uint8Array;
  counter: number;
  transports?: string[];
}

// in-memory store for testnet MVP
const userCredentials = new Map<string, StoredCredential[]>();
const pendingChallenges = new Map<string, string>();

export async function startRegistration(userId: string, userName: string) {
  const existingCreds = userCredentials.get(userId) || [];

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
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
    credentialPublicKey: credential.publicKey,
    counter: credential.counter,
  };

  const existing = userCredentials.get(userId) || [];
  existing.push(stored);
  userCredentials.set(userId, existing);

  pendingChallenges.delete(userId);

  return {
    verified: true,
    credentialID: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
  };
}

export async function startAuthentication(userId: string) {
  const creds = userCredentials.get(userId) || [];

  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: creds.map((c) => ({
      id: c.credentialID,
    })),
    userVerification: "preferred",
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

  const creds = userCredentials.get(userId) || [];
  const credential = creds.find((c) => c.credentialID === response.id);
  if (!credential) {
    throw new Error("credential not found");
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: credential.credentialID,
      publicKey: credential.credentialPublicKey,
      counter: credential.counter,
    },
  });

  if (!verification.verified) {
    throw new Error("authentication verification failed");
  }

  credential.counter = verification.authenticationInfo.newCounter;
  pendingChallenges.delete(userId);

  return { verified: true };
}

export function getUserCredentials(userId: string) {
  return userCredentials.get(userId) || [];
}
