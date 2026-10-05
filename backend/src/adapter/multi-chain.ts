import type { PaymentRequired } from "../x402/protocol.js";
import type { ChainId } from "../chains/registry.js";
import type { PreparedPayment } from "./x402-client.js";

/** What the agent needs from a chain: decide, then build the payment. */
export interface PaymentAdapter {
  preparePayment(
    required: PaymentRequired,
    observedMethod: string,
    observedEndpoint: string,
    observedBody?: string | Buffer | null
  ): Promise<PreparedPayment>;
}

export interface ChainAdapter extends PaymentAdapter {
  /** Whether the merchant offers a payment this chain can make. */
  accepts(required: PaymentRequired): boolean;
}

/**
 * The agent on several chains at once.
 *
 * The merchant lists every network it accepts. The agent pays on the first
 * of its own chains, in the order of preference, that the merchant offers.
 * Nothing is tried on a second chain after a refusal on the first: a policy
 * that says no on one chain is not overruled by asking another.
 */
export class MultiChainAdapter implements PaymentAdapter {
  constructor(private readonly chains: ReadonlyArray<{ chain: ChainId; adapter: ChainAdapter }>) {}

  async preparePayment(
    required: PaymentRequired,
    observedMethod: string,
    observedEndpoint: string,
    observedBody?: string | Buffer | null
  ): Promise<PreparedPayment> {
    const chosen = this.chains.find(({ adapter }) => adapter.accepts(required));
    if (!chosen) {
      const offered = (required.accepts ?? []).map((r) => r.network).join(", ") || "nothing";
      return {
        success: false,
        error: `the merchant accepts ${offered}, and this agent pays on ${this.chains.map((c) => c.chain).join(", ")}`,
      };
    }
    return chosen.adapter.preparePayment(required, observedMethod, observedEndpoint, observedBody);
  }
}

/** The agent's chains in the order it prefers them. */
export function chainPreference(enabled: ChainId[], env: Record<string, string | undefined> = process.env): ChainId[] {
  const preferred = (env.AGENT_CHAIN_PREFERENCE ?? "stellar,solana")
    .split(",")
    .map((c) => c.trim())
    .filter((c): c is ChainId => enabled.includes(c as ChainId));
  return [...new Set([...preferred, ...enabled])];
}
