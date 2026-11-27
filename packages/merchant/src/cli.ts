#!/usr/bin/env node
/**
 * beaver402-merchant: check a merchant's setup, make a signing key, and
 * publish proofs of intent whose first attempt failed. Configuration comes
 * from the same environment variables as the example server.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { Keypair } from "@stellar/stellar-sdk";

import { NETWORKS } from "./config.js";

import { optionsFromEnv, usdcContract, type NetworkName } from "./config.js";
import { createMerchant } from "./merchant.js";
import { init } from "./init.js";
import { fileStore, memoryStore } from "./store.js";

const USAGE = `beaver402-merchant <command>

  init                           set up a testnet merchant in this folder: key, funding,
                                 USDC trustline, facilitator key, .env and server.ts
  keygen                         make a new merchant signing key
  setup-testnet                  fund MERCHANT_SECRET's account from friendbot and add the USDC trustline
  usdc <testnet|mainnet>         print the USDC contract for a network
  check                          check the configuration against the network
  info                           print what the account owner needs to approve this merchant
  publish-proof --account C... --nonce <hex>
                                 publish one payment's proof of intent
  pending-proofs [--publish]     list (or publish) recorded payments without a proof

Configuration is read from the environment: BEAVER402_NETWORK, SOROBAN_RPC_URL,
USDC_CONTRACT, FACILITATOR_URL, FACILITATOR_API_KEY, MERCHANT_SECRET,
RECIPIENT_ADDRESS, PUBLIC_URL, PRICE_USDC and SETTLEMENT_STORE (a file path).
A .env file in the current folder is read first.`;

/**
 * Make a testnet account ready to be a merchant: funded with test XLM by
 * friendbot, and holding a USDC trustline so it can receive payments. The
 * same account then serves as signer and recipient.
 */
async function setupTestnetAccount(key: Keypair): Promise<string> {
  const testnet = NETWORKS.testnet;
  const rpc = new StellarSdk.rpc.Server(process.env.SOROBAN_RPC_URL || testnet.defaultRpcUrl!);
  const usdc = new StellarSdk.Asset("USDC", testnet.usdcIssuer);
  const lines: string[] = [];

  let account: StellarSdk.Account;
  try {
    account = await rpc.getAccount(key.publicKey());
    lines.push(`${key.publicKey()} already exists`);
  } catch {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${key.publicKey()}`);
    if (!res.ok) throw new Error(`friendbot refused: ${res.status}`);
    lines.push(`funded ${key.publicKey()} with test XLM`);
    account = await rpc.getAccount(key.publicKey());
  }

  try {
    await rpc.getTrustline(key.publicKey(), usdc);
    lines.push("USDC trustline already there");
  } catch {
    const tx = new StellarSdk.TransactionBuilder(account, { fee: "1000", networkPassphrase: testnet.passphrase })
      .addOperation(StellarSdk.Operation.changeTrust({ asset: usdc }))
      .setTimeout(60)
      .build();
    tx.sign(key);
    const sent = await rpc.sendTransaction(tx);
    if (sent.status === "ERROR") throw new Error("the trustline transaction was rejected");
    for (let i = 0; i < 30; i++) {
      const r = await rpc.getTransaction(sent.hash);
      if (r.status === "SUCCESS") break;
      if (r.status === "FAILED") throw new Error(`trustline transaction ${sent.hash} failed`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    lines.push(`added the USDC trustline: ${testnet.explorer}/tx/${sent.hash}`);
  }
  lines.push(`\nUse it as both MERCHANT_SECRET and RECIPIENT_ADDRESS=${key.publicKey()}`);
  return lines.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function merchantFromEnv() {
  const path = process.env.SETTLEMENT_STORE;
  return createMerchant(optionsFromEnv(process.env, path ? fileStore(path) : memoryStore()));
}

async function main(): Promise<number> {
  // Read .env from the current folder, as the example server does.
  try {
    process.loadEnvFile(".env");
  } catch {
    // none there; the environment is used as it is
  }
  const command = process.argv[2];
  switch (command) {
    case "keygen": {
      const key = Keypair.random();
      console.log(`public key: ${key.publicKey()}`);
      console.log(`secret:     ${key.secret()}`);
      console.log("\nKeep the secret private. On testnet, `beaver402-merchant init` does this and the rest for you.");
      return 0;
    }
    case "init": {
      await init(process.cwd(), { setupAccount: setupTestnetAccount });
      return 0;
    }
    case "setup-testnet": {
      const secret = process.env.MERCHANT_SECRET;
      if (!secret) {
        console.error("set MERCHANT_SECRET first (beaver402-merchant keygen makes one)");
        return 2;
      }
      const key = Keypair.fromSecret(secret);
      console.log(await setupTestnetAccount(key));
      return 0;
    }
    case "usdc": {
      const network = process.argv[3] as NetworkName;
      if (network !== "testnet" && network !== "mainnet") {
        console.error("usage: beaver402-merchant usdc <testnet|mainnet>");
        return 2;
      }
      console.log(usdcContract(network));
      return 0;
    }
    case "check": {
      const results = await merchantFromEnv().check();
      for (const r of results) {
        const mark = r.ok ? "ok  " : r.severity === "warning" ? "warn" : "FAIL";
        console.log(`${mark}  ${r.name.padEnd(20)} ${r.detail}`);
      }
      return results.some((r) => !r.ok && r.severity === "error") ? 1 : 0;
    }
    case "info": {
      console.log(JSON.stringify(merchantFromEnv().info(), null, 2));
      return 0;
    }
    case "publish-proof": {
      const account = arg("account");
      const nonce = arg("nonce");
      if (!account || !nonce) {
        console.error("usage: beaver402-merchant publish-proof --account C... --nonce <hex>");
        return 2;
      }
      console.log(await merchantFromEnv().publishProof(account, nonce));
      return 0;
    }
    case "pending-proofs": {
      if (!process.env.SETTLEMENT_STORE) {
        console.error("SETTLEMENT_STORE has to name the store file to read pending proofs from");
        return 2;
      }
      const merchant = merchantFromEnv();
      if (process.argv.includes("--publish")) {
        const results = await merchant.publishPendingProofs();
        for (const r of results) console.log(`${r.nonce}  ${r.proofTransaction ?? `failed: ${r.error}`}`);
        if (results.length === 0) console.log("no pending proofs");
        return results.some((r) => r.error) ? 1 : 0;
      }
      const pending = await merchant.pendingProofs();
      for (const p of pending) console.log(`${p.settledAt}  account ${p.payer}  nonce ${p.nonce}  settlement ${p.txHash}`);
      if (pending.length === 0) console.log("no pending proofs");
      return 0;
    }
    default:
      console.log(USAGE);
      return command ? 2 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
