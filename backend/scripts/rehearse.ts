/**
 * Rehearse the whole pilot on testnet, end to end, and write down what
 * happened.
 *
 * A fresh account is deployed with a software passkey as its owner, so every
 * owner action can be scripted. Payments go the full way: the merchant's 402,
 * the agent's authorization, x402 verification and settlement, the merchant's
 * own check on the ledger and the published proof of intent. The incident
 * drill and the migration to a second account follow.
 *
 * Settlement goes through the x402 reference facilitator run in this process,
 * a testnet only test tool, until the hosted facilitator's key is set up; set
 * FACILITATOR_MODE=hosted and FACILITATOR_API_KEY to use the hosted one.
 *
 * Nothing here touches a database: settlements are recorded in memory.
 *
 * Run with: npm run rehearse
 */
import { createHash, generateKeyPairSync, randomBytes, sign as ecdsaSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import * as StellarSdk from "@stellar/stellar-sdk";

// The rehearsal never writes to a database, and settles through the
// reference facilitator unless told otherwise. Both have to be decided
// before the backend modules read the environment.
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_KEY = "";
process.env.FACILITATOR_MODE ??= "reference";
process.env.FACILITATOR_SIGNER_SECRET ??= process.env.FEE_SOURCE_SECRET;
process.env.BEAVER402_ROLE = "all";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const WASM = resolve(ROOT, "target/wasm32v1-none/release/payment_policy.wasm");
const RP_ID = "rehearsal.beaver402.test";
const USDC = 10_000_000n;
const PRICE = 1_000_000n;

const { network, rpcServer } = await import("../src/config/network.js");
const { prepareOwnerAction, submitOwnerAction } = await import("../src/policy/owner-actions.js");
const { createAdapter } = await import("../src/adapter/x402-client.js");
const { createApp } = await import("../src/app.js");
const { paidFetch } = await import("../src/agent/paid-fetch.js");
const { readPaymentRequired } = await import("../src/agent/paid-fetch.js");
const { createSignedChallenge } = await import("../src/merchant/challenge-signer.js");
const { policyErrorName, describeOwnerActionError } = await import("../src/shared/policy-errors.js");
const { HEADERS, challengeFrom } = await import("../src/x402/protocol.js");

if (network().name !== "testnet") {
  throw new Error("the rehearsal only runs on testnet");
}

const server = rpcServer();
const passphrase = network().passphrase;
const fee = StellarSdk.Keypair.fromSecret(process.env.FEE_SOURCE_SECRET!);
const agent = StellarSdk.Keypair.fromSecret(process.env.AGENT_SECRET!);
const merchant = StellarSdk.Keypair.fromSecret(process.env.MERCHANT_SECRET!);
const funder = StellarSdk.Keypair.fromSecret(process.env.REHEARSAL_FUNDER_SECRET || process.env.MERCHANT_SECRET!);
const recovery = fee.publicKey();
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest();
const rawKey = (k: StellarSdk.Keypair) => Buffer.from(StellarSdk.StrKey.decodeEd25519PublicKey(k.publicKey()));

// ── The record ────────────────────────────────────────────────────

interface Step {
  phase: string;
  what: string;
  expected: "done" | "refused";
  actual: "done" | "refused";
  detail?: string;
  tx?: string;
}
const steps: Step[] = [];

function note(phase: string, what: string, expected: Step["expected"], ok: boolean, detail?: string, tx?: string) {
  const actual = ok ? "done" : "refused";
  const named = policyErrorName(detail) ?? detail;
  steps.push({ phase, what, expected, actual, detail: named?.split("\n")[0]?.slice(0, 200), tx });
  const mark = actual === expected ? "ok" : "UNEXPECTED";
  console.log(`  ${mark.padEnd(10)} ${what}${tx ? `  ${tx.slice(0, 12)}` : ""}${named ? `  (${named.split("\n")[0]!.slice(0, 120)})` : ""}`);
}

// ── Chain helpers ─────────────────────────────────────────────────

async function send(tx: StellarSdk.Transaction, signer: StellarSdk.Keypair): Promise<StellarSdk.rpc.Api.GetSuccessfulTransactionResponse & { hash: string }> {
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent.errorResult));
  for (let i = 0; i < 60; i++) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return { ...result, hash: sent.hash };
    if (result.status === "FAILED") throw new Error(`${sent.hash} failed`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${sent.hash} not confirmed`);
}

async function builder(source: StellarSdk.Keypair) {
  return new StellarSdk.TransactionBuilder(await server.getAccount(source.publicKey()), {
    fee: "1000000",
    networkPassphrase: passphrase,
  }).setTimeout(120);
}

// ── A passkey in software ─────────────────────────────────────────

const owner = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
const ownerPublicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(owner.x!, "base64url"),
  Buffer.from(owner.y!, "base64url"),
]);

/** What an authenticator on RP_ID returns for a challenge. */
function assertion(challenge: string) {
  const clientData = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge, origin: `https://${RP_ID}`, crossOrigin: false })
  );
  const authData = Buffer.concat([sha256(Buffer.from(RP_ID)), Buffer.from([0x05, 0, 0, 0, 1])]);
  const signature = ecdsaSign("sha256", Buffer.concat([authData, sha256(clientData)]), { key: owner, format: "jwk" });
  return {
    authenticatorData: authData.toString("base64url"),
    clientDataJSON: clientData.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

type OwnerAction = Parameters<typeof prepareOwnerAction>[0];

async function ownerAction(contract: string, action: OwnerAction, input: Parameters<typeof prepareOwnerAction>[3] = {}) {
  const prepared = await prepareOwnerAction(action, contract, fee.publicKey(), input);
  return submitOwnerAction(prepared, assertion(prepared.challenge), contract, fee);
}

async function tryOwner(phase: string, what: string, expected: Step["expected"], contract: string, action: OwnerAction, input = {}) {
  try {
    const { txHash } = await ownerAction(contract, action, input);
    note(phase, what, expected, true, undefined, txHash);
  } catch (err) {
    note(phase, what, expected, false, describeOwnerActionError(String(err)).split(",")[0]);
  }
}

// ── Deploying and funding ─────────────────────────────────────────

async function deploy(phase: string): Promise<string> {
  const wasm = readFileSync(WASM);
  const wasmHash = sha256(wasm);
  try {
    await send((await builder(fee)).addOperation(StellarSdk.Operation.uploadContractWasm({ wasm })).build(), fee);
  } catch {
    // Already uploaded.
  }

  const limits = StellarSdk.xdr.ScVal.scvMap(
    (
      [
        ["max_payment_amount", StellarSdk.nativeToScVal(USDC, { type: "i128" })],
        ["max_total_amount", StellarSdk.nativeToScVal(5n * USDC, { type: "i128" })],
        ["max_tx_count", StellarSdk.nativeToScVal(5, { type: "u32" })],
        ["window_size", StellarSdk.nativeToScVal(86_400, { type: "u64" })],
      ] as const
    ).map(([key, val]) => new StellarSdk.xdr.ScMapEntry({ key: StellarSdk.xdr.ScVal.scvSymbol(key), val }))
  );

  const deployed = await send(
    (await builder(fee))
      .addOperation(
        StellarSdk.Operation.createCustomContract({
          address: new StellarSdk.Address(fee.publicKey()),
          wasmHash,
          salt: randomBytes(32),
          constructorArgs: [
            StellarSdk.xdr.ScVal.scvBytes(ownerPublicKey),
            StellarSdk.xdr.ScVal.scvBytes(sha256(Buffer.from(RP_ID))),
            StellarSdk.xdr.ScVal.scvBytes(rawKey(agent)),
            new StellarSdk.Address(network().usdcContract).toScVal(),
            new StellarSdk.Address(recovery).toScVal(),
            limits,
          ],
        })
      )
      .build(),
    fee
  );
  const contract = StellarSdk.Address.fromScVal(deployed.returnValue!).toString();
  note(phase, `deploy ${contract}, artifact ${wasmHash.toString("hex").slice(0, 16)}`, "done", true, undefined, deployed.hash);
  return contract;
}

async function fund(phase: string, from: StellarSdk.Keypair, contract: string, amount: bigint) {
  const result = await send(
    (await builder(from))
      .addOperation(
        StellarSdk.Operation.invokeContractFunction({
          contract: network().usdcContract,
          function: "transfer",
          args: [
            new StellarSdk.Address(from.publicKey()).toScVal(),
            new StellarSdk.Address(contract).toScVal(),
            StellarSdk.nativeToScVal(amount, { type: "i128" }),
          ],
        })
      )
      .build(),
    from
  );
  note(phase, `fund with ${Number(amount) / 1e7} USDC`, "done", true, undefined, result.hash);
}

async function balance(address: string): Promise<bigint> {
  const tx = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: passphrase }
  )
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: network().usdcContract,
        function: "balance",
        args: [new StellarSdk.Address(address).toScVal()],
      })
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) throw new Error(String((sim as { error?: string }).error));
  return BigInt(StellarSdk.scValToNative(sim.result!.retval));
}

// ── The merchant and the agent ────────────────────────────────────

/** The backend in this process, pointed at one account. */
async function serve(contract: string) {
  process.env.POLICY_CONTRACT_ID = contract;
  const app = createApp("all");
  const listener = app.listen(0);
  const { port } = listener.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return { base, close: () => listener.close() };
}

const nodeFetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
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

async function requiredFor(url: string) {
  const response = await fetch(url);
  const required = readPaymentRequired(response.headers.get(HEADERS.required), await response.json());
  if (!required) throw new Error(`${url} did not answer with an x402 payment request`);
  return required;
}

async function rehearseAccount(phase: string, contract: string, adapter: ReturnType<typeof createAdapter>, base: string) {
  const endpoint = `${base}/api/data`;

  const pay = async (what: string) => {
    const result = await paidFetch({ url: endpoint }, adapter, nodeFetch);
    note(phase, what, "done", result.paid, result.error, result.payment?.txHash);
    if (result.payment?.proofTxHash) {
      note(phase, "  its proof of intent, published by the merchant", "done", true, undefined, result.payment.proofTxHash);
    }
    return result;
  };

  const refused = async (what: string, required: Awaited<ReturnType<typeof requiredFor>>, url = endpoint) => {
    const prepared = await adapter.preparePayment(required, "GET", url, null);
    note(phase, what, "refused", prepared.success, prepared.error);
  };

  return { endpoint, pay, refused };
}

/**
 * Pay the way an AI agent does: an MCP client starts the Beaver402 MCP
 * server, which holds no key, and calls its fetch_paid_resource tool. The
 * tool asks the agent backend, which authorizes the payment, and the
 * merchant has it settled.
 */
async function payThroughMcp(phase: string, base: string) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", resolve(here, "../src/mcp/server.ts")],
    env: { ...(process.env as Record<string, string>), BEAVER402_BACKEND_URL: base },
  });
  const client = new Client({ name: "beaver402-rehearsal", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    note(phase, `the MCP server offers ${tools.tools.map((t) => t.name).join(" and ")}`, "done", tools.tools.some((t) => t.name === "fetch_paid_resource"));

    const result = await client.callTool({ name: "fetch_paid_resource", arguments: { url: `${base}/api/data` } });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    const settlement = text.match(/Settlement: ([0-9a-f]{64})/)?.[1];
    const proof = text.match(/Proof of intent: ([0-9a-f]{64})/)?.[1];
    note(phase, "a payment started from the MCP tool", "done", Boolean(settlement) && !result.isError, settlement ? undefined : text.slice(0, 200), settlement);
    if (proof) note(phase, "  its proof of intent, published by the merchant", "done", true, undefined, proof);
    // What the model sees: the price, the transaction and the content, and
    // nothing it could spend.
    const leaks = [process.env.AGENT_SECRET, process.env.MERCHANT_SECRET, process.env.FEE_SOURCE_SECRET].filter(
      (secret) => secret && text.includes(secret)
    );
    note(phase, "no secret appears in what the tool returns", "done", leaks.length === 0);
  } finally {
    await client.close();
  }
}

// ── The rehearsal ─────────────────────────────────────────────────

async function main() {
  console.log(`\nRehearsing on ${network().name}, facilitator: ${process.env.FACILITATOR_MODE}\n`);

  console.log("Account A");
  const a = await deploy("account A");
  await tryOwner("account A", "approve the merchant with the passkey", "done", a, "add_merchant", { pubkey: merchant.publicKey() });
  await fund("account A", funder, a, USDC);

  const backendA = await serve(a);
  const adapterA = createAdapter(agent.secret(), a);
  const A = await rehearseAccount("account A", a, adapterA, backendA.base);

  console.log("\nPayments and refusals");
  await A.pay("payment 1, settled through x402, confirmed by the merchant");

  await A.refused("the endpoint changed after the merchant signed", await requiredFor(A.endpoint), `${backendA.base}/api/other`);
  await A.refused("a query parameter added after the merchant signed", await requiredFor(A.endpoint), `${A.endpoint}?item=2`);

  const original = await requiredFor(A.endpoint);
  const fields = challengeFrom(original)!.fields;
  const resign = (changes: { amount?: string; signer?: StellarSdk.Keypair; expirySeconds?: number }) => {
    const challenge = createSignedChallenge({
      merchantKeypair: changes.signer ?? merchant,
      httpMethod: "GET",
      endpoint: fields.normalizedEndpoint,
      recipient: fields.recipient,
      asset: fields.asset,
      amount: changes.amount ?? fields.amount,
      network: fields.network,
      expirySeconds: changes.expirySeconds,
    });
    return {
      ...original,
      accepts: original.accepts.map((r) => ({ ...r, amount: changes.amount ?? r.amount })),
      extensions: { beaver402: { challenge } },
    };
  };
  await A.refused("a merchant nobody approved", resign({ signer: StellarSdk.Keypair.random() }));
  await A.refused("a single payment over the per payment limit", resign({ amount: (15n * USDC / 10n).toString() }));

  const once = await requiredFor(A.endpoint);
  const first = await paidFetch({ url: A.endpoint }, adapterA, async (url, init) =>
    init.headers[HEADERS.signature] ? nodeFetch(url, init) : { status: 402, headers: { get: () => null }, json: async () => once }
  );
  note("account A", "payment 2, a challenge used once", "done", first.paid, first.error, first.payment?.txHash);
  await A.refused("the same challenge used twice", once);

  console.log("\nIncident drill");
  await tryOwner("incident", "halt all payments", "done", a, "freeze_payments");
  await A.refused("a payment while halted", await requiredFor(A.endpoint));
  await tryOwner("incident", "resume", "done", a, "restore_payments");
  await A.pay("payment 3, after resuming");
  await tryOwner("incident", "revoke the agent key", "done", a, "revoke_agent_signer");
  await A.refused("a payment after revocation", await requiredFor(A.endpoint));
  await tryOwner("incident", "reinstate the agent key", "done", a, "set_agent_signer", { pubkey: agent.publicKey() });
  await A.pay("payment 4, after reinstating");
  await tryOwner("incident", "remove the merchant", "done", a, "remove_merchant", { pubkey: merchant.publicKey() });
  await A.refused("a payment to the removed merchant", await requiredFor(A.endpoint));
  await tryOwner("incident", "approve the merchant again", "done", a, "add_merchant", { pubkey: merchant.publicKey() });
  await tryOwner("incident", "lower the per payment limit to 0.5 USDC", "done", a, "reduce_limits", {
    limits: { maxPaymentAmount: (USDC / 2n).toString(), maxTxCount: 5, maxTotalAmount: (5n * USDC).toString(), windowSize: 86_400 },
  });
  await tryOwner("incident", "try to raise it back to 1 USDC", "refused", a, "reduce_limits", {
    limits: { maxPaymentAmount: USDC.toString(), maxTxCount: 5, maxTotalAmount: (5n * USDC).toString(), windowSize: 86_400 },
  });
  await A.pay("payment 5, fills the window and freezes the account");
  await A.refused("a payment after the window filled", await requiredFor(A.endpoint));
  await tryOwner("incident", "recover the funds while frozen", "done", a, "recover_funds");
  const leftInA = await balance(a);
  note("incident", `account A holds ${Number(leftInA) / 1e7} USDC after recovery`, "done", leftInA === 0n);
  backendA.close();

  console.log("\nMigration to account B");
  const b = await deploy("migration");
  await tryOwner("migration", "approve the merchant on the new account", "done", b, "add_merchant", { pubkey: merchant.publicKey() });
  const recovered = await balance(recovery);
  await fund("migration", fee, b, recovered < USDC / 2n ? recovered : USDC / 2n);
  const backendB = await serve(b);
  const B = await rehearseAccount("migration", b, createAdapter(agent.secret(), b), backendB.base);
  await B.pay("first payment from the new account");

  console.log("\nThrough the MCP tool");
  await payThroughMcp("migration", backendB.base);
  await tryOwner("migration", "halt the new account", "done", b, "freeze_payments");
  await tryOwner("migration", "recover its funds", "done", b, "recover_funds");
  backendB.close();

  writeRecord(a, b);

  const surprises = steps.filter((s) => s.actual !== s.expected);
  console.log(`\n${steps.length} steps, ${surprises.length} unexpected\n`);
  if (surprises.length > 0) process.exit(1);
}

function writeRecord(a: string, b: string) {
  const explorer = network().explorer;
  const day = new Date().toISOString().slice(0, 10);
  const rows = steps
    .map((s) => {
      const tx = s.tx ? `[\`${s.tx.slice(0, 8)}\`](${explorer}/tx/${s.tx})` : "";
      const outcome = s.actual === s.expected ? s.actual : `**${s.actual}, expected ${s.expected}**`;
      return `| ${s.phase} | ${s.what.trim()} | ${outcome} | ${s.detail ? `\`${s.detail.replace(/\|/g, "/")}\`` : ""} | ${tx} |`;
    })
    .join("\n");

  const record = `# Testnet rehearsal, ${day}

Generated by \`npm run rehearse\`. Every transaction below is on Stellar
testnet and can be opened on the explorer.

| | |
|---|---|
| Account A | [\`${a}\`](${explorer}/contract/${a}) |
| Account B | [\`${b}\`](${explorer}/contract/${b}) |
| Facilitator | ${process.env.FACILITATOR_MODE === "reference" ? "x402 reference implementation of the exact scheme, run as a testnet test tool" : network().facilitatorUrl} |
| Owner | a software passkey on \`${RP_ID}\`, so owner actions could be scripted |
| Recovery address | \`${recovery}\` |
| Limits | 1 USDC per payment, 5 payments and 5 USDC in 24 hours |

| Phase | Step | Outcome | Reason | Transaction |
|---|---|---|---|---|
${rows}

${steps.filter((s) => s.actual !== s.expected).length === 0 ? "Every step went as expected." : "Some steps did not go as expected; see the bold rows."}
`;
  const target = resolve(ROOT, "docs/operations/rehearsals", `${day}-testnet.md`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, record);
  console.log(`\nRecord written to ${target}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
