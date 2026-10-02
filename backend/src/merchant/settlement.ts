import * as StellarSdk from "@stellar/stellar-sdk";

import { rpcServer, verifyNetwork } from "../config/network.js";

export interface ExpectedTransfer {
  asset: string;
  from: string;
  to: string;
  amount: string;
}

/** How long to wait for the network to report the settlement. */
const CONFIRMATION_ATTEMPTS = 30;

/** A token transfer as the token contract announced it. */
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
      contract: StellarSdk.Address.fromScAddress(
        StellarSdk.xdr.ScAddress.scAddressTypeContract(id)
      ).toString(),
      from: String(StellarSdk.scValToNative(topics[1]!)),
      to: String(StellarSdk.scValToNative(topics[2]!)),
      amount,
    });
  }
  return transfers;
}

/**
 * Confirm on the ledger, independently of the facilitator, that a settlement
 * moved exactly what was agreed.
 *
 * The facilitator says it settled. The merchant releases the resource only
 * once the network itself shows a successful transaction with one transfer
 * of the agreed token, from the payer, to the merchant's recipient, of the
 * agreed amount.
 */
export async function confirmSettlement(
  txHash: string,
  expected: ExpectedTransfer,
  server: Pick<StellarSdk.rpc.Server, "getTransaction"> = rpcServer(),
  checkNetwork: () => Promise<void> = verifyNetwork
): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) {
    throw new Error(`the facilitator returned ${txHash || "nothing"} as the settlement transaction`);
  }
  await checkNetwork();

  let result = await server.getTransaction(txHash);
  for (let attempt = 0; result.status === "NOT_FOUND" && attempt < CONFIRMATION_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await server.getTransaction(txHash);
  }

  if (result.status !== "SUCCESS") {
    throw new Error(`settlement ${txHash} is ${result.status} on the ledger`);
  }

  const events = (result.events?.contractEventsXdr ?? []).flat();
  const transfers = transfersIn(events);
  if (transfers.length !== 1) {
    throw new Error(`settlement ${txHash} carries ${transfers.length} transfers, expected exactly one`);
  }

  const [transfer] = transfers;
  if (transfer!.contract !== expected.asset) {
    throw new Error(`settlement ${txHash} moved ${transfer!.contract}, not ${expected.asset}`);
  }
  if (transfer!.from !== expected.from) {
    throw new Error(`settlement ${txHash} was paid by ${transfer!.from}, not ${expected.from}`);
  }
  if (transfer!.to !== expected.to) {
    throw new Error(`settlement ${txHash} paid ${transfer!.to}, not ${expected.to}`);
  }
  if (transfer!.amount !== BigInt(expected.amount)) {
    throw new Error(`settlement ${txHash} moved ${transfer!.amount}, not ${expected.amount}`);
  }
}
