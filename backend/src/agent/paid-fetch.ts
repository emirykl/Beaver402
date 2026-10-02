import type { Beaver402Adapter, PreparedPayment } from "../adapter/x402-client.js";
import { describePolicyError } from "../shared/policy-errors.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { explorerTx, network } from "../config/network.js";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  EXTENSION,
  HEADERS,
  type Beaver402Receipt,
  type PaymentRequired,
  type SettleResponse,
} from "../x402/protocol.js";

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
    explorerUrl?: string;
    proofTxHash?: string;
    challengeHash?: string;
    intentHash?: string;
    amount: string;
    asset: string;
    recipient: string;
    network: string;
  };
  error?: string;
}

/** Injected so the orchestration can be tested without a live merchant. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json: () => Promise<unknown>;
}>;

/**
 * Read the x402 v2 payment request out of a 402 answer.
 *
 * The standard place is the PAYMENT-REQUIRED header. The same object in the
 * body is accepted too. Anything else means the merchant is not speaking the
 * protocol, which is reported rather than guessed at, because a half
 * understood request is exactly the situation the proof of intent exists to
 * prevent.
 */
export function readPaymentRequired(
  header: string | null,
  body: unknown
): PaymentRequired | null {
  if (header) {
    try {
      return decodePaymentRequiredHeader(header);
    } catch {
      return null;
    }
  }
  if (body && typeof body === "object" && Array.isArray((body as PaymentRequired).accepts)) {
    return body as PaymentRequired;
  }
  return null;
}

function readSettlement(header: string | null): SettleResponse | null {
  if (!header) return null;
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}

interface LogEntry {
  prepared: PreparedPayment;
  success: boolean;
  txHash?: string;
  proofTxHash?: string;
  error?: string;
}

/** Keep a record of every attempt. A logging failure never stops a payment. */
async function logPayment(entry: LogEntry): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const { prepared } = entry;
  const fields = prepared.challenge?.fields;
  try {
    await getSupabase().from("transactions").insert({
      tx_hash: entry.txHash ?? null,
      challenge_hash: prepared.challengeHash ?? null,
      intent_hash: prepared.intentHash ?? null,
      merchant_pubkey: prepared.challenge?.merchantPubkey ?? null,
      recipient: fields?.recipient ?? null,
      asset: fields?.asset ?? null,
      amount: fields?.amount ?? null,
      network: network().passphrase,
      status: entry.success ? "success" : "failed",
      error: entry.error ?? null,
      facilitator: entry.success ? network().facilitatorUrl : null,
      proof_tx_hash: entry.proofTxHash ?? null,
    });
  } catch {
    // logging failure should not break the payment flow
  }
}

/**
 * Fetch a resource, and pay for it if the merchant asks for payment.
 *
 * This is the whole point of the project in one function. The request is made
 * once to learn the price. The adapter independently reconstructs what was
 * asked for, and only if it agrees with the merchant's signed challenge does
 * the policy account authorize the transfer. The request is then repeated
 * with that authorization, the merchant has an x402 facilitator settle it,
 * and the content comes back. The caller never handles a key and never sees
 * one.
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

  const required = readPaymentRequired(first.headers.get(HEADERS.required), firstBody);
  if (!required) {
    return {
      status: 402,
      paid: false,
      content: firstBody,
      error: "the merchant asked for payment without an x402 v2 payment request",
    };
  }

  // The adapter builds its own view of the request from what was actually
  // sent, not from what the merchant claims was sent. Disagreement between
  // the two is what stops here.
  const prepared = await adapter.preparePayment(required, method, request.url, body ?? null);
  if (!prepared.success || !prepared.payload) {
    // The payment log keeps the raw host error. What the caller is told, and
    // what a model repeats back to someone, is the reason inside it.
    await logPayment({ prepared, success: false, error: prepared.error });
    return {
      status: 402,
      paid: false,
      content: firstBody,
      error: describePolicyError(prepared.error) || "payment was refused",
    };
  }

  const second = await fetchImpl(request.url, {
    method,
    headers: { ...headers, [HEADERS.signature]: encodePaymentSignatureHeader(prepared.payload) },
    body,
  });
  const content = await second.json();
  const settlement = readSettlement(second.headers.get(HEADERS.response));
  const receipt = settlement?.extensions?.[EXTENSION] as Beaver402Receipt | undefined;

  if (second.status !== 200 || !settlement?.success) {
    const reason =
      settlement?.errorReason ??
      (content && typeof content === "object" && "error" in content
        ? String((content as { error: unknown }).error)
        : `the merchant answered ${second.status}`);
    await logPayment({ prepared, success: false, txHash: settlement?.transaction || undefined, error: reason });
    return { status: second.status, paid: false, content, error: reason };
  }

  await logPayment({
    prepared,
    success: true,
    txHash: settlement.transaction,
    proofTxHash: receipt?.proofTransaction,
  });

  const fields = prepared.challenge!.fields;
  return {
    status: second.status,
    paid: true,
    content,
    payment: {
      txHash: settlement.transaction,
      explorerUrl: explorerTx(settlement.transaction),
      proofTxHash: receipt?.proofTransaction,
      challengeHash: prepared.challengeHash,
      intentHash: prepared.intentHash,
      amount: fields.amount,
      asset: fields.asset,
      recipient: fields.recipient,
      network: settlement.network,
    },
  };
}
