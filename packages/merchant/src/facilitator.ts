import { HTTPFacilitatorClient } from "@x402/core/server";

import { X402_VERSION, type PaymentPayload, type PaymentRequirements, type SettleResponse } from "./protocol.js";

/** The two calls an x402 facilitator answers for a merchant. */
export interface Facilitator {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string; invalidMessage?: string }>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  /** Whether it settles x402 v2 exact payments on this CAIP-2 network. */
  supports(caip2: string): Promise<boolean>;
}

/** An x402 facilitator reached over HTTP, such as OpenZeppelin Channels. */
export function httpFacilitator(url: string, apiKey: string): Facilitator {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const client = new HTTPFacilitatorClient({
    url,
    createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
  });
  return {
    verify: (payload, requirements) => client.verify(payload, requirements),
    settle: (payload, requirements) => client.settle(payload, requirements),
    async supports(caip2) {
      const answer = await client.getSupported();
      return answer.kinds.some((k) => k.x402Version === X402_VERSION && k.scheme === "exact" && k.network === caip2);
    },
  };
}
