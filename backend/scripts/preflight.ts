/**
 * Check everything the deployment depends on, before deploying.
 *
 * Run against the env file for the network:
 *
 *   npx tsx --env-file=.env scripts/preflight.ts
 *   npx tsx --env-file=.env.mainnet scripts/preflight.ts
 *
 * Every line is printed with ok or FAIL, and the run fails if any line
 * failed. Nothing is changed and nothing is signed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as StellarSdk from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { loadNetworkConfig, verifyNetwork, usdcContractFor } from "../src/config/network.js";
import { loadPasskeyConfig } from "../src/config/passkey.js";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, "../../target/wasm32v1-none/release/payment_policy.wasm");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

async function attempt(label: string, run: () => Promise<string | void>) {
  try {
    const detail = await run();
    check(label, true, detail ?? "");
  } catch (err) {
    check(label, false, err instanceof Error ? err.message : String(err));
  }
}

const config = loadNetworkConfig();
const horizon = new StellarSdk.Horizon.Server(
  config.name === "mainnet" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org"
);

/** The account's XLM, and whether it can hold USDC. */
async function account(address: string) {
  const loaded = await horizon.loadAccount(address);
  const xlm = Number(loaded.balances.find((b) => b.asset_type === "native")?.balance ?? 0);
  const usdc = loaded.balances.find(
    (b) => "asset_code" in b && b.asset_code === "USDC" && "asset_issuer" in b && b.asset_issuer === config.usdcIssuer
  ) as { balance: string; is_authorized?: boolean } | undefined;
  return { xlm, usdc };
}

function publicKeyOf(secretVar: string): string | null {
  const secret = process.env[secretVar];
  return secret ? StellarSdk.Keypair.fromSecret(secret).publicKey() : null;
}

async function main() {
  console.log(`\nPreflight for ${config.name}\n`);

  console.log("Network");
  await attempt(`the RPC serves ${config.name}`, async () => {
    await verifyNetwork(config);
    return config.rpcUrl;
  });
  check(
    "USDC is Circle's, derived from the issuer",
    usdcContractFor(config.usdcIssuer, config.passphrase) === config.usdcContract,
    config.usdcContract
  );

  console.log("\nPasskey");
  await attempt("the panel's domain is set", async () => {
    const { rpId, origin } = loadPasskeyConfig(config);
    return `${rpId}, ${origin}`;
  });

  console.log("\nAccounts");
  const fee = publicKeyOf("FEE_SOURCE_SECRET");
  const merchant = process.env.MERCHANT_PUBKEY || publicKeyOf("MERCHANT_SECRET");
  const recipient = process.env.RECIPIENT_ADDRESS || (config.name === "testnet" ? merchant : null);
  const recovery = process.env.RECOVERY_ADDRESS || null;
  const agent = publicKeyOf("AGENT_SECRET");

  check("the agent key is set", Boolean(agent), agent ?? "AGENT_SECRET");
  check("the agent and the merchant are different keys", agent !== merchant);

  if (fee) {
    await attempt("the fee account exists and has XLM for deployment and owner actions", async () => {
      const { xlm } = await account(fee);
      if (xlm < 20) throw new Error(`${xlm} XLM, at least 20 needed`);
      return `${xlm} XLM`;
    });
  } else {
    check("the fee account is set", false, "FEE_SOURCE_SECRET");
  }

  if (merchant) {
    await attempt("the merchant account exists and can pay for publishing proofs", async () => {
      const { xlm } = await account(merchant);
      if (xlm < 5) throw new Error(`${xlm} XLM, at least 5 needed`);
      return `${xlm} XLM`;
    });
  } else {
    check("the merchant key is set", false, "MERCHANT_PUBKEY or MERCHANT_SECRET");
  }

  for (const [label, address] of [
    ["recipient", recipient],
    ["recovery address", recovery],
  ] as const) {
    if (!address) {
      if (config.name === "testnet" && label === "recovery address") {
        check("no recovery address set, the deploy script uses the deployer on testnet", true);
      } else {
        check(`the ${label} is set`, false, label === "recipient" ? "RECIPIENT_ADDRESS" : "RECOVERY_ADDRESS");
      }
      continue;
    }
    if (address.startsWith("C")) {
      check(`the ${label} is a contract, which holds USDC without a trustline`, true, address);
      continue;
    }
    await attempt(`the ${label} can receive USDC`, async () => {
      const { usdc } = await account(address);
      if (!usdc) throw new Error(`${address} has no USDC trustline`);
      if (usdc.is_authorized === false) throw new Error(`${address} is not authorized to hold USDC`);
      return `${address}, holds ${usdc.balance} USDC`;
    });
  }
  check("the recovery address is not a key the services hold", recovery !== fee && recovery !== agent && recovery !== merchant || config.name === "testnet");

  console.log("\nFacilitator");
  await attempt(`${config.facilitatorUrl} settles exact payments on ${config.caip2}`, async () => {
    const key = process.env.FACILITATOR_API_KEY;
    if (!key) throw new Error("FACILITATOR_API_KEY is not set");
    const headers = { Authorization: `Bearer ${key}` };
    const client = new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
      createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
    });
    const supported = await client.getSupported();
    const kind = supported.kinds.find((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === config.caip2);
    if (!kind) throw new Error(`not listed, it supports ${supported.kinds.map((k) => `${k.scheme}@${k.network}`).join(", ")}`);
    return `fees sponsored: ${String(kind.extra?.areFeesSponsored ?? "unknown")}`;
  });

  console.log("\nArtifact");
  if (!existsSync(WASM)) {
    check("the release WASM is built", false, "run stellar contract build");
  } else {
    const hash = createHash("sha256").update(readFileSync(WASM)).digest("hex");
    const expected = process.env.EXPECTED_WASM_HASH;
    if (config.name === "mainnet" || expected) {
      check("the WASM is the reviewed one", hash === expected, expected ? `${hash} vs ${expected}` : "EXPECTED_WASM_HASH is not set");
    } else {
      check("the release WASM is built", true, hash);
    }
  }

  console.log(`\n${failures === 0 ? "Ready." : `${failures} check${failures === 1 ? "" : "s"} failed.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
