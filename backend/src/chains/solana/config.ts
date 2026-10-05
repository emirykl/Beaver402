import { address, createSolanaRpc, type Address } from "@solana/kit";

import { NetworkConfigError } from "../../config/network.js";

/**
 * Which Solana cluster this backend talks to, and everything that follows
 * from it.
 *
 * Only devnet for now. The pilot's money is on Stellar mainnet; Solana is
 * brought up on devnet first, and mainnet has to be added here deliberately,
 * with its own checks, before anything can be signed for it.
 */
export interface SolanaConfig {
  cluster: "devnet";
  /** The CAIP-2 id x402 uses, also what a challenge's network field holds. */
  caip2: string;
  /** What getGenesisHash returns on this cluster. */
  genesisHash: string;
  rpcUrl: string;
  /** Circle's USDC on this cluster. */
  usdcMint: Address;
  usdcDecimals: number;
  programId: Address;
  /** The policy account, once it exists. */
  policy: Address | null;
  explorer: string;
}

/** CAIP-2 names a cluster by the first 32 characters of its genesis hash. */
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PROGRAM_ID = "6PLoS71vwBV76RnRWuT3yoPHqzXrBdkW53Dn3BL9Uhx5";

type Env = Record<string, string | undefined>;

export function loadSolanaConfig(env: Env = process.env): SolanaConfig {
  const cluster = (env.SOLANA_CLUSTER ?? "devnet").trim();
  if (cluster !== "devnet") {
    throw new NetworkConfigError(`SOLANA_CLUSTER must be devnet, got "${cluster}"`);
  }

  const mint = env.SOLANA_USDC_MINT || DEVNET_USDC;
  if (mint !== DEVNET_USDC) {
    throw new NetworkConfigError(`SOLANA_USDC_MINT is ${mint}, but USDC on devnet is ${DEVNET_USDC}`);
  }

  const rpcUrl = env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  if (/mainnet/i.test(rpcUrl)) {
    throw new NetworkConfigError(`SOLANA_RPC_URL ${rpcUrl} looks like mainnet`);
  }

  return {
    cluster: "devnet",
    caip2: `solana:${DEVNET_GENESIS.slice(0, 32)}`,
    genesisHash: DEVNET_GENESIS,
    rpcUrl,
    usdcMint: address(mint),
    usdcDecimals: 6,
    programId: address(env.SOLANA_PROGRAM_ID || PROGRAM_ID),
    policy: env.SOLANA_POLICY_ADDRESS ? address(env.SOLANA_POLICY_ADDRESS) : null,
    explorer: "https://explorer.solana.com",
  };
}

let cached: SolanaConfig | null = null;

export function solana(): SolanaConfig {
  if (!cached) cached = loadSolanaConfig();
  return cached;
}

export function resetSolanaConfig(): void {
  cached = null;
  verified = null;
}

export function solanaRpc(config: SolanaConfig = solana()) {
  return createSolanaRpc(config.rpcUrl);
}

export type SolanaRpc = ReturnType<typeof solanaRpc>;

let verified: Promise<void> | null = null;

/**
 * Confirm the RPC endpoint serves the configured cluster, by its genesis
 * hash, before anything is signed against it.
 */
export function verifySolanaNetwork(
  config: SolanaConfig = solana(),
  rpc: Pick<SolanaRpc, "getGenesisHash"> = solanaRpc(config)
): Promise<void> {
  if (!verified) {
    verified = rpc
      .getGenesisHash()
      .send()
      .then((hash) => {
        if (hash !== config.genesisHash) {
          throw new NetworkConfigError(`${config.rpcUrl} serves genesis ${hash}, not ${config.cluster}`);
        }
      });
    verified.catch(() => {
      verified = null;
    });
  }
  return verified;
}

export function requirePolicy(config: SolanaConfig = solana()): Address {
  if (!config.policy) {
    throw new Error("SOLANA_POLICY_ADDRESS is required. Create the account with npm run solana:init");
  }
  return config.policy;
}

export function solanaExplorerTx(signature: string, config: SolanaConfig = solana()): string {
  return `${config.explorer}/tx/${signature}?cluster=${config.cluster}`;
}

export function solanaExplorerAccount(account: string, config: SolanaConfig = solana()): string {
  return `${config.explorer}/address/${account}?cluster=${config.cluster}`;
}

/**
 * The useful part of an RPC failure. A refused simulation carries the
 * program's logs in its context, and the logs are where Anchor names the
 * error, so they are what the backend reads the reason from.
 */
export function solanaErrorText(err: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const context = (current as { context?: { logs?: unknown } }).context;
    if (Array.isArray(context?.logs) && context.logs.length > 0) {
      return context.logs.join("\n");
    }
    current = (current as { cause?: unknown }).cause;
  }
  return err instanceof Error ? err.message : String(err);
}
