import { Keypair } from "@stellar/stellar-sdk";
import {
  createIntentFromChallenge,
  verifyChallengeIntentMatch,
} from "./buyer-intent.js";
import { verifyMerchantSignature } from "../merchant/challenge-signer.js";
import type {
  SignedChallenge,
  PolicySignaturePayload,
} from "../shared/types.js";

export interface Beaver402AdapterConfig {
  agentKeypair: Keypair;
  policyContractId: string;
  network: string;
}

export interface PaymentResult {
  success: boolean;
  txHash?: string;
  error?: string;
  challengeHash?: string;
  intentHash?: string;
}

export class Beaver402Adapter {
  private config: Beaver402AdapterConfig;

  constructor(config: Beaver402AdapterConfig) {
    this.config = config;
  }

  async processPayment(
    challenge: SignedChallenge,
    observedMethod: string,
    observedEndpoint: string,
    observedBody?: string | Buffer | null
  ): Promise<PaymentResult> {
    // step 1: verify merchant signature on the challenge
    if (!verifyMerchantSignature(challenge)) {
      return {
        success: false,
        error: "merchant signature verification failed",
      };
    }

    // step 2: create buyer intent from observed request
    const intent = createIntentFromChallenge(
      challenge,
      observedMethod,
      observedEndpoint,
      observedBody
    );

    // step 3: pre-check challenge vs intent field match
    const matchResult = verifyChallengeIntentMatch(challenge, intent);
    if (!matchResult.matches) {
      return {
        success: false,
        error: `challenge-intent mismatch: ${matchResult.reason}`,
        challengeHash: challenge.hash,
        intentHash: intent.hash,
      };
    }

    // step 4: check expiry
    const now = Math.floor(Date.now() / 1000);
    const expiry = parseInt(challenge.fields.expiry, 10);
    if (expiry > 0 && now > expiry) {
      return {
        success: false,
        error: "challenge has expired",
      };
    }

    // step 5: build policy signature payload for the contract
    const policyPayload = this.buildPolicyPayload(challenge, intent.hash);

    // step 6: submit to x402 facilitator
    // in testnet MVP, we simulate the facilitator flow
    const txResult = await this.submitToFacilitator(challenge, policyPayload);

    return {
      success: txResult.success,
      txHash: txResult.txHash,
      error: txResult.error,
      challengeHash: challenge.hash,
      intentHash: intent.hash,
    };
  }

  private buildPolicyPayload(
    challenge: SignedChallenge,
    intentHash: string
  ): PolicySignaturePayload {
    return {
      agentSignature: "", // filled during tx signing
      merchantPubkey: challenge.merchantPubkey,
      merchantSignature: challenge.merchantSignature,
      challengeHash: challenge.hash,
      intentHash,
      nonce: challenge.fields.nonce,
      expiry: challenge.fields.expiry,
    };
  }

  private async submitToFacilitator(
    challenge: SignedChallenge,
    policyPayload: PolicySignaturePayload
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    // testnet MVP: log the payment details
    // in production this would interact with the x402 facilitator
    console.log("submitting payment to x402 facilitator:", {
      recipient: challenge.fields.recipient,
      asset: challenge.fields.asset,
      amount: challenge.fields.amount,
      network: challenge.fields.network,
      challengeHash: policyPayload.challengeHash,
      intentHash: policyPayload.intentHash,
    });

    // simulate successful settlement
    const mockTxHash = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    return {
      success: true,
      txHash: mockTxHash,
    };
  }
}

export function createAdapter(
  agentSecret: string,
  policyContractId: string,
  network = "testnet"
): Beaver402Adapter {
  return new Beaver402Adapter({
    agentKeypair: Keypair.fromSecret(agentSecret),
    policyContractId,
    network,
  });
}
