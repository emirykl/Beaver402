import * as StellarSdk from "@stellar/stellar-sdk";

/**
 * Which Stellar network this backend talks to, and everything that follows
 * from that choice.
 *
 * Every component reads the network from here. Nothing else names a
 * passphrase, an RPC endpoint, a token or an explorer, so a backend set up
 * for one network cannot sign, read or link anything on the other.
 *
 * Mainnet is strict. Values that have a sensible testnet default have none
 * on mainnet and must be given, and anything given has to agree with what
 * the network itself says, or the backend refuses to start.
 */

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  /** The CAIP-2 identifier x402 uses. */
  caip2: "stellar:testnet" | "stellar:pubnet";
  passphrase: string;
  rpcUrl: string;
  /** Circle's classic USDC issuer on this network. */
  usdcIssuer: string;
  /** The Stellar Asset Contract for that USDC, derived from the issuer. */
  usdcContract: string;
  /** Explorer base, e.g. `${explorer}/tx/<hash>`. */
  explorer: string;
  facilitatorUrl: string;
}

interface NetworkDefaults {
  caip2: NetworkConfig["caip2"];
  passphrase: string;
  rpcUrl?: string;
  usdcIssuer: string;
  explorer: string;
  facilitatorUrl: string;
}

const DEFAULTS: Record<NetworkName, NetworkDefaults> = {
  testnet: {
    caip2: "stellar:testnet",
    passphrase: StellarSdk.Networks.TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
    usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    explorer: "https://stellar.expert/explorer/testnet",
    facilitatorUrl: "https://channels.openzeppelin.com/x402/testnet",
  },
  mainnet: {
    caip2: "stellar:pubnet",
    passphrase: StellarSdk.Networks.PUBLIC,
    // There is no public mainnet RPC run by the network itself. One has to
    // be chosen and named.
    rpcUrl: undefined,
    usdcIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    explorer: "https://stellar.expert/explorer/public",
    facilitatorUrl: "https://channels.openzeppelin.com/x402",
  },
};

export class NetworkConfigError extends Error {}

/** The token contract for an issuer's USDC, which is fixed by the network. */
export function usdcContractFor(issuer: string, passphrase: string): string {
  return new StellarSdk.Asset("USDC", issuer).contractId(passphrase);
}

type Env = Record<string, string | undefined>;

/**
 * Work out the network configuration from the environment, refusing anything
 * inconsistent.
 *
 * BEAVER_NETWORK picks the network. Left out it means testnet, which is what
 * a fresh checkout runs against; mainnet always has to be asked for by name.
 */
export function loadNetworkConfig(env: Env = process.env): NetworkConfig {
  const requested = (env.BEAVER_NETWORK ?? "testnet").trim();
  if (requested !== "testnet" && requested !== "mainnet") {
    throw new NetworkConfigError(
      `BEAVER_NETWORK must be testnet or mainnet, got "${requested}"`
    );
  }
  const name: NetworkName = requested;
  const defaults = DEFAULTS[name];

  // A passphrase given explicitly is a statement of intent. It has to be
  // the one for the network that was picked.
  if (env.NETWORK_PASSPHRASE && env.NETWORK_PASSPHRASE !== defaults.passphrase) {
    throw new NetworkConfigError(
      `NETWORK_PASSPHRASE is "${env.NETWORK_PASSPHRASE}", which is not the ${name} passphrase`
    );
  }

  const rpcUrl = env.SOROBAN_RPC_URL || defaults.rpcUrl;
  if (!rpcUrl) {
    throw new NetworkConfigError(`SOROBAN_RPC_URL is required on ${name}`);
  }
  if (name === "mainnet" && !rpcUrl.startsWith("https://")) {
    throw new NetworkConfigError("SOROBAN_RPC_URL has to be https on mainnet");
  }
  if (name === "mainnet" && /testnet|futurenet/i.test(rpcUrl)) {
    throw new NetworkConfigError(`SOROBAN_RPC_URL ${rpcUrl} looks like a test network`);
  }

  const usdcContract = usdcContractFor(defaults.usdcIssuer, defaults.passphrase);
  if (env.USDC_CONTRACT && env.USDC_CONTRACT !== usdcContract) {
    throw new NetworkConfigError(
      `USDC_CONTRACT is ${env.USDC_CONTRACT}, but USDC on ${name} is ${usdcContract}`
    );
  }

  const facilitatorUrl = env.FACILITATOR_URL || defaults.facilitatorUrl;
  if (name === "mainnet" && /testnet/i.test(facilitatorUrl)) {
    throw new NetworkConfigError(`FACILITATOR_URL ${facilitatorUrl} is a testnet facilitator`);
  }

  return {
    name,
    caip2: defaults.caip2,
    passphrase: defaults.passphrase,
    rpcUrl,
    usdcIssuer: defaults.usdcIssuer,
    usdcContract,
    explorer: defaults.explorer,
    facilitatorUrl,
  };
}

let cached: NetworkConfig | null = null;

/** The configuration for this process, worked out once. */
export function network(): NetworkConfig {
  if (!cached) {
    cached = loadNetworkConfig();
  }
  return cached;
}

/** Forget the cached configuration. Tests change the environment. */
export function resetNetworkConfig(): void {
  cached = null;
  verified = null;
}

let verified: Promise<void> | null = null;

/**
 * Confirm the RPC endpoint really serves the configured network.
 *
 * The passphrase check above only compares configuration with itself. This
 * one asks the endpoint, so an RPC URL for the wrong network is caught
 * before anything is signed against it rather than after.
 */
export function verifyNetwork(
  config: NetworkConfig = network(),
  server: Pick<StellarSdk.rpc.Server, "getNetwork"> = new StellarSdk.rpc.Server(config.rpcUrl)
): Promise<void> {
  if (!verified) {
    verified = server.getNetwork().then((reported) => {
      if (reported.passphrase !== config.passphrase) {
        throw new NetworkConfigError(
          `${config.rpcUrl} serves "${reported.passphrase}", not ${config.name}`
        );
      }
    });
    // A failed check is not remembered, so a passing retry can succeed.
    verified.catch(() => {
      verified = null;
    });
  }
  return verified;
}

/** A Soroban RPC client for the configured network. */
export function rpcServer(config: NetworkConfig = network()): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(config.rpcUrl);
}

export function explorerTx(hash: string, config: NetworkConfig = network()): string {
  return `${config.explorer}/tx/${hash}`;
}

export function explorerContract(id: string, config: NetworkConfig = network()): string {
  return `${config.explorer}/contract/${id}`;
}
