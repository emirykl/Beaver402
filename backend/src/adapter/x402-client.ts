import * as StellarSdk from "@stellar/stellar-sdk";
import {
  createIntentFromChallenge,
  verifyChallengeIntentMatch,
} from "./buyer-intent.js";
import { verifyMerchantSignature } from "../merchant/challenge-signer.js";
import { normalizeAmount, requestDigest } from "../shared/hashing.js";
import { buildAgentSignatureScVal } from "./policy-signature.js";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import type {
  SignedChallenge,
  PolicySignaturePayload,
} from "../shared/types.js";

const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
const BASE_FEE = "10000000";

/// How long a signed authorization stays usable, in ledgers. Roughly five
/// minutes, which is well inside the challenge expiry the merchant sets.
const AUTH_VALIDITY_LEDGERS = 60;

/// Seconds to wait for a ledger to close on the transaction. Testnet is
/// usually a few seconds but has been slower under load.
const CONFIRMATION_ATTEMPTS = 60;

/// How many times to rebuild when the node hands back a sequence the network
/// has already moved past.
const SEND_ATTEMPTS = 3;

/** Did the network refuse this because the sequence was stale? */
function isStaleSequence(response: { errorResult?: unknown }): boolean {
  return JSON.stringify(response.errorResult ?? "").includes("txBadSeq");
}

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
    // The agent signature covers the Soroban authorization payload, which is
    // only known once the transaction is assembled. It is filled in when the
    // authorization entry is signed; see submitPayment.
    return {
      agentSignature: "",
      merchantPubkey: challenge.merchantPubkey,
      merchantSignature: challenge.merchantSignature,
      requestDigest: requestDigest(challenge.fields).toString("hex"),
      recipient: challenge.fields.recipient,
      asset: challenge.fields.asset,
      amount: normalizeAmount(challenge.fields.amount),
      nonce: challenge.fields.nonce,
      expiry: challenge.fields.expiry,
    };
  }

  /**
   * Sign one authorization entry on behalf of the smart account.
   *
   * The host hands us the payload it will pass to __check_auth as
   * signature_payload. The agent signs exactly that, and the merchant side of
   * the proof of intent rides along in the same value, so the contract sees
   * both halves at once.
   */
  private async signAuthorizationEntry(
    entry: StellarSdk.xdr.SorobanAuthorizationEntry,
    policyPayload: PolicySignaturePayload,
    validUntil: number
  ): Promise<StellarSdk.xdr.SorobanAuthorizationEntry> {
    return StellarSdk.authorizeEntry(
      entry,
      async (_preimage, payload) => {
        const agentSignature = this.config.agentKeypair.sign(payload);
        return {
          signatureScVal: buildAgentSignatureScVal({
            ...policyPayload,
            agentSignature: agentSignature.toString("base64"),
          }),
        };
      },
      validUntil,
      NETWORK_PASSPHRASE
    );
  }

  private async submitPayment(
    challenge: SignedChallenge,
    policyPayload: PolicySignaturePayload
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const server = new StellarSdk.rpc.Server(SOROBAN_RPC_URL);
    const agentPubkey = this.config.agentKeypair.publicKey();
    const sourceAccount = await server.getAccount(agentPubkey);

    // The money moves out of the smart account, not out of the agent's own
    // account. That is what puts the policy contract in the authorization
    // chain and gets __check_auth called before anything settles. The agent
    // is only the source of the transaction, which means it pays the fee and
    // nothing more.
    const transfer = () =>
      StellarSdk.Operation.invokeContractFunction({
        contract: challenge.fields.asset,
        function: "transfer",
        args: [
          StellarSdk.Address.fromString(this.config.policyContractId).toScVal(),
          StellarSdk.Address.fromString(challenge.fields.recipient).toScVal(),
          StellarSdk.nativeToScVal(BigInt(policyPayload.amount), { type: "i128" }),
        ],
      });

    const draft = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(transfer())
      .setTimeout(300)
      .build();

    // The first simulation tells us which authorization entries the host
    // wants. They come back unsigned.
    const probe = await server.simulateTransaction(draft);
    if (StellarSdk.rpc.Api.isSimulationError(probe)) {
      return { success: false, error: `simulation failed: ${probe.error}` };
    }

    const entries = probe.result?.auth ?? [];
    if (entries.length === 0) {
      return {
        success: false,
        error: "the transfer produced no authorization entry for the policy account",
      };
    }

    const { sequence } = await server.getLatestLedger();
    const validUntil = sequence + AUTH_VALIDITY_LEDGERS;

    let signedEntries: StellarSdk.xdr.SorobanAuthorizationEntry[];
    try {
      signedEntries = await Promise.all(
        entries.map((entry) =>
          this.signAuthorizationEntry(entry, policyPayload, validUntil)
        )
      );
    } catch (err) {
      return { success: false, error: `authorization signing failed: ${err}` };
    }

    // Rebuild the call carrying the signed entries, then simulate once more
    // so the footprint and resource fees account for the policy running.
    //
    // The account is read again each time round, because building the probe
    // advanced the sequence on the copy we were holding and that probe was
    // never submitted. The node can also still be a ledger behind after an
    // earlier payment, which shows up as a rejected sequence, so a stale one
    // is worth one more try rather than reporting the payment as refused.
    let sendResponse: Awaited<ReturnType<typeof server.sendTransaction>> | null = null;

    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
      const account = await server.getAccount(agentPubkey);

      const authorized = new StellarSdk.TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          StellarSdk.Operation.invokeContractFunction({
            contract: challenge.fields.asset,
            function: "transfer",
            args: [
              StellarSdk.Address.fromString(this.config.policyContractId).toScVal(),
              StellarSdk.Address.fromString(challenge.fields.recipient).toScVal(),
              StellarSdk.nativeToScVal(BigInt(policyPayload.amount), { type: "i128" }),
            ],
            auth: signedEntries,
          })
        )
        .setTimeout(300)
        .build();

      const simulated = await server.simulateTransaction(authorized);
      if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
        // A policy refusal surfaces here, before anything is submitted.
        return {
          success: false,
          error: `policy rejected the payment: ${simulated.error}`,
        };
      }

      const prepared = StellarSdk.rpc.assembleTransaction(authorized, simulated).build();
      prepared.sign(this.config.agentKeypair);

      sendResponse = await server.sendTransaction(prepared);
      if (sendResponse.status !== "ERROR") {
        break;
      }

      if (!isStaleSequence(sendResponse) || attempt === SEND_ATTEMPTS - 1) {
        return {
          success: false,
          error: `send failed: ${JSON.stringify(sendResponse)}`,
        };
      }

      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!sendResponse) {
      return { success: false, error: "the transaction was never submitted" };
    }

    // Wait for the network to say what happened.
    let getResponse = await server.getTransaction(sendResponse.hash);
    let attempt = 0;
    while (getResponse.status === "NOT_FOUND" && attempt < CONFIRMATION_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, 1000));
      getResponse = await server.getTransaction(sendResponse.hash);
      attempt++;
    }

    if (getResponse.status === "SUCCESS") {
      return { success: true, txHash: sendResponse.hash };
    }

    // Running out of patience is not the same as being refused. The
    // transaction may still land, so this reports that the outcome is
    // unknown rather than claiming nothing was paid.
    if (getResponse.status === "NOT_FOUND") {
      return {
        success: false,
        error:
          `the network did not confirm ${sendResponse.hash} within ` +
          `${CONFIRMATION_ATTEMPTS} seconds, so the outcome is unknown`,
        txHash: sendResponse.hash,
      };
    }

    return {
      success: false,
      error: `transaction ${getResponse.status}`,
      txHash: sendResponse.hash,
    };
  }
}

export function createAdapter(
  agentSecret: string,
  policyContractId: string,
  network = "testnet"
): Beaver402Adapter {
  // Without a deployed policy there is nothing to authorize against, and the
  // failure would otherwise surface as an unhelpful address parse error deep
  // inside the payment.
  if (!policyContractId) {
    throw new Error(
      "POLICY_CONTRACT_ID is required. Deploy the policy contract first with scripts/deploy.sh"
    );
  }

  return new Beaver402Adapter({
    agentKeypair: StellarSdk.Keypair.fromSecret(agentSecret),
    policyContractId,
    network,
  });
}
