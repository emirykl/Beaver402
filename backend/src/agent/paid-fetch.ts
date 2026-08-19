import type { Beaver402Adapter, PaymentResult } from "../adapter/x402-client.js";
import type { SignedChallenge } from "../shared/types.js";
import { describePolicyError } from "../shared/policy-errors.js";

export interface PaidFetchRequest {
  url: string;
  method?: string;
  body?: string | null;
  headers?: Record<string, string>;
}

export interface PaidFetchResult {
  status: number;
  paid: boolean;
  content: unknown;
  payment?: {
    txHash?: string;
    challengeHash?: string;
    intentHash?: string;
    amount: string;
    asset: string;
    recipient: string;
  };
  error?: string;
}

/** Injected so the orchestration can be tested without a live merchant. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/**
 * Read the signed challenge out of a 402 body.
 *
 * Anything missing means the merchant is not speaking the protocol, which is
 * reported rather than guessed at, because a half understood challenge is
 * exactly the situation the proof of intent exists to prevent.
 */
export function extractChallenge(body: unknown): SignedChallenge | null {
  if (!body || typeof body !== "object") return null;

  const challenge = (body as Record<string, unknown>).challenge;
  if (!challenge || typeof challenge !== "object") return null;

  const candidate = challenge as Record<string, unknown>;
  if (
    !candidate.fields ||
    typeof candidate.hash !== "string" ||
    typeof candidate.merchantSignature !== "string" ||
    typeof candidate.merchantPubkey !== "string"
  ) {
    return null;
  }

  return candidate as unknown as SignedChallenge;
}

/**
 * Fetch a resource, and pay for it if the merchant asks for payment.
 *
 * This is the whole point of the project in one function. The request is made
 * once to learn the price, the adapter independently reconstructs what was
 * asked for and settles it through the policy account, and only then is the
 * request repeated. The caller never handles a key and never sees one.
 */
export async function paidFetch(
  request: PaidFetchRequest,
  adapter: Beaver402Adapter,
  fetchImpl: FetchLike
): Promise<PaidFetchResult> {
  const method = (request.method ?? "GET").toUpperCase();
  const headers = { "content-type": "application/json", ...(request.headers ?? {}) };
  const body = request.body ?? undefined;

  const first = await fetchImpl(request.url, { method, headers, body });
  const firstBody = await first.json();

  if (first.status !== 402) {
    return { status: first.status, paid: false, content: firstBody };
  }

  const challenge = extractChallenge(firstBody);
  if (!challenge) {
    return {
      status: 402,
      paid: false,
      content: firstBody,
      error: "the merchant asked for payment without a usable signed challenge",
    };
  }

  // The adapter builds its own view of the request from what was actually
  // sent, not from what the merchant claims was sent. Disagreement between
  // the two is what stops here.
  const result: PaymentResult = await adapter.processPayment(
    challenge,
    method,
    request.url,
    body ?? null
  );

  if (!result.success) {
    // The payment log keeps the raw host error. What the caller is told, and
    // what a model repeats back to someone, is the reason inside it.
    return {
      status: 402,
      paid: false,
      content: firstBody,
      error: describePolicyError(result.error) || "payment was refused",
    };
  }

  const second = await fetchImpl(request.url, {
    method,
    headers: { ...headers, "x-payment-response": result.txHash ?? "" },
    body,
  });

  return {
    status: second.status,
    paid: true,
    content: await second.json(),
    payment: {
      txHash: result.txHash,
      challengeHash: result.challengeHash,
      intentHash: result.intentHash,
      amount: challenge.fields.amount,
      asset: challenge.fields.asset,
      recipient: challenge.fields.recipient,
    },
  };
}
