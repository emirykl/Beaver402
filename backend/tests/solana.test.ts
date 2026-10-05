import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
} from "@solana/kit";
import { Keypair } from "@stellar/stellar-sdk";

import { hashChallenge, hashIntent, requestDigest } from "../src/shared/hashing.js";
import {
  solanaOwnerChallenge,
  solanaSettlementPreimage,
  addressBytes,
} from "../src/chains/solana/encoding.js";
import { loadSolanaConfig } from "../src/chains/solana/config.js";
import { paymentTransaction } from "../src/chains/solana/adapter.js";
import { confirmTransfer, readSolanaPayment } from "../src/chains/solana/settlement.js";
import { decodePolicyAccount, velocityState } from "../src/chains/solana/policy-account.js";
import {
  compressP256,
  decodePayArgs,
  discriminator,
  encodePayArgs,
  solanaAddressOf,
  solanaKeyPair,
} from "../src/chains/solana/program.js";
import { createSignedChallenge, verifyMerchantSignature } from "../src/merchant/challenge-signer.js";
import { bindPaymentToRequest, PaymentBindingError } from "../src/merchant/payment-binding.js";
import { describePolicyError } from "../src/shared/policy-errors.js";
import { chainPreference, MultiChainAdapter, type ChainAdapter } from "../src/adapter/multi-chain.js";
import { enabledChains } from "../src/chains/registry.js";
import type { PayloadFields } from "../src/shared/types.js";
import type { PaymentRequired } from "../src/x402/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(resolve(here, "../../test-vectors/vectors-solana.json"), "utf-8"));

const config = loadSolanaConfig({ SOLANA_POLICY_ADDRESS: "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG" });
const POLICY = config.policy!;
const BLOCKHASH = { blockhash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", lastValidBlockHeight: 100n };

const MERCHANT = Keypair.random();
const AGENT = Keypair.random();
const MERCHANT_ADDRESS = solanaAddressOf(MERCHANT.publicKey());
const ENDPOINT = "https://merchant.test/api/data";

function challengeFor(overrides: { endpoint?: string; amount?: string; recipient?: string } = {}) {
  return createSignedChallenge({
    merchantKeypair: MERCHANT,
    merchantPubkey: MERCHANT_ADDRESS,
    httpMethod: "GET",
    endpoint: overrides.endpoint ?? ENDPOINT,
    body: null,
    recipient: overrides.recipient ?? MERCHANT_ADDRESS,
    asset: config.usdcMint,
    amount: overrides.amount ?? "100000",
    network: config.caip2,
    expirySeconds: 300,
  });
}

async function payment(challenge = challengeFor(), feePayer: Address = MERCHANT_ADDRESS) {
  return paymentTransaction({
    challenge,
    agentSecret: AGENT.secret(),
    feePayer,
    policy: POLICY,
    blockhash: BLOCKHASH,
    config,
  });
}

const merchantSide = { feePayer: MERCHANT_ADDRESS, recipient: MERCHANT_ADDRESS };
const merchantTerms = {
  keypair: MERCHANT,
  merchantPubkey: MERCHANT_ADDRESS,
  recipient: MERCHANT_ADDRESS,
  asset: config.usdcMint,
  amount: "100000",
  network: config.caip2,
};

describe("the Solana encoding", () => {
  it("reproduces the shared vectors the program checks", () => {
    for (const v of vectors.vectors) {
      const fields = v.fields as PayloadFields;
      expect(requestDigest(fields).toString("hex")).toBe(v.requestDigest);
      expect(solanaSettlementPreimage(fields).toString("hex")).toBe(v.settlementPreimage);
      expect(hashChallenge(fields).toString("hex")).toBe(v.challengeHash);
      expect(hashIntent(fields).toString("hex")).toBe(v.intentHash);
    }
    for (const v of vectors.ownerVectors) {
      const got = solanaOwnerChallenge({
        programId: v.programId,
        policy: v.policy,
        action: v.action,
        args: Buffer.from(v.args, "hex"),
        ownerNonce: BigInt(v.ownerNonce),
        validUntil: BigInt(v.validUntil),
      });
      expect(got.toString("hex")).toBe(v.challenge);
    }
  });

  it("never gives a Solana challenge the hash of a Stellar one", () => {
    const solana = vectors.vectors[0].fields as PayloadFields;
    expect(vectors.vectors[0].challengeHash).not.toBe(vectors.vectors[0].intentHash);
    expect(() => hashChallenge({ ...solana, network: "Test SDF Network ; September 2015" })).toThrow();
  });

  it("refuses an amount a u64 cannot carry", () => {
    const fields = { ...(vectors.vectors[0].fields as PayloadFields), amount: "18446744073709551616" };
    expect(() => solanaSettlementPreimage(fields)).toThrow(/u64/);
  });
});

describe("the program interface", () => {
  it("uses Anchor's discriminators", () => {
    expect([...discriminator("pay")]).toEqual([119, 18, 216, 65, 192, 117, 122, 220]);
    expect([...discriminator("freeze_payments")]).toEqual([24, 244, 215, 207, 58, 126, 45, 76]);
  });

  it("round trips the pay arguments", () => {
    const args = {
      merchantPubkey: Buffer.alloc(32, 1),
      requestDigest: Buffer.alloc(32, 2),
      amount: 100000n,
      nonce: Buffer.alloc(32, 3),
      expiry: 1700000300n,
    };
    const back = decodePayArgs(encodePayArgs(args))!;
    expect(back.amount).toBe(100000n);
    expect(back.expiry).toBe(1700000300n);
    expect(Buffer.from(back.nonce)).toEqual(args.nonce);
  });

  it("compresses a passkey's point the way the precompile takes it", () => {
    const x = Buffer.alloc(32, 7);
    const even = Buffer.concat([Buffer.from([4]), x, Buffer.alloc(31, 0), Buffer.from([2])]);
    const odd = Buffer.concat([Buffer.from([4]), x, Buffer.alloc(31, 0), Buffer.from([3])]);
    expect(compressP256(even)[0]).toBe(2);
    expect(compressP256(odd)[0]).toBe(3);
    expect(compressP256(odd).subarray(1)).toEqual(x);
  });

  it("gives one key the same identity on both chains", async () => {
    const { address: derived } = await solanaKeyPair(AGENT.secret());
    expect(derived).toBe(solanaAddressOf(AGENT.publicKey()));
    expect(addressBytes(derived, "agent")).toEqual(AGENT.rawPublicKey());
  });
});

describe("a merchant challenge for Solana", () => {
  it("is signed with the merchant's base58 identity and verifies", () => {
    const challenge = challengeFor();
    expect(challenge.merchantPubkey).toBe(MERCHANT_ADDRESS);
    expect(verifyMerchantSignature(challenge)).toBe(true);
  });

  it("does not verify once a field changed", () => {
    const challenge = challengeFor();
    challenge.fields.amount = "900000";
    expect(verifyMerchantSignature(challenge)).toBe(false);
  });
});

describe("the merchant reading a Solana payment", () => {
  it("reads the agreed terms and binds them to the request", async () => {
    const challenge = challengeFor();
    const read = await readSolanaPayment(await payment(challenge), merchantSide, config);
    expect(read.terms.payer).toBe(POLICY);
    expect(read.terms.amount).toBe("100000");
    expect(read.terms.nonce).toBe(challenge.fields.nonce);

    const { challengeHash } = bindPaymentToRequest(read.terms, { method: "GET", url: ENDPOINT, body: null }, merchantTerms);
    expect(challengeHash).toBe(challenge.hash);
  });

  it("refuses a payment made for another endpoint", async () => {
    const read = await readSolanaPayment(await payment(), merchantSide, config);
    expect(() =>
      bindPaymentToRequest(read.terms, { method: "GET", url: "https://merchant.test/api/other", body: null }, merchantTerms)
    ).toThrow(PaymentBindingError);
  });

  it("refuses a payment for another price", async () => {
    const read = await readSolanaPayment(await payment(challengeFor({ amount: "50000" })), merchantSide, config);
    expect(() => bindPaymentToRequest(read.terms, { method: "GET", url: ENDPOINT, body: null }, merchantTerms)).toThrow(
      /another amount/
    );
  });

  it("refuses a payment another account is meant to pay the fee for", async () => {
    const other = solanaAddressOf(Keypair.random().publicKey());
    await expect(readSolanaPayment(await payment(challengeFor(), other), merchantSide, config)).rejects.toThrow(
      /not paid for by this merchant/
    );
  });

  it("refuses a payment to another recipient", async () => {
    const elsewhere = solanaAddressOf(Keypair.random().publicKey());
    const wire = await payment(challengeFor({ recipient: elsewhere }));
    await expect(readSolanaPayment(wire, merchantSide, config)).rejects.toThrow(/another recipient/);
  });

  it("refuses something that is not a transaction", async () => {
    await expect(readSolanaPayment("bm90IGEgdHJhbnNhY3Rpb24=", merchantSide, config)).rejects.toThrow(PaymentBindingError);
  });

  it("refuses a payment the agent has not signed", async () => {
    const wire = await payment();
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const agent = solanaAddressOf(AGENT.publicKey());
    // Strip the agent's signature and re-encode.
    const stripped = { ...tx, signatures: { ...tx.signatures, [agent]: null } };
    const bytes = getTransactionEncoder().encode(stripped as typeof tx);
    await expect(readSolanaPayment(Buffer.from(bytes).toString("base64"), merchantSide, config)).rejects.toThrow(
      /not signed by the paying account's agent/
    );
  });
});

describe("confirming a Solana settlement on the ledger", () => {
  async function read() {
    return readSolanaPayment(await payment(), merchantSide, config);
  }

  function indexOf(p: Awaited<ReturnType<typeof read>>, key: Address) {
    return getCompiledTransactionMessageDecoder().decode(p.transaction.messageBytes).staticAccounts.indexOf(key);
  }

  it("accepts exactly the agreed transfer", async () => {
    const p = await read();
    const balance = (key: Address, amount: string) => ({
      accountIndex: indexOf(p, key),
      mint: config.usdcMint,
      uiTokenAmount: { amount },
    });
    expect(() =>
      confirmTransfer(
        "sig",
        {
          preTokenBalances: [balance(p.vault, "1000000"), balance(p.recipientToken, "0")],
          postTokenBalances: [balance(p.vault, "900000"), balance(p.recipientToken, "100000")],
        },
        p
      )
    ).not.toThrow();
  });

  it("refuses a settlement that moved another amount", async () => {
    const p = await read();
    const balance = (key: Address, amount: string) => ({
      accountIndex: indexOf(p, key),
      mint: config.usdcMint,
      uiTokenAmount: { amount },
    });
    expect(() =>
      confirmTransfer(
        "sig",
        {
          preTokenBalances: [balance(p.vault, "1000000"), balance(p.recipientToken, "0")],
          postTokenBalances: [balance(p.vault, "990000"), balance(p.recipientToken, "10000")],
        },
        p
      )
    ).toThrow();
  });
});

describe("reading the policy account", () => {
  function account(): Buffer {
    const data = Buffer.alloc(8 + 2960);
    createHash("sha256").update("account:Policy").digest().copy(data, 0, 0, 8);
    const body = data.subarray(8);
    body.writeBigUInt64LE(3n, 0);
    body.writeBigUInt64LE(1000000n, 8);
    body.writeBigUInt64LE(5000000n, 16);
    body.writeBigUInt64LE(86400n, 24);
    body.writeUInt32LE(5, 32);
    // one payment in slot 0
    body.writeBigUInt64LE(1700000000n, 40);
    body.writeBigUInt64LE(100000n, 48);
    addressBytes(MERCHANT_ADDRESS, "m").copy(body, 2472);
    addressBytes(solanaAddressOf(AGENT.publicKey()), "a").copy(body, 2824);
    addressBytes(config.usdcMint, "u").copy(body, 2856);
    body[2920] = 2;
    body[2953] = 1;
    body[2954] = 1;
    return data;
  }

  it("decodes the fields the panel shows", () => {
    const decoded = decodePolicyAccount(account());
    expect(decoded.ownerNonce).toBe(3n);
    expect(decoded.limits).toEqual({ maxPaymentAmount: "1000000", maxTxCount: 5, maxTotalAmount: "5000000", windowSize: 86400 });
    expect(decoded.merchants).toEqual([MERCHANT_ADDRESS]);
    expect(decoded.agentSigner).toBe(solanaAddressOf(AGENT.publicKey()));
    expect(decoded.asset).toBe(config.usdcMint);
    expect(decoded.frozen).toBe(true);
    expect(decoded.owner[0]).toBe(2);
    expect(velocityState(decoded, 1700000100)).toEqual({ txCount: 1, totalAmount: "100000", windowStart: 1700000000 });
    expect(velocityState(decoded, 1700086400).txCount).toBe(0);
  });

  it("reads a revoked agent as none", () => {
    const data = account();
    data.fill(0, 8 + 2824, 8 + 2856);
    expect(decodePolicyAccount(data).agentSigner).toBeNull();
  });

  it("refuses an account of another kind", () => {
    expect(() => decodePolicyAccount(Buffer.alloc(100))).toThrow();
  });
});

describe("refusals on Solana", () => {
  it("are described in the same words as on Stellar", () => {
    const logs = "Program log: AnchorError occurred. Error Code: NonceReused. Error Number: 6004. Error Message: this challenge has already been paid.";
    expect(describePolicyError(logs)).toBe("NonceReused, this challenge had already been paid once");
  });

  it("name the refusals only Solana has", () => {
    expect(describePolicyError("Error Code: UnexpectedInstruction. Error Number: 6022")).toMatch(/^UnexpectedInstruction, /);
  });
});

describe("the agent on several chains", () => {
  const required = (networks: string[]) =>
    ({ x402Version: 2, resource: { url: ENDPOINT }, accepts: networks.map((network) => ({ network })) }) as unknown as PaymentRequired;

  function chain(network: string, calls: string[]): ChainAdapter {
    return {
      accepts: (r) => !!r.accepts?.some((a) => a.network === network),
      preparePayment: async () => {
        calls.push(network);
        return { success: true };
      },
    };
  }

  it("pays on its first preferred chain the merchant accepts", async () => {
    const calls: string[] = [];
    const agent = new MultiChainAdapter([
      { chain: "stellar", adapter: chain("stellar:testnet", calls) },
      { chain: "solana", adapter: chain(config.caip2, calls) },
    ]);
    await agent.preparePayment(required([config.caip2, "stellar:testnet"]), "GET", ENDPOINT);
    expect(calls).toEqual(["stellar:testnet"]);
    await agent.preparePayment(required([config.caip2]), "GET", ENDPOINT);
    expect(calls).toEqual(["stellar:testnet", config.caip2]);
  });

  it("says so when the merchant accepts none of its chains", async () => {
    const agent = new MultiChainAdapter([{ chain: "stellar", adapter: chain("stellar:testnet", []) }]);
    const result = await agent.preparePayment(required(["eip155:1"]), "GET", ENDPOINT);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/eip155:1/);
  });

  it("orders chains by preference and keeps only enabled ones", () => {
    expect(chainPreference(["stellar", "solana"], { AGENT_CHAIN_PREFERENCE: "solana,stellar" })).toEqual(["solana", "stellar"]);
    expect(chainPreference(["stellar"], { AGENT_CHAIN_PREFERENCE: "solana,stellar" })).toEqual(["stellar"]);
  });

  it("runs on Stellar alone unless Solana is turned on", () => {
    expect(enabledChains({})).toEqual(["stellar"]);
    expect(enabledChains({ BEAVER_CHAINS: "stellar,solana" })).toEqual(["stellar", "solana"]);
    expect(() => enabledChains({ BEAVER_CHAINS: "ethereum" })).toThrow();
  });
});

describe("the Solana configuration", () => {
  it("is devnet only", () => {
    expect(() => loadSolanaConfig({ SOLANA_CLUSTER: "mainnet-beta" })).toThrow();
    expect(() => loadSolanaConfig({ SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" })).toThrow();
    expect(() => loadSolanaConfig({ SOLANA_USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" })).toThrow();
    expect(loadSolanaConfig({}).caip2).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(address(loadSolanaConfig({}).usdcMint)).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  });
});
