/**
 * Run the adversarial scenarios against the deployed contract.
 *
 * Every case here is something the policy is supposed to refuse, plus the
 * one case it is supposed to allow. The output is the evidence that the
 * refusals happen for the stated reason rather than by accident.
 *
 * The backend has to be running, because the demo merchant lives in it.
 *
 * Run with: npm run scenarios [backendUrl]
 */
import { Keypair } from "@stellar/stellar-sdk";

import { createAdapter } from "../src/adapter/x402-client.js";
import { createSignedChallenge } from "../src/merchant/challenge-signer.js";
import { paidFetch, type FetchLike } from "../src/agent/paid-fetch.js";
import type { SignedChallenge } from "../src/shared/types.js";
import { policyErrorName } from "../src/shared/policy-errors.js";

const BACKEND = process.argv[2] || "http://localhost:3010";
const ENDPOINT = `${BACKEND}/api/data`;

const adapter = createAdapter(
  process.env.AGENT_SECRET!,
  process.env.POLICY_CONTRACT_ID!
);

const nodeFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
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

/** Fetch a challenge from the demo merchant. */
async function challengeFor(url: string): Promise<SignedChallenge> {
  const response = await fetch(url);
  const body = (await response.json()) as { challenge: SignedChallenge };
  return body.challenge;
}

/** Settle a challenge directly, skipping the adapter's own field check, so
 *  the refusal comes from the contract rather than from the client. */
async function settle(
  challenge: SignedChallenge,
  method = "GET",
  endpoint = ENDPOINT,
  body: string | null = null
) {
  return adapter.processPayment(challenge, method, endpoint, body);
}

/** What the contract says about itself before anything is attempted. */
async function readState(): Promise<{ frozen: boolean; txCount: number }> {
  const response = await fetch(`${BACKEND}/api/policy/state`);
  const state = (await response.json()) as {
    frozen: boolean;
    velocityTxCount: number;
  };
  return { frozen: state.frozen, txCount: state.velocityTxCount };
}

async function main() {
  console.log(`\nRunning scenarios against ${BACKEND}`);

  const state = await readState();
  console.log(
    `Contract ${process.env.POLICY_CONTRACT_ID}\n` +
      `Frozen: ${state.frozen}   Payments this window: ${state.txCount}\n`
  );

  if (state.frozen) {
    // A frozen account is itself worth showing, and nothing else can be
    // demonstrated until the owner thaws it with their passkey.
    const blocked = await settle(await challengeFor(ENDPOINT));
    record(
      "a payment while the account is frozen",
      "refused",
      blocked.success,
      blocked.error
    );

    console.log(
      "\nThe account is frozen, so the remaining scenarios cannot run.\n" +
        "Restore it from the control panel with the owner passkey, then run this again.\n"
    );
    return;
  }

  // ── The case that has to work ───────────────────────────────────
  const good = await paidFetch({ url: ENDPOINT }, adapter, nodeFetch);
  record(
    "a payment both parties agree on",
    "allowed",
    good.paid,
    good.error,
    good.payment?.txHash
  );

  // ── What the merchant signed has to be what was sent ────────────
  const challenge = await challengeFor(ENDPOINT);
  const tampered = await settle(challenge, "GET", `${BACKEND}/api/something-else`);
  record(
    "the endpoint changed after the merchant signed",
    "refused",
    tampered.success,
    tampered.error
  );

  const methodSwap = await settle(await challengeFor(ENDPOINT), "POST");
  record(
    "the method changed after the merchant signed",
    "refused",
    methodSwap.success,
    methodSwap.error
  );

  const bodyAdded = await settle(
    await challengeFor(ENDPOINT),
    "GET",
    ENDPOINT,
    '{"injected":true}'
  );
  record(
    "a body was added after the merchant signed",
    "refused",
    bodyAdded.success,
    bodyAdded.error
  );

  // ── These have to be refused on chain ───────────────────────────
  const stranger = Keypair.random();
  const forged = createSignedChallenge({
    merchantKeypair: stranger,
    httpMethod: "GET",
    endpoint: ENDPOINT,
    recipient: challenge.fields.recipient,
    asset: challenge.fields.asset,
    amount: challenge.fields.amount,
    network: challenge.fields.network,
  });
  const untrusted = await settle(forged);
  record(
    "a merchant nobody approved",
    "refused",
    untrusted.success,
    untrusted.error
  );

  const replayed = await challengeFor(ENDPOINT);
  const first = await settle(replayed);
  record(
    "the same challenge, used once",
    "allowed",
    first.success,
    first.error,
    first.txHash
  );
  const second = await settle(replayed);
  record(
    "the same challenge, used twice",
    "refused",
    second.success,
    second.error
  );

  const expired = createSignedChallenge({
    merchantKeypair: Keypair.fromSecret(process.env.MERCHANT_SECRET!),
    httpMethod: "GET",
    endpoint: ENDPOINT,
    recipient: challenge.fields.recipient,
    asset: challenge.fields.asset,
    amount: challenge.fields.amount,
    network: challenge.fields.network,
    expirySeconds: -60,
  });
  const stale = await settle(expired);
  record("a challenge that already expired", "refused", stale.success, stale.error);

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
