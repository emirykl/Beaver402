/**
 * `beaver402-merchant init`: turn an empty folder into a working testnet
 * merchant in one command. It makes the signing key, has friendbot fund it,
 * adds the USDC trustline, offers to fetch a free testnet facilitator key,
 * and writes .env and a server.ts with one paid GET and one paid POST.
 *
 * Nothing that already exists is overwritten: a second run fills in only
 * what is missing, so it is safe to run again after an interruption.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Keypair } from "@stellar/stellar-sdk";

import { NETWORKS, usdcContract } from "./config.js";

export const SERVER_TEMPLATE = `/**
 * A paid API behind Beaver402. Every value comes from .env.
 *
 *   GET  /forecast?city=...  0.1 USDC, the query is part of what is paid for
 *   POST /summarize          0.2 USDC, the JSON body is part of what is paid for
 *   GET  /merchant           what the account owner needs to approve you
 */
import express from "express";
import { captureRawBody, createMerchant, fileStore, optionsFromEnv, usdc, type PaymentContext } from "@beaver402/merchant";

const merchant = createMerchant(optionsFromEnv(process.env, fileStore(process.env.SETTLEMENT_STORE ?? "./data/payments.jsonl")));

const app = express();
// The challenge signs the exact request body, so its raw bytes are kept.
app.use(express.json({ verify: captureRawBody }));

app.get("/merchant", (_req, res) => {
  res.json(merchant.info());
});

app.get("/forecast", merchant.protect({ description: "One city forecast" }), (req, res) => {
  const { payment } = res.locals.beaver402 as PaymentContext;
  res.json({ city: req.query.city ?? "Istanbul", forecast: "sunny, 18°C", paidWith: payment.txHash, proofOfIntent: payment.proofTransaction ?? null });
});

app.post("/summarize", merchant.protect({ price: usdc("0.2"), description: "Summarise a text" }), (req, res) => {
  const text = String(req.body?.text ?? "");
  res.json({ summary: text.split(/\\s+/).slice(0, 12).join(" ") });
});

const port = Number(process.env.PORT ?? 4021);
for (const r of await merchant.check()) {
  console.log(\`\${r.ok ? "ok  " : r.severity === "warning" ? "warn" : "FAIL"}  \${r.name}: \${r.detail}\`);
}
app.listen(port, () => {
  const info = merchant.info();
  console.log(\`\\nBeaver402 merchant on \${info.network}, http://localhost:\${port}\`);
  console.log(\`Your merchant key, for the account owner to approve: \${info.merchantPubkey}\`);
});
`;

type Env = Map<string, string>;

function readEnv(path: string): Env {
  const env: Env = new Map();
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env.set(m[1]!, m[2]!);
  }
  return env;
}

function writeEnv(path: string, env: Env): void {
  const order = [
    ["BEAVER402_NETWORK", "testnet or mainnet"],
    ["USDC_CONTRACT", "Circle USDC on that network"],
    ["MERCHANT_SECRET", "your merchant signing key. Keep it private"],
    ["RECIPIENT_ADDRESS", "where USDC lands"],
    ["FACILITATOR_API_KEY", "OpenZeppelin Channels key, https://channels.openzeppelin.com/testnet/gen"],
    ["PUBLIC_URL", "the https address agents call, once you expose the server. Empty means localhost"],
    ["PRICE_USDC", "default price per request"],
    ["SETTLEMENT_STORE", "where completed payments are recorded"],
    ["PORT", ""],
  ] as const;
  const lines = ["# Written by beaver402-merchant init. Never commit this file."];
  for (const [key, note] of order) {
    if (note) lines.push(`# ${note}`);
    lines.push(`${key}=${env.get(key) ?? ""}`);
  }
  for (const [key, value] of env) {
    if (!order.some(([k]) => k === key)) lines.push(`${key}=${value}`);
  }
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function ask(question: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  rl.close();
  return answer === "" ? fallback : answer.startsWith("y");
}

export interface InitDeps {
  setupAccount: (key: Keypair) => Promise<string>;
  fetchFacilitatorKey: () => Promise<string>;
  confirm: (question: string, fallback: boolean) => Promise<boolean>;
  log: (line: string) => void;
}

/** Ask OpenZeppelin Channels for a free testnet key, as its /testnet/gen page does. */
export async function generateTestnetFacilitatorKey(): Promise<string> {
  const res = await fetch("https://channels.openzeppelin.com/testnet/gen");
  if (!res.ok) throw new Error(`the key generator answered ${res.status}`);
  const body = (await res.json()) as { apiKey?: string };
  if (!body.apiKey) throw new Error("the key generator returned no key");
  return body.apiKey;
}

export async function init(dir: string, deps: Partial<InitDeps> & Pick<InitDeps, "setupAccount">): Promise<void> {
  const log = deps.log ?? console.log;
  const confirm = deps.confirm ?? ask;
  const envPath = `${dir}/.env`;
  const env = readEnv(envPath);
  const done: string[] = [];

  if (!env.get("BEAVER402_NETWORK")) env.set("BEAVER402_NETWORK", "testnet");
  if (env.get("BEAVER402_NETWORK") !== "testnet") {
    throw new Error("init sets up testnet merchants. For mainnet, see 'Going to mainnet' in the guide");
  }
  env.set("USDC_CONTRACT", usdcContract("testnet"));

  let key: Keypair;
  const secret = env.get("MERCHANT_SECRET");
  if (secret) {
    key = Keypair.fromSecret(secret);
  } else {
    key = Keypair.random();
    env.set("MERCHANT_SECRET", key.secret());
    done.push("made a merchant key");
  }
  if (!env.get("RECIPIENT_ADDRESS")) env.set("RECIPIENT_ADDRESS", key.publicKey());
  if (!env.get("PRICE_USDC")) env.set("PRICE_USDC", "0.1");
  if (!env.get("SETTLEMENT_STORE")) env.set("SETTLEMENT_STORE", "./data/payments.jsonl");
  if (!env.get("PORT")) env.set("PORT", "4021");
  if (!env.has("PUBLIC_URL")) env.set("PUBLIC_URL", "");
  // Saved before anything goes to the network, so a failure later never
  // loses the key that was just made.
  writeEnv(envPath, env);

  log(`Merchant account ${key.publicKey()} on testnet`);
  for (const line of (await deps.setupAccount(key)).split("\n")) {
    if (line.trim() && !line.startsWith("Use it as")) log(`  ${line}`);
  }

  if (!env.get("FACILITATOR_API_KEY")) {
    const generate = await confirm(
      "The facilitator settles payments and pays their network fee. Get a free OpenZeppelin Channels testnet key now?",
      true
    );
    if (generate) {
      try {
        env.set("FACILITATOR_API_KEY", await (deps.fetchFacilitatorKey ?? generateTestnetFacilitatorKey)());
        done.push("got a testnet facilitator key");
      } catch (err) {
        log(`  could not get a key (${err instanceof Error ? err.message : String(err)}).`);
        log("  Open https://channels.openzeppelin.com/testnet/gen and put the key in .env as FACILITATOR_API_KEY");
      }
    } else {
      log("  Put a key from https://channels.openzeppelin.com/testnet/gen in .env as FACILITATOR_API_KEY");
    }
  }
  writeEnv(envPath, env);
  done.push("wrote .env");

  const serverPath = `${dir}/server.ts`;
  if (!existsSync(serverPath)) {
    writeFileSync(serverPath, SERVER_TEMPLATE);
    done.push("wrote server.ts");
  }

  const gitignore = `${dir}/.gitignore`;
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, "utf-8") : "";
  const missing = [".env", "data/", "node_modules/"].filter((line) => !ignored.split("\n").includes(line));
  if (missing.length) {
    writeFileSync(gitignore, `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  }

  const pkgPath = `${dir}/package.json`;
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { type?: string; scripts?: Record<string, string> };
    pkg.type = "module";
    pkg.scripts = { ...pkg.scripts, start: "tsx --env-file-if-exists=.env server.ts", check: "beaver402-merchant check" };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  log(`\nDone: ${done.join(", ")}.`);
  log(`\nNext:\n  npm start\n\nSend the account owner your merchant key so they can approve it:\n  ${key.publicKey()}`);
}
