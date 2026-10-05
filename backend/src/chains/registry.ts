/**
 * Which chains this deployment works on.
 *
 * BEAVER_CHAINS lists them, comma separated. Left out it means Stellar
 * alone, which is what every deployment before Solana ran, so turning
 * Solana on is always a deliberate change.
 */
export type ChainId = "stellar" | "solana";

const KNOWN: readonly ChainId[] = ["stellar", "solana"];

export function enabledChains(env: Record<string, string | undefined> = process.env): ChainId[] {
  const listed = (env.BEAVER_CHAINS ?? "stellar")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  for (const chain of listed) {
    if (!KNOWN.includes(chain as ChainId)) {
      throw new Error(`BEAVER_CHAINS names an unknown chain "${chain}", expected stellar or solana`);
    }
  }
  return [...new Set(listed)] as ChainId[];
}

export function isChainEnabled(chain: ChainId, env: Record<string, string | undefined> = process.env): boolean {
  return enabledChains(env).includes(chain);
}
