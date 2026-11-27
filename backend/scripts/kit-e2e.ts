/**
 * Pay a merchant built with @beaver402/merchant from the testnet agent, the
 * way an AI agent would, and check what it refuses.
 *
 * It expects the kit's example server (packages/merchant/example): a GET
 * /forecast and a POST /summarize, both behind Beaver402. Each paid call
 * uses one slot of the policy account's 24 hour window.
 *
 * Run with: npm run kit:e2e -- <merchantUrl> [--refusals-only]
 */
import { Keypair } from "@stellar/stellar-sdk";

import { createAdapter } from "../src/adapter/x402-client.js";
import { paidFetch, readPaymentRequired, type FetchLike } from "../src/agent/paid-fetch.js";
import { createSignedChallenge } from "../src/merchant/challenge-signer.js";
import { policyErrorName } from "../src/shared/policy-errors.js";
import { explorerTx, network } from "../src/config/network.js";
import { challengeFrom, HEADERS, type PaymentRequired } from "../src/x402/protocol.js";

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: npm run kit:e2e -- <merchantUrl> [--refusals-only]");
  process.exit(2);
}
const refusalsOnly = process.argv.includes("--refusals-only");
if (network().name !== "testnet") {
  console.error("kit:e2e runs on testnet only");
  process.exit(2);
}

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

let surprises = 0;
function report(name: string, expected: "paid" | "refused", paid: boolean, detail?: string, links: string[] = []) {
  const ok = (expected === "paid") === paid;
  if (!ok) surprises++;
  console.log(`  ${(ok ? "ok" : "UNEXPECTED").padEnd(10)} ${name}`);
  if (detail) console.log(`             ${(policyErrorName(detail) ?? detail).split("\n")[0]!.slice(0, 300)}`);
  for (const link of links) console.log(`             ${link}`);
}

async function required(url: string, method = "GET", body?: string): Promise<PaymentRequired> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body });
  const answer = readPaymentRequired(res.headers.get(HEADERS.required), await res.json());
  if (!answer) throw new Error(`${url} answered ${res.status} without an x402 payment request`);
  return answer;
}

async function main() {
  const info = (await (await fetch(`${BASE}/merchant`)).json()) as { merchantPubkey: string; recipient: string };
  console.log(`\nPaying ${BASE} from ${process.env.POLICY_CONTRACT_ID} on testnet`);
  console.log(`merchant ${info.merchantPubkey}, recipient ${info.recipient}\n`);

  if (!refusalsOnly) {
    for (const call of [
      { name: "GET /forecast?city=Ankara", url: `${BASE}/forecast?city=Ankara` },
      { name: "POST /summarize with a JSON body", url: `${BASE}/summarize`, method: "POST", body: JSON.stringify({ text: "Beaver402 binds an agent payment to the exact request it pays for." }) },
    ]) {
      const result = await paidFetch({ url: call.url, method: call.method, body: call.body }, adapter, nodeFetch);
      const links = result.payment
        ? [`settlement ${explorerTx(result.payment.txHash)}`, result.payment.proofTxHash ? `proof of intent ${explorerTx(result.payment.proofTxHash)}` : "proof of intent not published"]
        : [];
      report(call.name, "paid", result.paid, result.error, links);
    }
  }

  // Refusals: the agent decides without settling, so none of these moves money.
  const forecast = `${BASE}/forecast?city=Ankara`;
  const changed = await adapter.preparePayment(await required(forecast), "GET", `${BASE}/forecast?city=Izmir`, null);
  report("the request changed after the merchant signed", "refused", changed.success, changed.error);

  const rerouted = await required(forecast);
  rerouted.accepts[0]!.payTo = Keypair.random().publicKey();
  const toOther = await adapter.preparePayment(rerouted, "GET", forecast, null);
  report("the requirements send the payment to another recipient", "refused", toOther.success, toOther.error);

  const original = challengeFrom(await required(forecast))!;
  const stranger = Keypair.random();
  const strangerChallenge = createSignedChallenge({
    merchantKeypair: stranger,
    httpMethod: "GET",
    endpoint: forecast,
    recipient: original.fields.recipient,
    asset: original.fields.asset,
    amount: original.fields.amount,
    network: original.fields.network,
  });
  const fromStranger = await adapter.preparePayment(
    { ...(await required(forecast)), extensions: { beaver402: { challenge: strangerChallenge } } },
    "GET",
    forecast,
    null
  );
  report("a merchant key the owner has not approved", "refused", fromStranger.success, fromStranger.error);

  console.log(`\n${surprises === 0 ? "everything as expected" : `${surprises} unexpected`}\n`);
  process.exit(surprises === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
