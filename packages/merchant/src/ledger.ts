import * as StellarSdk from "@stellar/stellar-sdk";

/** The calls this package makes to Soroban RPC. Tests replace them. */
export type Rpc = Pick<
  StellarSdk.rpc.Server,
  "getNetwork" | "getTransaction" | "simulateTransaction" | "getAccount" | "prepareTransaction" | "sendTransaction" | "getAccountEntry" | "getTrustline"
>;

export interface ExpectedTransfer {
  asset: string;
  from: string;
  to: string;
  amount: string;
}

/** A settlement the ledger does not show as agreed. The resource stays locked. */
export class SettlementNotConfirmed extends Error {
  override name = "SettlementNotConfirmed";
}

interface Transfer {
  contract: string;
  from: string;
  to: string;
  amount: bigint;
}

function transfersIn(events: StellarSdk.xdr.ContractEvent[]): Transfer[] {
  const transfers: Transfer[] = [];
  for (const event of events) {
    const id = event.contractId();
    if (!id) continue;
    const body = event.body().v0();
    const topics = body.topics();
    if (topics.length < 3 || topics[0]!.switch().name !== "scvSymbol") continue;
    if (topics[0]!.sym().toString() !== "transfer") continue;
    // The data is the amount, or since muxed transfers a map holding it.
    const data = StellarSdk.scValToNative(body.data());
    const amount = typeof data === "bigint" ? data : BigInt(data?.amount ?? -1);
    transfers.push({
      contract: StellarSdk.Address.fromScAddress(StellarSdk.xdr.ScAddress.scAddressTypeContract(id)).toString(),
      from: String(StellarSdk.scValToNative(topics[1]!)),
      to: String(StellarSdk.scValToNative(topics[2]!)),
      amount,
    });
  }
  return transfers;
}

/**
 * Confirm on the ledger, independently of the facilitator, that the
 * settlement succeeded and moved exactly one transfer of the agreed token,
 * from the payer, to the recipient, of the agreed amount.
 */
export async function confirmSettlement(
  rpc: Pick<Rpc, "getTransaction">,
  txHash: string,
  expected: ExpectedTransfer,
  { attempts = 30, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) {
    throw new SettlementNotConfirmed(`the facilitator returned ${txHash || "nothing"} as the settlement transaction`);
  }
  let result = await rpc.getTransaction(txHash);
  for (let i = 0; result.status === "NOT_FOUND" && i < attempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await rpc.getTransaction(txHash);
  }
  if (result.status !== "SUCCESS") {
    throw new SettlementNotConfirmed(`settlement ${txHash} is ${result.status} on the ledger`);
  }
  const transfers = transfersIn((result.events?.contractEventsXdr ?? []).flat());
  if (transfers.length !== 1) {
    throw new SettlementNotConfirmed(`settlement ${txHash} carries ${transfers.length} transfers, expected exactly one`);
  }
  const [t] = transfers as [Transfer];
  if (t.contract !== expected.asset) throw new SettlementNotConfirmed(`settlement ${txHash} moved ${t.contract}, not ${expected.asset}`);
  if (t.from !== expected.from) throw new SettlementNotConfirmed(`settlement ${txHash} was paid by ${t.from}, not ${expected.from}`);
  if (t.to !== expected.to) throw new SettlementNotConfirmed(`settlement ${txHash} paid ${t.to}, not ${expected.to}`);
  if (t.amount !== BigInt(expected.amount)) throw new SettlementNotConfirmed(`settlement ${txHash} moved ${t.amount}, not ${expected.amount}`);
}

/** The paying account could not answer whether it approved this merchant. */
export class NotAPolicyAccount extends Error {
  override name = "NotAPolicyAccount";
}

/**
 * Ask the payer's policy account whether its owner approved this merchant
 * key. Read only: a simulation, nothing is submitted or paid.
 */
export async function isMerchantApproved(
  rpc: Pick<Rpc, "simulateTransaction">,
  passphrase: string,
  policyAccount: string,
  merchant: StellarSdk.Keypair
): Promise<boolean> {
  const tx = new StellarSdk.TransactionBuilder(new StellarSdk.Account(merchant.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: passphrase,
  })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: policyAccount,
        function: "is_merchant",
        args: [StellarSdk.xdr.ScVal.scvBytes(merchant.rawPublicKey())],
      })
    )
    .setTimeout(30)
    .build();

  const sim = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new NotAPolicyAccount(`${policyAccount} did not answer is_merchant: ${sim.error}`);
  }
  const retval = (sim as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) throw new NotAPolicyAccount(`${policyAccount} returned nothing for is_merchant`);
  const value = StellarSdk.scValToNative(retval);
  if (typeof value !== "boolean") throw new NotAPolicyAccount(`${policyAccount} answered is_merchant with ${String(value)}`);
  return value;
}

/**
 * Publish a payment's proof of intent from the payer's policy account.
 *
 * Anyone may call publish_proof while the account still remembers the
 * payment; the merchant does, and pays the fee from its signing account.
 * Publishing twice is refused by the contract, so retrying after a failure
 * is safe, and it never moves any money.
 */
export async function publishProof(
  rpc: Pick<Rpc, "getAccount" | "prepareTransaction" | "sendTransaction" | "getTransaction">,
  passphrase: string,
  source: StellarSdk.Keypair,
  policyAccount: string,
  nonce: string,
  { attempts = 30, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {}
): Promise<string> {
  if (!/^[0-9a-f]{64}$/i.test(nonce)) throw new Error(`${nonce} is not a 32 byte hex nonce`);
  const account = await rpc.getAccount(source.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, { fee: "1000000", networkPassphrase: passphrase })
    .addOperation(
      StellarSdk.Operation.invokeContractFunction({
        contract: policyAccount,
        function: "publish_proof",
        args: [StellarSdk.xdr.ScVal.scvBytes(Buffer.from(nonce, "hex"))],
      })
    )
    .setTimeout(60)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(source);
  const sent = await rpc.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`publish_proof was rejected: ${sent.errorResult?.result().switch().name ?? "unknown error"}`);
  }
  for (let i = 0; i < attempts; i++) {
    const result = await rpc.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return sent.hash;
    if (result.status === "FAILED") throw new Error(`publish_proof ${sent.hash} failed on the ledger`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`publish_proof ${sent.hash} was not confirmed in time; look it up before retrying`);
}
