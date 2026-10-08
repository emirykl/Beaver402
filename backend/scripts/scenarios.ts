/**
 * Run the adversarial scenarios against the deployed contract.
 *
 * Every case here is something the policy is supposed to refuse, plus the
 * cases it is supposed to allow. The output is the evidence that the
 * refusals happen for the stated reason rather than by accident.
 *
 * Allowed payments go all the way: the merchant's 402, the policy account's
 * authorization, the x402 facilitator's settlement and the merchant's own
 * confirmation on the ledger. Refused ones never reach the facilitator.
 * Some are stopped by the adapter, which will not sign what it can see is
 * wrong. The rest are stopped by the contract itself, in the simulation the
 * adapter runs before anything is sent, and the contract's own error code is
 * reported.
 *
 * The merchant has to be running. On testnet that is the backend with
 * BEAVER402_ROLE=all.
 *
 * Run with: npm run scenarios [merchantUrl] [agentUrl]
 *
 * On mainnet the agent and the merchant are separate deployments, so the
 * account's state is read from the agent when its URL is given.
 */
import { Keypair } from "@stellar/stellar-sdk";

import { createAdapter } from "../src/adapter/x402-client.js";
import { createSignedChallenge } from "../src/merchant/challenge-signer.js";
import { paidFetch, readPaymentRequired, type FetchLike } from "../src/agent/paid-fetch.js";
import { policyErrorName } from "../src/shared/policy-errors.js";
import { network } from "../src/config/network.js";
import { challengeFrom, HEADERS, type PaymentRequired } from "../src/x402/protocol.js";
import type { SignedChallenge } from "../src/shared/types.js";

const MERCHANT = process.argv[2] || `http://localhost:${process.env.PORT || 3000}`;
const ENDPOINT = `${MERCHANT}/api/data`;
const AGENT = process.argv[3] || MERCHANT;

const adapter = createAdapter(process.env.AGENT_SECRET!, process.env.POLICY_CONTRACT_ID!);

const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    json: async () => {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    },
  };
};

interface Outcome {
  name: string;
  expected: "allowed" | "refused";
  actual: "allowed" | "refused";
  reason?: string;
  txHash?: string;
}

const results: Outcome[] = [];

function record(
  name: string,
  expected: Outcome["expected"],
  paid: boolean,
  reason?: string,
  txHash?: string
) {
  const actual = paid ? "allowed" : "refused";
  const explained = policyErrorName(reason) ?? reason;
  results.push({ name, expected, actual, reason: explained, txHash });

  const mark = actual === expected ? "ok" : "UNEXPECTED";
  console.log(`  ${mark.padEnd(10)} ${name}`);
  if (explained) {
    console.log(`             ${explained.split("\n")[0]!.slice(0, 400)}`);
  }
  if (txHash) console.log(`             tx ${txHash}`);
}

/** Ask the merchant for a fresh 402. */
async function paymentRequiredFor(url = ENDPOINT, method = "GET", body?: string): Promise<PaymentRequired> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
  const required = readPaymentRequired(response.headers.get(HEADERS.required), await response.json());
  if (!required) throw new Error(`${url} did not answer with an x402 payment request`);
  return required;
}

/** The same 402 carrying a different challenge. */
function withChallenge(required: PaymentRequired, challenge: SignedChallenge): PaymentRequired {
  return { ...required, extensions: { ...required.extensions, beaver402: { challenge } } };
}

/** A challenge for the same request, signed by the merchant with other terms. */
function resigned(
  required: PaymentRequired,
  changes: { amount?: string; expirySeconds?: number; signer?: Keypair; asset?: string }
): PaymentRequired {
  const original = challengeFrom(required)!;
  const challenge = createSignedChallenge({
    merchantKeypair: changes.signer ?? Keypair.fromSecret(process.env.MERCHANT_SECRET!),
    httpMethod: original.fields.httpMethod,
    endpoint: original.fields.normalizedEndpoint,
    recipient: original.fields.recipient,
    asset: changes.asset ?? original.fields.asset,
    amount: changes.amount ?? original.fields.amount,
    network: original.fields.network,
    expirySeconds: changes.expirySeconds,
  });
  const accepts = required.accepts.map((r) => ({ ...r, amount: changes.amount ?? r.amount }));
  return withChallenge({ ...required, accepts }, challenge);
}

/** What the adapter decides, without going to the merchant. */
async function decide(required: PaymentRequired, method = "GET", endpoint = ENDPOINT, body: string | null = null) {
  const prepared = await adapter.preparePayment(required, method, endpoint, body);
  return { paid: prepared.success, reason: prepared.error };
}

async function readState(): Promise<{ frozen: boolean; txCount: number; max: number }> {
  const response = await fetch(`${AGENT}/api/policy/state`);
  const state = (await response.json()) as { frozen: boolean; velocityTxCount: number; velocityMaxTxCount: number };
  return { frozen: state.frozen, txCount: state.velocityTxCount, max: state.velocityMaxTxCount };
}

async function main() {
  console.log(`\nRunning scenarios against ${MERCHANT} on ${network().name}`);

  const state = await readState();
  console.log(
    `Contract ${process.env.POLICY_CONTRACT_ID}\n` +
      `Frozen: ${state.frozen}   Payments in the window: ${state.txCount} of ${state.max}\n`
  );

  if (state.frozen) {
    // A frozen account is itself worth showing, and nothing else can be
    // demonstrated until the owner thaws it with their passkey.
    const blocked = await decide(await paymentRequiredFor());
    record("a payment while the account is frozen", "refused", blocked.paid, blocked.reason);
    console.log(
      "\nThe account is frozen, so the remaining scenarios cannot run.\n" +
        "Restore it from the control panel with the owner passkey, then run this again.\n"
    );
    return;
  }

  // Each allowed payment uses one slot of the velocity window. Leave room
  // for them, or the refusals below would all read as VelocityExceeded.
  if (state.max - state.txCount < 2) {
    console.log("Fewer than two payments are left in the velocity window. Run this again once it has room.\n");
    return;
  }

  // ── The case that has to work ───────────────────────────────────
  const good = await paidFetch({ url: ENDPOINT }, adapter, nodeFetch);
  record("a payment both parties agree on, settled by the facilitator", "allowed", good.paid, good.error, good.payment?.txHash);
  if (good.payment?.proofTxHash) {
    console.log(`             proof of intent ${good.payment.proofTxHash}`);
  }

  // ── What the merchant signed has to be what was sent ────────────
  const required = await paymentRequiredFor();
  const endpoint = await decide(required, "GET", `${MERCHANT}/api/something-else`);
  record("the endpoint changed after the merchant signed", "refused", endpoint.paid, endpoint.reason);

  const query = await decide(required, "GET", `${ENDPOINT}?item=other`);
  record("a query parameter was added after the merchant signed", "refused", query.paid, query.reason);

  const method = await decide(await paymentRequiredFor(), "POST");
  record("the method changed after the merchant signed", "refused", method.paid, method.reason);

  const body = await decide(await paymentRequiredFor(), "GET", ENDPOINT, '{"injected":true}');
  record("a body was added after the merchant signed", "refused", body.paid, body.reason);

  // ── The x402 requirements have to agree with the challenge ──────
  const cheaper = await paymentRequiredFor();
  cheaper.accepts[0]!.payTo = Keypair.random().publicKey();
  const rerouted = await decide(cheaper);
  record("the requirements send the payment somewhere else", "refused", rerouted.paid, rerouted.reason);

  // ── These have to be refused by the contract itself ─────────────
  const stranger = await decide(resigned(await paymentRequiredFor(), { signer: Keypair.random() }));
  record("a merchant nobody approved", "refused", stranger.paid, stranger.reason);

  const tooMuch = await decide(resigned(await paymentRequiredFor(), { amount: "15000000" }));
  record("a single payment over the per payment limit", "refused", tooMuch.paid, tooMuch.reason);

  const tooLong = await decide(resigned(await paymentRequiredFor(), { expirySeconds: 3600 }));
  record("a challenge valid for longer than the account allows", "refused", tooLong.paid, tooLong.reason);

  const expired = await decide(resigned(await paymentRequiredFor(), { expirySeconds: -60 }));
  record("a challenge that already expired", "refused", expired.paid, expired.reason);

  // ── A challenge pays once ───────────────────────────────────────
  const once = await paymentRequiredFor();
  const first = await paidFetch({ url: ENDPOINT }, adapter, async (url, init) => {
    // Answer the first request with this 402, so the challenge is known.
    if (!init.headers[HEADERS.signature]) {
      return {
        status: 402,
        headers: { get: () => null },
        json: async () => once,
      };
    }
    return nodeFetch(url, init);
  });
  record("the same challenge, used once", "allowed", first.paid, first.error, first.payment?.txHash);

  const second = await decide(once);
  record("the same challenge, used twice", "refused", second.paid, second.reason);

  // ── Summary ─────────────────────────────────────────────────────
  const surprises = results.filter((r) => r.actual !== r.expected);
  console.log(`\n${results.length} scenarios, ${surprises.length} unexpected\n`);

  if (surprises.length > 0) {
    for (const s of surprises) {
      console.log(`  expected ${s.expected}, got ${s.actual}: ${s.name}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
