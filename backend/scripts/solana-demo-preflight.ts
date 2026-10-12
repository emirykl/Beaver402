/** Read-only checks before recording a Solana devnet payment demo. */
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

import { enabledChains } from "../src/chains/registry.js";
import { solana, solanaRpc, verifySolanaNetwork } from "../src/chains/solana/config.js";
import { readPolicyAccount } from "../src/chains/solana/owner-actions.js";
import { velocityState } from "../src/chains/solana/policy-account.js";
import { associatedToken, solanaAddressOf } from "../src/chains/solana/program.js";
import { SOLANA_PRICE } from "../src/chains/solana/merchant.js";

async function main() {
  const config = solana();
  const rpc = solanaRpc(config);
  const problems: string[] = [];
  const requireSecret = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for the demo preflight`);
    return value;
  };

  if (!enabledChains().includes("solana")) problems.push("BEAVER_CHAINS does not enable solana");
  await verifySolanaNetwork(config, rpc);

  const agent = solanaAddressOf(Keypair.fromSecret(requireSecret("AGENT_SECRET")).publicKey());
  const merchant = solanaAddressOf(Keypair.fromSecret(requireSecret("MERCHANT_SECRET")).publicKey());
  const { value: program } = await rpc.getAccountInfo(config.programId, { encoding: "base64" }).send();
  if (!program?.executable) problems.push("the Beaver402 program is not deployed on devnet");

  const policy = await readPolicyAccount(config, rpc);
  if (!policy.networkId.equals(createHash("sha256").update(config.caip2).digest())) {
    problems.push("the policy is for a different Solana network");
  }
  if (policy.asset !== config.usdcMint) problems.push("the policy does not use devnet USDC");
  if (policy.agentSigner !== agent) problems.push("AGENT_SECRET is not the policy's active agent");
  if (!policy.merchants.includes(merchant)) problems.push("the merchant is not approved in the policy");
  if (policy.frozen) problems.push("the policy is halted; resume it before the first payment");

  const spent = velocityState(policy, Math.floor(Date.now() / 1000));
  const price = BigInt(SOLANA_PRICE);
  if (price > BigInt(policy.limits.maxPaymentAmount)) problems.push("the demo price exceeds the per-payment limit");
  if (spent.txCount >= policy.limits.maxTxCount) problems.push("the payment count limit is exhausted");
  if (BigInt(spent.totalAmount) + price > BigInt(policy.limits.maxTotalAmount)) {
    problems.push("the spending window has less than one demo payment left");
  }

  const vault = await associatedToken(config.policy!, config.usdcMint);
  const recipientToken = await associatedToken(merchant, config.usdcMint);
  const { value: vaultAccount } = await rpc.getAccountInfo(vault, { encoding: "base64" }).send();
  const { value: recipientAccount } = await rpc.getAccountInfo(recipientToken, { encoding: "base64" }).send();
  if (!vaultAccount) problems.push("the policy's USDC vault is missing");
  if (!recipientAccount) problems.push("the merchant's USDC token account is missing");
  const vaultBalance = vaultAccount
    ? BigInt((await rpc.getTokenAccountBalance(vault).send()).value.amount)
    : 0n;
  if (vaultBalance < price) problems.push("the vault holds less than one demo payment");

  const merchantSol = (await rpc.getBalance(merchant).send()).value;
  if (merchantSol < 10_000_000n) problems.push("the merchant fee payer has less than 0.01 devnet SOL");

  console.log(JSON.stringify({
    network: config.caip2,
    program: config.programId,
    policy: config.policy,
    agent,
    merchant,
    frozen: policy.frozen,
    merchantApproved: policy.merchants.includes(merchant),
    vaultUsdcBaseUnits: vaultBalance.toString(),
    priceUsdcBaseUnits: SOLANA_PRICE,
    paymentsInWindow: spent.txCount,
    merchantFeeLamports: merchantSol.toString(),
    ready: problems.length === 0,
    problems,
  }, null, 2));
  if (problems.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
