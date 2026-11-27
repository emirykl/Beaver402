import * as StellarSdk from "@stellar/stellar-sdk";
import express from "express";
import type { AddressInfo } from "node:net";

import { captureRawBody, createMerchant, type Merchant, type MerchantDeps } from "../../src/merchant.js";
import { usdcContract, type MerchantOptions } from "../../src/config.js";
import { requestDigest, type SignedChallenge } from "../../src/encoding.js";
import type { Facilitator } from "../../src/facilitator.js";
import type { Rpc } from "../../src/ledger.js";
import { memoryStore } from "../../src/store.js";
import type { PaymentPayload, PaymentRequirements } from "../../src/protocol.js";

const { xdr } = StellarSdk;

export const USDC = usdcContract("testnet");
export const TESTNET = StellarSdk.Networks.TESTNET;
export const POLICY = "CCYRWISLRHOL37FXT4FBOJBWTBIZCU2V3ST3TVNR25VQOFDZC7YE4Z2N";
export const SETTLEMENT = "ef".repeat(32);
export const PROOF = "12".repeat(32);

export const MERCHANT = StellarSdk.Keypair.random();
export const RECIPIENT = StellarSdk.Keypair.random().publicKey();

export function options(overrides: Partial<MerchantOptions> = {}): MerchantOptions {
  return {
    network: "testnet",
    usdcContract: USDC,
    facilitatorApiKey: "test-key",
    merchantSecret: MERCHANT.secret(),
    recipient: RECIPIENT,
    price: "1000000",
    store: memoryStore(),
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

export function transferEvent(from: string, to: string, amount: bigint, contract = USDC): StellarSdk.xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: StellarSdk.Address.fromString(contract).toScAddress().contractId(),
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(
      0,
      new xdr.ContractEventV0({
        topics: [
          xdr.ScVal.scvSymbol("transfer"),
          StellarSdk.Address.fromString(from).toScVal(),
          StellarSdk.Address.fromString(to).toScVal(),
          StellarSdk.nativeToScVal("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
        ],
        data: StellarSdk.nativeToScVal(amount, { type: "i128" }),
      })
    ),
  });
}

export interface FakeLedger {
  approved: boolean;
  /** What getTransaction reports for the settlement. */
  settlement: { status: string; events: StellarSdk.xdr.ContractEvent[] };
  proofFails: boolean;
  simulationError?: string;
  calls: { simulate: number; send: number };
}

/** A ledger that settles and approves, unless told otherwise. */
export function fakeLedger(overrides: Partial<FakeLedger> = {}): FakeLedger & { rpc: Rpc } {
  const state: FakeLedger = {
    approved: true,
    settlement: { status: "SUCCESS", events: [transferEvent(POLICY, RECIPIENT, 1_000_000n)] },
    proofFails: false,
    calls: { simulate: 0, send: 0 },
    ...overrides,
  };
  const rpc = {
    async getNetwork() {
      return { passphrase: TESTNET } as never;
    },
    async simulateTransaction() {
      state.calls.simulate++;
      if (state.simulationError) return { error: state.simulationError, events: [], latestLedger: 1, id: "1" } as never;
      return { result: { retval: xdr.ScVal.scvBool(state.approved), auth: [] }, latestLedger: 1, events: [], id: "1", _parsed: true } as never;
    },
    async getTransaction(hash: string) {
      if (hash === PROOF) return { status: "SUCCESS" } as never;
      return { status: state.settlement.status, events: { contractEventsXdr: [state.settlement.events], transactionEventsXdr: [] } } as never;
    },
    async getAccount(id: string) {
      return new StellarSdk.Account(id, "1");
    },
    async prepareTransaction(tx: StellarSdk.Transaction) {
      return tx;
    },
    async sendTransaction() {
      state.calls.send++;
      if (state.proofFails) throw new Error("rpc unavailable");
      return { status: "PENDING", hash: PROOF } as never;
    },
    async getAccountEntry() {
      return { balance: () => new xdr.Int64(100_000_000n) } as never;
    },
    async getTrustline() {
      return { flags: () => 1 } as never;
    },
  } as unknown as Rpc;
  return Object.assign(state, { rpc });
}

export function fakeFacilitator(overrides: Partial<Facilitator> = {}) {
  const calls = { verify: 0, settle: 0 };
  const facilitator: Facilitator = {
    async verify() {
      calls.verify++;
      return { isValid: true };
    },
    async settle() {
      calls.settle++;
      return { success: true, transaction: SETTLEMENT, network: "stellar:testnet", payer: POLICY } as never;
    },
    async supports() {
      return true;
    },
    ...overrides,
  };
  return { facilitator, calls };
}

/** The demo routes a merchant would mount, served on a random port. */
export async function serve(merchant: Merchant) {
  const app = express();
  app.use(express.json({ verify: captureRawBody }));
  app.get("/data", merchant.protect(), (_req, res) => res.json({ data: "paid content", payment: res.locals.beaver402?.payment?.txHash }));
  app.post("/submit", merchant.protect({ price: "2000000" }), (req, res) => res.json({ accepted: req.body }));
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

export function build(opts: Partial<MerchantOptions> = {}, deps: Partial<MerchantDeps> = {}, ledger = fakeLedger(), fac = fakeFacilitator()) {
  const merchant = createMerchant(options(opts), {
    rpc: ledger.rpc,
    facilitator: fac.facilitator,
    confirmation: { attempts: 1, delayMs: 1 },
    ...deps,
  });
  return { merchant, ledger, facilitator: fac };
}

/** The agent's half: the Beaver402 agent signature value the policy account expects. */
function agentSignature(challenge: SignedChallenge): StellarSdk.xdr.ScVal {
  const raw = (v: string, enc: BufferEncoding) => xdr.ScVal.scvBytes(Buffer.from(v, enc));
  const fields: Record<string, StellarSdk.xdr.ScVal> = {
    agent_signature: xdr.ScVal.scvBytes(Buffer.alloc(64, 7)),
    amount: StellarSdk.nativeToScVal(BigInt(challenge.fields.amount), { type: "i128" }),
    asset: new StellarSdk.Address(challenge.fields.asset).toScVal(),
    expiry: xdr.ScVal.scvU64(new xdr.Uint64(BigInt(challenge.fields.expiry))),
    merchant_pubkey: xdr.ScVal.scvBytes(Buffer.from(StellarSdk.StrKey.decodeEd25519PublicKey(challenge.merchantPubkey))),
    merchant_signature: raw(challenge.merchantSignature, "base64"),
    nonce: raw(challenge.fields.nonce, "hex"),
    recipient: new StellarSdk.Address(challenge.fields.recipient).toScVal(),
    request_digest: xdr.ScVal.scvBytes(requestDigest(challenge.fields)),
  };
  const entries = Object.keys(fields)
    .sort()
    .map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: fields[key]! }));
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Agent"), xdr.ScVal.scvMap(entries)]);
}

/**
 * An x402 exact payment answering a challenge, built without a ledger. The
 * agent signature is a placeholder: the contract checks it inside the
 * facilitator's simulation, the merchant does not.
 */
export function paymentFor(challenge: SignedChallenge, requirements: PaymentRequirements, payer = POLICY): PaymentPayload {
  const args = [
    StellarSdk.Address.fromString(payer).toScVal(),
    StellarSdk.Address.fromString(requirements.payTo).toScVal(),
    StellarSdk.nativeToScVal(BigInt(requirements.amount), { type: "i128" }),
  ];
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: StellarSdk.Address.fromString(payer).toScAddress(),
        nonce: new xdr.Int64(1),
        signatureExpirationLedger: 100,
        signature: agentSignature(challenge),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: StellarSdk.Address.fromString(requirements.asset).toScAddress(),
          functionName: "transfer",
          args,
        })
      ),
      subInvocations: [],
    }),
  });
  const transaction = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: TESTNET }
  )
    .addOperation(StellarSdk.Operation.invokeContractFunction({ contract: requirements.asset, function: "transfer", args, auth: [entry] }))
    .setTimeout(60)
    .build();
  return { x402Version: 2, accepted: requirements, payload: { transaction: transaction.toXDR() } } as PaymentPayload;
}
