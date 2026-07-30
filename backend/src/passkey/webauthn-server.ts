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
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const RP_NAME = "Beaver402";
const RP_ID = process.env.RP_ID || "localhost";
const ORIGIN = process.env.ORIGIN || `http://${RP_ID}:5173`;

const STORE_PATH = process.env.CREDENTIAL_STORE ||
  join(process.cwd(), ".beaver402-credentials.json");

interface StoredCredential {
  credentialID: string;
  credentialPublicKey: number[]; // serializable array instead of Uint8Array
  counter: number;
  transports?: string[];
}

interface CredentialStore {
  users: Record<string, StoredCredential[]>;
}

// file-backed credential store that survives restarts
function loadStore(): CredentialStore {
  if (existsSync(STORE_PATH)) {
    try {
      return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
    } catch {
      return { users: {} };
    }
  }
  return { users: {} };
}

function saveStore(store: CredentialStore): void {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

function getUserCredentials(userId: string): StoredCredential[] {
  const store = loadStore();
  return store.users[userId] || [];
}

// pending challenges are ephemeral (only valid for current session)
const pendingChallenges = new Map<string, string>();

export async function startRegistration(userId: string, userName: string) {
  const existingCreds = getUserCredentials(userId);

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

  const store = loadStore();
  if (!store.users[userId]) {
    store.users[userId] = [];
  }
  store.users[userId].push(stored);
  saveStore(store);

  pendingChallenges.delete(userId);

  return {
    verified: true,
    credentialID: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64"),
  };
}

export async function startAuthentication(userId: string) {
  const creds = getUserCredentials(userId);

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

  const creds = getUserCredentials(userId);
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

  // update counter in persistent store
  const store = loadStore();
  const userCreds = store.users[userId] || [];
  const toUpdate = userCreds.find((c) => c.credentialID === response.id);
  if (toUpdate) {
    toUpdate.counter = verification.authenticationInfo.newCounter;
    saveStore(store);
  }

  pendingChallenges.delete(userId);

  return { verified: true };
}

export { getUserCredentials };
