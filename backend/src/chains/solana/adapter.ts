import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Base64EncodedWireTransaction,
} from "@solana/kit";

import { vetChallenge, type PreparedPayment } from "../../adapter/x402-client.js";
import { rawMerchantKey } from "../../merchant/challenge-signer.js";
import { normalizeAmount, requestDigest } from "../../shared/hashing.js";
import type { SignedChallenge } from "../../shared/types.js";
import {
  challengeFor,
  SOLANA_SCHEME,
  X402_VERSION,
  type PaymentRequired,
  type PaymentRequirements,
} from "../../x402/protocol.js";
import { requirePolicy, solana, solanaRpc, verifySolanaNetwork, type SolanaConfig, type SolanaRpc } from "./config.js";
import {
  associatedToken,
  computeUnitLimit,
  ed25519Instruction,
  payInstruction,
  solanaKeyPair,
} from "./program.js";

/** A payment uses about 26k units; this leaves room without inviting abuse. */
const PAYMENT_COMPUTE_UNITS = 60_000;

/**
 * The agent's side of a Beaver402 payment on Solana.
 *
 * The same decisions as the Stellar adapter, then a different payment: a
 * transaction holding the merchant's signature, checked by the ed25519
 * precompile, and the policy program's pay instruction. The agent signs it
 * as the delegated signer and nothing else. The merchant is the fee payer
 * and settles it.
 */
export class SolanaAdapter {
  constructor(
    private readonly agentSecret: string,
    private readonly config: SolanaConfig = solana(),
    private readonly rpc: SolanaRpc = solanaRpc(config)
  ) {}

  /** Whether the merchant offers a payment this adapter can make. */
  accepts(required: PaymentRequired): boolean {
    return !!this.requirementsIn(required);
  }

  private requirementsIn(required: PaymentRequired): PaymentRequirements | undefined {
    return required.accepts?.find(
      (r) => r.scheme === SOLANA_SCHEME && r.network === this.config.caip2 && r.asset === this.config.usdcMint
    );
  }

  async preparePayment(
    required: PaymentRequired,
    observedMethod: string,
    observedEndpoint: string,
    observedBody?: string | Buffer | null
  ): Promise<PreparedPayment> {
    const config = this.config;

    // step 1: the merchant has to accept USDC on this cluster through the
    // Beaver402 scheme, and say who pays the fee
    const requirements = this.requirementsIn(required);
    if (!requirements) {
      return { chain: "solana", success: false, error: `the merchant does not accept USDC on ${config.caip2}` };
    }
    const feePayer = requirements.extra?.feePayer;
    if (typeof feePayer !== "string") {
      return { chain: "solana", success: false, error: "the merchant did not say which account pays the fee" };
    }

    // step 2: the Beaver402 challenge for this cluster and this mint
    const challenge = challengeFor(required, config.caip2);
    if (!challenge) {
      return {
        chain: "solana",
        success: false,
        error: "the merchant asked for payment without a signed Beaver402 challenge for Solana",
      };
    }
    if (challenge.fields.network !== config.caip2) {
      return { chain: "solana", success: false, error: `the challenge is for another network, this agent pays on ${config.caip2}` };
    }
    if (challenge.fields.asset !== config.usdcMint) {
      return {
        chain: "solana",
        success: false,
        error: `the challenge asks for ${challenge.fields.asset}, this account pays in USDC ${config.usdcMint}`,
      };
    }

    // steps 3 to 6, shared with Stellar
    const vetted = vetChallenge(challenge, requirements, observedMethod, observedEndpoint, observedBody);
    if (!vetted.ok) {
      return {
        chain: "solana",
        success: false,
        error: vetted.error,
        challengeHash: vetted.challengeHash,
        intentHash: vetted.intentHash,
      };
    }
    const intent = vetted.intent;

    // step 7: build the payment, sign it as the agent, and have the
    // program run it in simulation so a refusal carries its own reason
    try {
      const transaction = await this.authorizedPayment(challenge, address(feePayer));
      return {
        chain: "solana",
        success: true,
        payload: {
          x402Version: X402_VERSION,
          resource: required.resource,
          accepted: requirements,
          payload: { transaction },
        },
        requirements,
        challenge,
        challengeHash: challenge.hash,
        intentHash: intent.hash,
      };
    } catch (err) {
      return {
        chain: "solana",
        success: false,
        error: err instanceof Error ? err.message : String(err),
        challengeHash: challenge.hash,
        intentHash: intent.hash,
      };
    }
  }

  private async authorizedPayment(challenge: SignedChallenge, feePayer: Address): Promise<Base64EncodedWireTransaction> {
    await verifySolanaNetwork(this.config, this.rpc);
    const config = this.config;
    const policy = requirePolicy(config);
    const { value: blockhash } = await this.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const wire = await paymentTransaction({
      challenge,
      agentSecret: this.agentSecret,
      feePayer,
      policy,
      blockhash,
      config,
    });

    // The fee payer has not signed yet, so the simulation skips signature
    // checks. The program still runs every policy check.
    const simulated = await this.rpc
      .simulateTransaction(wire, { encoding: "base64", sigVerify: false, commitment: "confirmed" })
      .send();
    if (simulated.value.err) {
      const logs = (simulated.value.logs ?? []).join("\n");
      const err = JSON.stringify(simulated.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      throw new Error(`policy rejected the payment: ${logs || err}`);
    }
    return wire;
  }
}

export interface PaymentTransactionInput {
  challenge: SignedChallenge;
  agentSecret: string;
  feePayer: Address;
  policy: Address;
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  config: SolanaConfig;
}

/**
 * The payment transaction, signed by the agent and waiting for the fee
 * payer: a compute limit, the merchant's signature for the ed25519
 * precompile, and the policy program's pay instruction with the terms the
 * merchant signed.
 */
export async function paymentTransaction(input: PaymentTransactionInput): Promise<Base64EncodedWireTransaction> {
  const { challenge, config, policy } = input;
  const agent = await solanaKeyPair(input.agentSecret);
  const recipient = address(challenge.fields.recipient);

  const merchantKey = rawMerchantKey(challenge.merchantPubkey);
  const signature = Buffer.from(challenge.merchantSignature, "base64");
  const challengeHash = Buffer.from(challenge.hash, "hex");

  const pay = payInstruction(
    config.programId,
    {
      agent: agent.address,
      policy,
      mint: config.usdcMint,
      vault: await associatedToken(policy, config.usdcMint),
      recipient,
      recipientToken: await associatedToken(recipient, config.usdcMint),
    },
    {
      merchantPubkey: merchantKey,
      requestDigest: requestDigest(challenge.fields),
      amount: BigInt(normalizeAmount(challenge.fields.amount)),
      nonce: Buffer.from(challenge.fields.nonce, "hex"),
      expiry: BigInt(challenge.fields.expiry),
    }
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0], m),
    (m) =>
      appendTransactionMessageInstructions(
        [computeUnitLimit(PAYMENT_COMPUTE_UNITS), ed25519Instruction(merchantKey, signature, challengeHash), pay],
        m
      )
  );
  const signed = await partiallySignTransaction([agent.keyPair], compileTransaction(message));
  return getBase64EncodedWireTransaction(signed);
}
