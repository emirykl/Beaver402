import { randomBytes } from "node:crypto";
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
  challengeFor,
  challengeFrom,
  X402_VERSION,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "../x402/protocol.js";
import type { SignedChallenge, SignedIntent, PolicySignaturePayload } from "../shared/types.js";

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
  /** Which chain the payment was prepared for. */
  chain?: "stellar" | "solana";
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

  /** Whether the merchant offers the Stellar payment this account makes. */
  accepts(required: PaymentRequired): boolean {
    const config = network();
    return !!required.accepts?.some(
      (r) => r.scheme === "exact" && r.network === config.caip2 && r.asset === config.usdcContract
    );
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
    const challenge = challengeFor(required, config.caip2) ?? challengeFrom(required);
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

    const vetted = vetChallenge(challenge, requirements, observedMethod, observedEndpoint, observedBody);
    if (!vetted.ok) {
      return { success: false, error: vetted.error, challengeHash: vetted.challengeHash, intentHash: vetted.intentHash };
    }
    const intent = vetted.intent;

    // step 7: build the transfer and have the policy account authorize it
    try {
      const transaction = await this.authorizedTransfer(challenge, requirements);
      return {
        chain: "stellar",
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

    const transferArgs = [
      StellarSdk.Address.fromString(this.config.policyContractId).toScVal(),
      StellarSdk.Address.fromString(requirements.payTo).toScVal(),
      StellarSdk.nativeToScVal(BigInt(requirements.amount), { type: "i128" }),
    ];
    const transfer = (auth?: StellarSdk.xdr.SorobanAuthorizationEntry[]) =>
      StellarSdk.Operation.invokeContractFunction({
        contract: requirements.asset,
        function: "transfer",
        args: transferArgs,
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

    // The authorization the transfer needs from the policy account is known
    // exactly: this one call, by this account, nothing nested. Building it
    // here rather than asking a simulation for it means the only simulation
    // that runs is the one with the signature, where the policy is consulted
    // before anything else, so a refusal always carries the policy's own
    // reason rather than, say, the token's view of the balance.
    const unsigned = new StellarSdk.xdr.SorobanAuthorizationEntry({
      credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
        new StellarSdk.xdr.SorobanAddressCredentials({
          address: StellarSdk.Address.fromString(this.config.policyContractId).toScAddress(),
          nonce: new StellarSdk.xdr.Int64(randomBytes(8).readBigInt64BE()),
          signatureExpirationLedger: 0,
          signature: StellarSdk.xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: new StellarSdk.xdr.SorobanAuthorizedInvocation({
        function: StellarSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new StellarSdk.xdr.InvokeContractArgs({
            contractAddress: StellarSdk.Address.fromString(requirements.asset).toScAddress(),
            functionName: "transfer",
            args: transferArgs,
          })
        ),
        subInvocations: [],
      }),
    });

    // The facilitator refuses an entry valid for longer than the payment's
    // timeout, measured in ledgers at the network's current pace.
    const { sequence } = await server.getLatestLedger();
    const ledgerSeconds = await getEstimatedLedgerCloseTimeSeconds(config.caip2);
    const validUntil = sequence + Math.ceil(requirements.maxTimeoutSeconds / ledgerSeconds);

    const signed = await StellarSdk.authorizeEntry(
      unsigned,
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

export type Vetted =
  | { ok: true; intent: SignedIntent }
  | { ok: false; error: string; challengeHash?: string; intentHash?: string };

/**
 * The checks every chain makes before anything is signed: steps 3 to 6.
 *
 * 3. The challenge and the x402 requirements describe the same payment, or
 *    the settlement would be for something the merchant never signed.
 * 4. The merchant really signed the challenge.
 * 5. The adapter's own reconstruction of the request agrees with it.
 * 6. The challenge is current, judged the way the account will judge it.
 */
export function vetChallenge(
  challenge: SignedChallenge,
  requirements: PaymentRequirements,
  observedMethod: string,
  observedEndpoint: string,
  observedBody?: string | Buffer | null
): Vetted {
  const disagreement = describeDisagreement(challenge, requirements);
  if (disagreement) {
    return { ok: false, error: `the challenge and the payment requirements disagree on ${disagreement}` };
  }

  if (!verifyMerchantSignature(challenge)) {
    return { ok: false, error: "merchant signature verification failed" };
  }

  const intent = createIntentFromChallenge(challenge, observedMethod, observedEndpoint, observedBody);
  const matchResult = verifyChallengeIntentMatch(challenge, intent);
  if (!matchResult.matches) {
    return {
      ok: false,
      error: `challenge-intent mismatch: ${matchResult.reason}`,
      challengeHash: challenge.hash,
      intentHash: intent.hash,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const expiry = parseInt(challenge.fields.expiry, 10);
  if (!expiry || now > expiry) {
    return { ok: false, error: "challenge has expired" };
  }
  if (expiry - now > MAX_CHALLENGE_LIFETIME) {
    return { ok: false, error: "the challenge stays valid for longer than the account allows" };
  }

  return { ok: true, intent };
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
