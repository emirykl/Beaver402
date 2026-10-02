import * as StellarSdk from "@stellar/stellar-sdk";
import { getEstimatedLedgerCloseTimeSeconds } from "@x402/stellar";
import {
  createIntentFromChallenge,
  verifyChallengeIntentMatch,
} from "./buyer-intent.js";
import { verifyMerchantSignature } from "../merchant/challenge-signer.js";
import { normalizeAmount, requestDigest } from "../shared/hashing.js";
import { buildAgentSignatureScVal } from "./policy-signature.js";
import { network, rpcServer, verifyNetwork } from "../config/network.js";
import {
  challengeFrom,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "../x402/protocol.js";
import type { SignedChallenge, PolicySignaturePayload } from "../shared/types.js";

/** The longest a challenge may stay valid. Mirrors MAX_CHALLENGE_LIFETIME. */
const MAX_CHALLENGE_LIFETIME = 900;

/**
 * Simulations need a source account but this payment never uses one: the
 * facilitator rebuilds the transaction around its own account and pays the
 * fee. The agent's key only ever signs the authorization entry, so it needs
 * no account, no balance and no sequence number of its own.
 */
const NO_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export interface Beaver402AdapterConfig {
  agentKeypair: StellarSdk.Keypair;
  policyContractId: string;
}

/** The result of turning a 402 answer into a payment, before anything settles. */
export interface PreparedPayment {
  success: boolean;
  error?: string;
  /** What to send back to the merchant in PAYMENT-SIGNATURE. */
  payload?: PaymentPayload;
  requirements?: PaymentRequirements;
  challenge?: SignedChallenge;
  challengeHash?: string;
  intentHash?: string;
}

export class Beaver402Adapter {
  private config: Beaver402AdapterConfig;

  constructor(config: Beaver402AdapterConfig) {
    this.config = config;
  }

  /**
   * Decide whether to pay what the merchant asked for, and if so build the
   * x402 payment for it.
   *
   * Every check here is one the contract makes again, but nothing is signed
   * for a payment that would fail them. The facilitator only ever sees a
   * payment the policy account has already been simulated agreeing to.
   */
  async preparePayment(
    required: PaymentRequired,
    observedMethod: string,
    observedEndpoint: string,
    observedBody?: string | Buffer | null
  ): Promise<PreparedPayment> {
    const config = network();

    // step 1: the merchant has to accept this account's USDC, on this
    // network, through the standard exact scheme with fees sponsored
    const requirements = required.accepts?.find(
      (r) => r.scheme === "exact" && r.network === config.caip2 && r.asset === config.usdcContract
    );
    if (!requirements) {
      return {
        success: false,
        error: `the merchant does not accept USDC on ${config.caip2} through the exact scheme`,
      };
    }
    if (requirements.extra?.areFeesSponsored !== true) {
      return { success: false, error: "the exact scheme on Stellar needs fees sponsored by the facilitator" };
    }

    // step 2: the Beaver402 challenge, for this network and this token
    const challenge = challengeFrom(required);
    if (!challenge) {
      return { success: false, error: "the merchant asked for payment without a signed Beaver402 challenge" };
    }
    if (challenge.fields.network !== config.passphrase) {
      return {
        success: false,
        error: `the challenge is for another network, this backend pays on ${config.name}`,
      };
    }
    if (challenge.fields.asset !== config.usdcContract) {
      return {
        success: false,
        error: `the challenge asks for ${challenge.fields.asset}, this account pays in USDC ${config.usdcContract}`,
      };
    }

    // step 3: the challenge and the x402 requirements have to describe the
    // same payment, or the facilitator would settle something the merchant
    // never signed for
    const disagreement = describeDisagreement(challenge, requirements);
    if (disagreement) {
      return { success: false, error: `the challenge and the payment requirements disagree on ${disagreement}` };
    }

    // step 4: verify merchant signature on the challenge
    if (!verifyMerchantSignature(challenge)) {
      return { success: false, error: "merchant signature verification failed" };
    }

    // step 5: create buyer intent from the observed request and compare
    const intent = createIntentFromChallenge(challenge, observedMethod, observedEndpoint, observedBody);
    const matchResult = verifyChallengeIntentMatch(challenge, intent);
    if (!matchResult.matches) {
      return {
        success: false,
        error: `challenge-intent mismatch: ${matchResult.reason}`,
        challengeHash: challenge.hash,
        intentHash: intent.hash,
      };
    }

    // step 6: expiry, the way the contract will judge it
    const now = Math.floor(Date.now() / 1000);
    const expiry = parseInt(challenge.fields.expiry, 10);
    if (!expiry || now > expiry) {
      return { success: false, error: "challenge has expired" };
    }
    if (expiry - now > MAX_CHALLENGE_LIFETIME) {
      return { success: false, error: "the challenge stays valid for longer than the account allows" };
    }

    // step 7: build the transfer and have the policy account authorize it
    try {
      const transaction = await this.authorizedTransfer(challenge, requirements);
      return {
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
        success: false,
        error: err instanceof Error ? err.message : String(err),
        challengeHash: challenge.hash,
        intentHash: intent.hash,
      };
    }
  }

  private policyPayload(challenge: SignedChallenge): PolicySignaturePayload {
    // The agent signature covers the Soroban authorization payload, which is
    // only known once the transaction is assembled. It is filled in when the
    // authorization entry is signed.
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
   * The x402 exact payment: one token transfer out of the policy account,
   * with the account's authorization entry signed and nothing else.
   *
   * The money moves out of the smart account, which is what puts the policy
   * in the authorization chain. The agent signs the entry the host hands it,
   * and the merchant side of the proof of intent rides along in the same
   * value, so the contract sees both halves at once.
   */
  private async authorizedTransfer(
    challenge: SignedChallenge,
    requirements: PaymentRequirements
  ): Promise<string> {
    await verifyNetwork();
    const config = network();
    const server = rpcServer();
    const policyPayload = this.policyPayload(challenge);

    const transfer = (auth?: StellarSdk.xdr.SorobanAuthorizationEntry[]) =>
      StellarSdk.Operation.invokeContractFunction({
        contract: requirements.asset,
        function: "transfer",
        args: [
          StellarSdk.Address.fromString(this.config.policyContractId).toScVal(),
          StellarSdk.Address.fromString(requirements.payTo).toScVal(),
          StellarSdk.nativeToScVal(BigInt(requirements.amount), { type: "i128" }),
        ],
        auth,
      });

    const build = (auth?: StellarSdk.xdr.SorobanAuthorizationEntry[]) =>
      new StellarSdk.TransactionBuilder(new StellarSdk.Account(NO_SOURCE, "0"), {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: config.passphrase,
      })
        .addOperation(transfer(auth))
        .setTimeout(requirements.maxTimeoutSeconds)
        .build();

    // The first simulation tells us which authorization entry the host
    // wants. It comes back unsigned.
    const probe = await server.simulateTransaction(build());
    if (!StellarSdk.rpc.Api.isSimulationSuccess(probe)) {
      throw new Error(`simulation failed: ${(probe as { error?: string }).error}`);
    }
    const entries = probe.result?.auth ?? [];
    if (entries.length !== 1) {
      throw new Error(`expected one authorization entry for the policy account, got ${entries.length}`);
    }

    // The facilitator refuses an entry valid for longer than the payment's
    // timeout, measured in ledgers at the network's current pace.
    const { sequence } = await server.getLatestLedger();
    const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(config.caip2);
    const validUntil = sequence + Math.ceil(requirements.maxTimeoutSeconds / ledgerSeconds);

    const signed = await StellarSdk.authorizeEntry(
      entries[0]!,
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
      config.passphrase
    );

    // Simulated again with the signed entry, the policy actually runs. A
    // refusal surfaces here, named, before anything reaches the facilitator.
    const authorized = build([signed]);
    const simulated = await server.simulateTransaction(authorized);
    if (!StellarSdk.rpc.Api.isSimulationSuccess(simulated)) {
      throw new Error(`policy rejected the payment: ${(simulated as { error?: string }).error}`);
    }

    return StellarSdk.rpc.assembleTransaction(authorized, simulated).build().toXDR();
  }
}

/** The first field on which a challenge and the x402 requirements differ. */
function describeDisagreement(
  challenge: SignedChallenge,
  requirements: PaymentRequirements
): string | null {
  if (challenge.fields.asset !== requirements.asset) return "the asset";
  if (challenge.fields.recipient !== requirements.payTo) return "the recipient";
  if (normalizeAmount(challenge.fields.amount) !== normalizeAmount(requirements.amount)) return "the amount";
  return null;
}

export function createAdapter(
  agentSecret: string,
  policyContractId: string
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
  });
}
