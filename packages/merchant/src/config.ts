import * as StellarSdk from "@stellar/stellar-sdk";

import type { SettlementStore } from "./store.js";

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConstants {
  caip2: "stellar:testnet" | "stellar:pubnet";
  passphrase: string;
  /** The public RPC, where the network has one. Mainnet has none. */
  defaultRpcUrl?: string;
  /** Circle's USDC issuer. The token contract follows from it. */
  usdcIssuer: string;
  defaultFacilitatorUrl: string;
  explorer: string;
}

export const NETWORKS: Record<NetworkName, NetworkConstants> = {
  testnet: {
    caip2: "stellar:testnet",
    passphrase: StellarSdk.Networks.TESTNET,
    defaultRpcUrl: "https://soroban-testnet.stellar.org",
    usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    defaultFacilitatorUrl: "https://channels.openzeppelin.com/x402/testnet",
    explorer: "https://stellar.expert/explorer/testnet",
  },
  mainnet: {
    caip2: "stellar:pubnet",
    passphrase: StellarSdk.Networks.PUBLIC,
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    defaultFacilitatorUrl: "https://channels.openzeppelin.com/x402",
    explorer: "https://stellar.expert/explorer/public",
  },
};

/** The USDC Stellar Asset Contract on a network. */
export function usdcContract(network: NetworkName): string {
  const n = NETWORKS[network];
  return new StellarSdk.Asset("USDC", n.usdcIssuer).contractId(n.passphrase);
}

/** "0.1" USDC as the integer amount a payment carries (7 decimals). */
export function usdc(amount: string): string {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(amount.trim());
  if (!match) throw new MerchantConfigError(`"${amount}" is not a USDC amount with at most 7 decimals`);
  const units = BigInt(match[1]!) * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
  return units.toString();
}

export class MerchantConfigError extends Error {
  override name = "MerchantConfigError";
}

export interface MerchantOptions {
  /** Which network. There is no default: it has to be named. */
  network: NetworkName;
  /** Soroban RPC. Required on mainnet, where it has to be https. */
  rpcUrl?: string;
  /**
   * The USDC Stellar Asset Contract. Required, and it has to be Circle's
   * USDC on the chosen network. Writing it out is the check that the
   * deployment and the operator agree on which token is being sold for.
   */
  usdcContract: string;
  /** x402 facilitator. Defaults to the OpenZeppelin Channels one for the network. */
  facilitatorUrl?: string;
  /** API key for the facilitator. */
  facilitatorApiKey: string;
  /**
   * The merchant signing key (an S secret). It signs every challenge and
   * pays the fee of the separate proof of intent transaction, so its
   * account needs a little XLM.
   */
  merchantSecret: string;
  /** Where payments land: a classic G account with a USDC trustline. */
  recipient: string;
  /** Default price per request, in integer USDC units. See usdc(). */
  price: string;
  /**
   * The origin agents call, such as https://api.example.com. The challenge
   * signs the full URL, so behind a proxy or load balancer this has to be
   * the public one. Required on mainnet. Without it the request's own
   * protocol and Host header are used.
   */
  publicUrl?: string;
  /** Where completed payments are recorded. A persistent one on mainnet. */
  store: SettlementStore;
  /** How long a challenge stays payable, in seconds. 300 unless set, at most 900. */
  challengeSeconds?: number;
  /** Shown to the payer in the 402 answer. */
  description?: string;
  logger?: Logger;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** What the merchant runs with, after every option has been checked. */
export interface ResolvedConfig {
  network: NetworkName;
  constants: NetworkConstants;
  rpcUrl: string;
  usdcContract: string;
  facilitatorUrl: string;
  facilitatorApiKey: string;
  keypair: StellarSdk.Keypair;
  recipient: string;
  price: string;
  publicUrl?: string;
  store: SettlementStore;
  challengeSeconds: number;
  description: string;
  logger: Logger;
}

/** The contract refuses a challenge valid for longer than this. */
export const MAX_CHALLENGE_SECONDS = 900;

export function checkPrice(price: string, label = "price"): string {
  if (!/^[1-9]\d*$/.test(price)) {
    throw new MerchantConfigError(`${label} must be a positive integer amount of USDC units, got "${price}". usdc("0.1") gives 1000000`);
  }
  return price;
}

/**
 * Check every option before anything is signed. Everything that can be
 * checked without the network is checked here; the rest is in preflight.
 */
export function resolveConfig(options: MerchantOptions): ResolvedConfig {
  const { network } = options;
  if (network !== "testnet" && network !== "mainnet") {
    throw new MerchantConfigError(`network must be "testnet" or "mainnet", got "${String(network)}"`);
  }
  const constants = NETWORKS[network];
  const mainnet = network === "mainnet";

  const rpcUrl = options.rpcUrl?.trim() || constants.defaultRpcUrl;
  if (!rpcUrl) throw new MerchantConfigError("rpcUrl is required on mainnet: there is no public mainnet RPC");
  if (mainnet && !rpcUrl.startsWith("https://")) throw new MerchantConfigError("rpcUrl has to be https on mainnet");
  if (mainnet && /testnet|futurenet/i.test(rpcUrl)) throw new MerchantConfigError(`rpcUrl ${rpcUrl} looks like a test network`);

  const expectedUsdc = usdcContract(network);
  if (!options.usdcContract) {
    throw new MerchantConfigError(`usdcContract is required. USDC on ${network} is ${expectedUsdc}`);
  }
  if (options.usdcContract !== expectedUsdc) {
    throw new MerchantConfigError(`usdcContract is ${options.usdcContract}, but USDC on ${network} is ${expectedUsdc}`);
  }

  const facilitatorUrl = options.facilitatorUrl?.trim() || constants.defaultFacilitatorUrl;
  if (!/^https?:\/\//.test(facilitatorUrl)) throw new MerchantConfigError(`facilitatorUrl ${facilitatorUrl} is not a URL`);
  if (mainnet && !facilitatorUrl.startsWith("https://")) throw new MerchantConfigError("facilitatorUrl has to be https on mainnet");
  if (mainnet && /testnet/i.test(facilitatorUrl)) throw new MerchantConfigError(`facilitatorUrl ${facilitatorUrl} is a testnet facilitator`);
  if (!mainnet && facilitatorUrl === NETWORKS.mainnet.defaultFacilitatorUrl) {
    throw new MerchantConfigError(`facilitatorUrl ${facilitatorUrl} is the mainnet facilitator`);
  }
  if (!options.facilitatorApiKey?.trim()) throw new MerchantConfigError("facilitatorApiKey is required");

  let keypair: StellarSdk.Keypair;
  try {
    keypair = StellarSdk.Keypair.fromSecret(options.merchantSecret);
  } catch {
    throw new MerchantConfigError("merchantSecret is not a Stellar secret key (S...)");
  }

  const recipient = options.recipient?.trim();
  if (!recipient || !StellarSdk.StrKey.isValidEd25519PublicKey(recipient)) {
    throw new MerchantConfigError(
      `recipient must be a classic Stellar account (G...), got "${options.recipient}". Contract and muxed addresses are not accepted`
    );
  }

  const price = checkPrice(options.price);

  let publicUrl: string | undefined;
  if (options.publicUrl) {
    let parsed: URL;
    try {
      parsed = new URL(options.publicUrl);
    } catch {
      throw new MerchantConfigError(`publicUrl ${options.publicUrl} is not a URL`);
    }
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new MerchantConfigError(`publicUrl must be an origin such as https://api.example.com, without a path, got ${options.publicUrl}`);
    }
    if (mainnet && parsed.protocol !== "https:") throw new MerchantConfigError("publicUrl has to be https on mainnet");
    publicUrl = parsed.origin;
  } else if (mainnet) {
    throw new MerchantConfigError("publicUrl is required on mainnet, so the signed URL is the one agents call");
  }

  if (!options.store) throw new MerchantConfigError("store is required: it records completed payments so none is used twice");
  if (mainnet && !options.store.persistent) {
    throw new MerchantConfigError("a mainnet merchant needs a persistent store. memoryStore() forgets payments on restart; use fileStore() or postgresStore()");
  }

  const challengeSeconds = options.challengeSeconds ?? 300;
  if (!Number.isInteger(challengeSeconds) || challengeSeconds < 30 || challengeSeconds > MAX_CHALLENGE_SECONDS) {
    throw new MerchantConfigError(`challengeSeconds must be a whole number from 30 to ${MAX_CHALLENGE_SECONDS}`);
  }

  return {
    network,
    constants,
    rpcUrl,
    usdcContract: expectedUsdc,
    facilitatorUrl,
    facilitatorApiKey: options.facilitatorApiKey.trim(),
    keypair,
    recipient,
    price,
    publicUrl,
    store: options.store,
    challengeSeconds,
    description: options.description ?? "Beaver402 protected resource",
    logger: options.logger ?? console,
  };
}

/** Options read from environment variables, as the CLI and the example use them. */
export function optionsFromEnv(
  env: Record<string, string | undefined>,
  store: SettlementStore
): MerchantOptions {
  const network = env.BEAVER402_NETWORK?.trim();
  if (!network) throw new MerchantConfigError("BEAVER402_NETWORK is required: testnet or mainnet");
  const priceText = env.PRICE_USDC?.trim() || "0.1";
  return {
    network: network as NetworkName,
    rpcUrl: env.SOROBAN_RPC_URL,
    usdcContract: env.USDC_CONTRACT ?? "",
    facilitatorUrl: env.FACILITATOR_URL,
    facilitatorApiKey: env.FACILITATOR_API_KEY ?? "",
    merchantSecret: env.MERCHANT_SECRET ?? "",
    recipient: env.RECIPIENT_ADDRESS ?? "",
    price: usdc(priceText),
    publicUrl: env.PUBLIC_URL || undefined,
    store,
  };
}
