import * as StellarSdk from "@stellar/stellar-sdk";
import {
  createIntentFromChallenge,
  verifyChallengeIntentMatch,
} from "./buyer-intent.js";
import { verifyMerchantSignature } from "../merchant/challenge-signer.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import type {
  SignedChallenge,
  PolicySignaturePayload,
} from "../shared/types.js";

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

export interface Beaver402AdapterConfig {
  agentKeypair: StellarSdk.Keypair;
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

async function logTransaction(
  challenge: SignedChallenge,
  result: PaymentResult
): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    const supabase = getSupabase();
    await supabase.from("transactions").insert({
      tx_hash: result.txHash ?? null,
      challenge_hash: result.challengeHash ?? null,
      intent_hash: result.intentHash ?? null,
      merchant_pubkey: challenge.merchantPubkey,
      recipient: challenge.fields.recipient,
      asset: challenge.fields.asset,
      amount: challenge.fields.amount,
      network: challenge.fields.network,
      status: result.success ? "success" : "failed",
      error: result.error ?? null,
    });
  } catch {
    // logging failure should not break the payment flow
  }
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
    if (!expiry || now > expiry) {
      return {
        success: false,
        error: "challenge has expired",
      };
    }

    // step 5: build policy signature payload for the contract
    const policyPayload = this.buildPolicyPayload(challenge, intent.hash);

    // step 6: submit USDC payment through Soroban
    let result: PaymentResult;
    try {
      const txResult = await this.submitPayment(challenge, policyPayload);
      result = {
        success: txResult.success,
        txHash: txResult.txHash,
        error: txResult.error,
        challengeHash: challenge.hash,
        intentHash: intent.hash,
      };
    } catch (err) {
      result = {
        success: false,
        error: `payment submission failed: ${err}`,
        challengeHash: challenge.hash,
        intentHash: intent.hash,
      };
    }

    await logTransaction(challenge, result);
    return result;
  }

  private buildPolicyPayload(
    challenge: SignedChallenge,
    intentHash: string
  ): PolicySignaturePayload {
    // agent signs the challenge hash to prove authorization
    const challengeBytes = Buffer.from(challenge.hash, "hex");
    const agentSig = this.config.agentKeypair.sign(challengeBytes);

    return {
      agentSignature: agentSig.toString("base64"),
      merchantPubkey: challenge.merchantPubkey,
      merchantSignature: challenge.merchantSignature,
      challengeHash: challenge.hash,
      intentHash,
      nonce: challenge.fields.nonce,
      expiry: challenge.fields.expiry,
    };
  }

  private async submitPayment(
    challenge: SignedChallenge,
    policyPayload: PolicySignaturePayload
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const server = new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
    const agentPubkey = this.config.agentKeypair.publicKey();
    const sourceAccount = await server.getAccount(agentPubkey);

    // build the USDC transfer invocation through the policy contract
    // the policy contract's __check_auth will be triggered as part of
    // the authorization chain when the smart account transfers USDC
    const recipientAddress = StellarSdk.Address.fromString(
      challenge.fields.recipient
    );
    const amount = BigInt(challenge.fields.amount);

    // find testnet USDC issuer
    const usdcIssuer =
      process.env.USDC_ISSUER ||
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "10000000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.invokeContractFunction({
          contract: usdcIssuer,
          function: "transfer",
          args: [
            StellarSdk.Address.fromString(agentPubkey).toScVal(),
            recipientAddress.toScVal(),
            StellarSdk.nativeToScVal(amount, { type: "i128" }),
          ],
        })
      )
      .setTimeout(300)
      .build();

    // simulate to get auth requirements
    const simulated = await server.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulated)) {
      return {
        success: false,
        error: `simulation failed: ${simulated.error}`,
      };
    }

    const prepared = StellarSdk.SorobanRpc.assembleTransaction(
      tx,
      simulated as StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse
    ).build();

    prepared.sign(this.config.agentKeypair);

    const sendResponse = await server.sendTransaction(prepared);
    if (sendResponse.status === "ERROR") {
      return {
        success: false,
        error: `send failed: ${JSON.stringify(sendResponse)}`,
      };
    }

    // poll for result
    let getResponse = await server.getTransaction(sendResponse.hash);
    const maxAttempts = 30;
    let attempt = 0;
    while (getResponse.status === "NOT_FOUND" && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000));
      getResponse = await server.getTransaction(sendResponse.hash);
      attempt++;
    }

    if (getResponse.status === "SUCCESS") {
      return { success: true, txHash: sendResponse.hash };
    }

    return {
      success: false,
      error: `transaction ${getResponse.status}`,
    };
  }
}

export function createAdapter(
  agentSecret: string,
  policyContractId: string,
  network = "testnet"
): Beaver402Adapter {
  return new Beaver402Adapter({
    agentKeypair: StellarSdk.Keypair.fromSecret(agentSecret),
    policyContractId,
    network,
  });
}
