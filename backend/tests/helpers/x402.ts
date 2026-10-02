import * as StellarSdk from "@stellar/stellar-sdk";

import { createSignedChallenge } from "../../src/merchant/challenge-signer.js";
import { buildAgentSignatureScVal } from "../../src/adapter/policy-signature.js";
import { requestDigest } from "../../src/shared/hashing.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "../../src/x402/protocol.js";
import type { SignedChallenge } from "../../src/shared/types.js";

export const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const TESTNET = StellarSdk.Networks.TESTNET;
export const POLICY = "CCYRWISLRHOL37FXT4FBOJBWTBIZCU2V3ST3TVNR25VQOFDZC7YE4Z2N";

export interface Terms {
  merchant: StellarSdk.Keypair;
  recipient: string;
  method?: string;
  endpoint: string;
  body?: string;
  amount?: string;
  asset?: string;
  network?: string;
  expirySeconds?: number;
}

export function requirementsFor(terms: Terms): PaymentRequirements {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset: terms.asset ?? USDC,
    amount: terms.amount ?? "1000000",
    payTo: terms.recipient,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

export function signedChallenge(terms: Terms): SignedChallenge {
  return createSignedChallenge({
    merchantKeypair: terms.merchant,
    httpMethod: terms.method ?? "GET",
    endpoint: terms.endpoint,
    body: terms.body,
    recipient: terms.recipient,
    asset: terms.asset ?? USDC,
    amount: terms.amount ?? "1000000",
    network: terms.network ?? TESTNET,
    expirySeconds: terms.expirySeconds,
  });
}

/** A 402 answer as a Beaver402 merchant gives it. */
export function paymentRequired(terms: Terms, challenge = signedChallenge(terms)): PaymentRequired {
  return {
    x402Version: 2,
    error: "Payment Required",
    resource: { url: terms.endpoint },
    accepts: [requirementsFor(terms)],
    extensions: { beaver402: { challenge } },
  };
}

/**
 * An x402 exact payment answering a challenge, built without a ledger.
 *
 * The agent signature is not a real one. Nothing in the merchant checks it;
 * the contract does, inside the facilitator's simulation.
 */
export function paymentFor(
  challenge: SignedChallenge,
  requirements: PaymentRequirements,
  payer = POLICY
): PaymentPayload {
  const entry = new StellarSdk.xdr.SorobanAuthorizationEntry({
    credentials: StellarSdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
      new StellarSdk.xdr.SorobanAddressCredentials({
        address: StellarSdk.Address.fromString(payer).toScAddress(),
        nonce: new StellarSdk.xdr.Int64(1),
        signatureExpirationLedger: 100,
        signature: buildAgentSignatureScVal({
          agentSignature: Buffer.alloc(64, 7).toString("base64"),
          merchantPubkey: challenge.merchantPubkey,
          merchantSignature: challenge.merchantSignature,
          requestDigest: requestDigest(challenge.fields).toString("hex"),
          recipient: challenge.fields.recipient,
          asset: challenge.fields.asset,
          amount: challenge.fields.amount,
          nonce: challenge.fields.nonce,
          expiry: challenge.fields.expiry,
        }),
      })
    ),
    rootInvocation: new StellarSdk.xdr.SorobanAuthorizedInvocation({
      function: StellarSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new StellarSdk.xdr.InvokeContractArgs({
          contractAddress: StellarSdk.Address.fromString(requirements.asset).toScAddress(),
          functionName: "transfer",
          args: [
            StellarSdk.Address.fromString(payer).toScVal(),
            StellarSdk.Address.fromString(requirements.payTo).toScVal(),
            StellarSdk.nativeToScVal(BigInt(requirements.amount), { type: "i128" }),
          ],
        })
      ),
      subInvocations: [],
    }),
  });

  const transaction = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: TESTNET }
  )
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: requirements.asset,
        function: "transfer",
        args: [
          StellarSdk.Address.fromString(payer).toScVal(),
          StellarSdk.Address.fromString(requirements.payTo).toScVal(),
          StellarSdk.nativeToScVal(BigInt(requirements.amount), { type: "i128" }),
        ],
        auth: [entry],
      })
    )
    .setTimeout(60)
    .build();

  return { x402Version: 2, accepted: requirements, payload: { transaction: transaction.toXDR() } };
}
