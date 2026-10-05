/**
 * Create the Solana policy account on devnet and get it ready to pay.
 *
 *   npm run solana:init
 *
 * The account owner is the same passkey that owns the Stellar account, read
 * from Supabase, so a passkey has to be registered first. The deployer key
 * pays for everything here and holds the devnet USDC from Circle's faucet.
 *
 * What it does, each step only if still needed:
 * 1. initialize the account with the pilot limits
 * 2. move USDC from the deployer into the account's vault
 * 3. give the merchant and the fee account some SOL for fees
 * 4. create the merchant's USDC account, where payments land
 * 5. write SOLANA_POLICY_ADDRESS and BEAVER_CHAINS into backend/.env
 *
 * The merchant still has to be approved by the owner, with the passkey, in
 * the panel. Like on Stellar, the deploy never approves anyone on its own.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
} from "@solana/kit";
import { Keypair } from "@stellar/stellar-sdk";

import { loadSolanaConfig, solanaErrorText, solanaExplorerTx, solanaRpc, verifySolanaNetwork } from "../src/chains/solana/config.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedToken,
  compressP256,
  initializeInstruction,
  policyAddress,
  solanaAddressOf,
  SYSTEM_PROGRAM,
} from "../src/chains/solana/program.js";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodeStoredBytes, getSupabase } from "../src/lib/supabase.js";
import { coseToOwnerKey } from "../src/passkey/owner-key.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = resolve(here, "../.env");

/** The pilot limits with six decimals: 1 USDC, 5 payments, 5 USDC, 24 hours. */
const LIMITS = { maxPaymentAmount: "1000000", maxTxCount: 5, maxTotalAmount: "5000000", windowSize: 86400 };
const VAULT_FUNDING = 10_000_000n;
const FEE_LAMPORTS = 200_000_000n;

const config = loadSolanaConfig();
const rpc = solanaRpc(config);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in backend/.env`);
  return value;
}

async function deployer() {
  const path = process.env.SOLANA_DEPLOYER_KEYPAIR || resolve(homedir(), ".config/solana/beaver402-deployer.json");
  const bytes = new Uint8Array(JSON.parse(readFileSync(path, "utf-8")));
  const keyPair = await createKeyPairFromBytes(bytes);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

async function send(payer: { keyPair: CryptoKeyPair; address: Address }, instructions: Instruction[], label: string) {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await signTransaction([payer.keyPair], compileTransaction(message));
  const signature = getSignatureFromTransaction(signed);
  try {
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  } catch (err) {
    throw new Error(`${label} failed: ${solanaErrorText(err)}`);
  }
  for (let i = 0; i < 40; i++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${label} failed on chain`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") {
      console.log(`${label}: ${solanaExplorerTx(signature, config)}`);
      return signature;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} was not confirmed`);
}

async function exists(account: Address): Promise<boolean> {
  const { value } = await rpc.getAccountInfo(account, { encoding: "base64" }).send();
  return value !== null;
}

async function tokenBalance(account: Address): Promise<bigint> {
  if (!(await exists(account))) return 0n;
  const { value } = await rpc.getTokenAccountBalance(account).send();
  return BigInt(value.amount);
}

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/** Create an associated token account if it is not there yet. */
function createAtaIdempotent(payer: Address, ata: Address, owner: Address, mint: Address): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
    data: Buffer.from([1]),
  };
}

function transferChecked(source: Address, mint: Address, destination: Address, owner: Address, amount: bigint): Instruction {
  return {
    programAddress: TOKEN_PROGRAM_ADDRESS,
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: destination, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY_SIGNER },
    ],
    data: Buffer.concat([Buffer.from([12]), u64le(amount), Buffer.from([config.usdcDecimals])]),
  };
}

function systemTransfer(from: Address, to: Address, lamports: bigint): Instruction {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

async function ownerKey(): Promise<Buffer> {
  const user = process.env.PASSKEY_USER || "beaver402-owner";
  const { data, error } = await getSupabase()
    .from("credentials")
    .select("public_key, created_at")
    .eq("user_id", user)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.[0]) {
    throw new Error(`no passkey registered for ${user}; register one in the panel first`);
  }
  return compressP256(coseToOwnerKey(new Uint8Array(decodeStoredBytes(data[0].public_key))));
}

function writeEnv(values: Record<string, string>) {
  let text = readFileSync(ENV_FILE, "utf-8");
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, "m").test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
      : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(ENV_FILE, text);
}

async function main() {
  await verifySolanaNetwork(config, rpc);
  const payer = await deployer();
  const merchant = solanaAddressOf(Keypair.fromSecret(need("MERCHANT_SECRET")).publicKey());
  const feeAccount = solanaAddressOf(Keypair.fromSecret(need("FEE_SOURCE_SECRET")).publicKey());
  const agent = solanaAddressOf(Keypair.fromSecret(need("AGENT_SECRET")).publicKey());
  const recovery = (process.env.SOLANA_RECOVERY_ADDRESS as Address | undefined) ?? payer.address;
  const mint = config.usdcMint;

  console.log(`deployer  ${payer.address}`);
  console.log(`agent     ${agent}`);
  console.log(`merchant  ${merchant}`);
  console.log(`fees      ${feeAccount}`);
  console.log(`recovery  ${recovery}`);

  // 1. the account
  let policy = process.env.SOLANA_POLICY_ADDRESS as Address | undefined;
  if (!policy || !(await exists(policy))) {
    const policyId = randomBytes(32);
    policy = await policyAddress(config.programId, policyId);
    const vault = await associatedToken(policy, mint);
    const rpId = process.env.RP_ID || "localhost";
    await send(
      payer,
      [
        initializeInstruction(
          config.programId,
          { payer: payer.address, policy, mint, vault },
          {
            policyId,
            owner: await ownerKey(),
            rpIdHash: createHash("sha256").update(rpId).digest(),
            networkId: createHash("sha256").update(config.caip2).digest(),
            agentSigner: agent,
            recovery,
            limits: LIMITS,
          }
        ),
      ],
      "initialize"
    );
    writeEnv({ SOLANA_POLICY_ADDRESS: policy });
  }
  console.log(`policy    ${policy}`);

  // 2. the vault
  const vault = await associatedToken(policy, mint);
  const source = await associatedToken(payer.address, mint);
  const held = await tokenBalance(vault);
  if (held < VAULT_FUNDING) {
    const amount = VAULT_FUNDING - held;
    if ((await tokenBalance(source)) < amount) {
      throw new Error(`the deployer holds less than ${amount} USDC units; use faucet.circle.com`);
    }
    await send(payer, [transferChecked(source, mint, vault, payer.address, amount)], "fund vault");
  }

  // 3 and 4. fees, and the merchant's USDC account
  const instructions: Instruction[] = [];
  for (const account of [merchant, feeAccount]) {
    const { value } = await rpc.getBalance(account).send();
    if (value < FEE_LAMPORTS / 2n) instructions.push(systemTransfer(payer.address, account, FEE_LAMPORTS));
  }
  const recipient = (process.env.SOLANA_RECIPIENT_ADDRESS as Address | undefined) ?? merchant;
  const recipientToken = await associatedToken(recipient, mint);
  if (!(await exists(recipientToken))) instructions.push(createAtaIdempotent(payer.address, recipientToken, recipient, mint));
  const recoveryToken = await associatedToken(recovery, mint);
  if (!(await exists(recoveryToken))) instructions.push(createAtaIdempotent(payer.address, recoveryToken, recovery, mint));
  if (instructions.length > 0) await send(payer, instructions, "fees and token accounts");

  // 5. turn Solana on
  writeEnv({ BEAVER_CHAINS: "stellar,solana" });
  console.log("\nready. Approve the merchant with the passkey in the panel, on Solana.");
  console.log(`merchant to approve: ${merchant}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
