import { createHash } from "node:crypto";

import { network, NetworkConfigError, type NetworkConfig } from "./network.js";

/**
 * Where the owner passkey lives.
 *
 * A passkey belongs to one domain, the relying party, and an assertion only
 * verifies on a page served from that domain. The contract stores the hash
 * of the domain and refuses assertions made for any other, so on mainnet
 * this is chosen once, before the account is created, and never changed.
 */
export interface PasskeyConfig {
  rpId: string;
  /** The exact origin the control panel is served from. */
  origin: string;
}

type Env = Record<string, string | undefined>;

export function loadPasskeyConfig(
  config: NetworkConfig = network(),
  env: Env = process.env
): PasskeyConfig {
  if (config.name === "testnet") {
    const rpId = env.RP_ID || "localhost";
    return { rpId, origin: env.ORIGIN || `http://${rpId}:${env.FRONTEND_PORT || "5173"}` };
  }

  const rpId = env.RP_ID;
  const origin = env.ORIGIN;
  if (!rpId || !origin) {
    throw new NetworkConfigError("RP_ID and ORIGIN are required on mainnet");
  }
  if (rpId === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(rpId)) {
    throw new NetworkConfigError(`RP_ID ${rpId} cannot own a mainnet account`);
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new NetworkConfigError(`ORIGIN ${origin} is not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new NetworkConfigError("ORIGIN has to be https on mainnet");
  }
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw new NetworkConfigError(`ORIGIN ${origin} is not on ${rpId}`);
  }

  return { rpId, origin: url.origin };
}

let cached: PasskeyConfig | null = null;

export function passkey(): PasskeyConfig {
  if (!cached) {
    cached = loadPasskeyConfig();
  }
  return cached;
}

export function resetPasskeyConfig(): void {
  cached = null;
}

/** What the contract is created with: sha256 of the relying party id. */
export function rpIdHash(rpId: string): Buffer {
  return createHash("sha256").update(rpId).digest();
}
