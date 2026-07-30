import {
  TransactionBuilder,
  Networks,
  Operation,
  Account,
} from "@stellar/stellar-sdk";

const NETWORK_PASSPHRASE = Networks.TESTNET;
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const BASE_FEE = "10000000"; // 1 XLM max fee for Soroban contract calls

export interface PasskeyTxOptions {
  sourceAccount: string;
  contractId: string;
}

export async function buildFreezeTx(options: PasskeyTxOptions): Promise<string> {
  const account = await fetchAccount(options.sourceAccount);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: options.contractId,
        function: "freeze_payments",
        args: [],
      })
    )
    .setTimeout(300)
    .build();

  return tx.toXDR();
}

export async function buildRestoreTx(options: PasskeyTxOptions): Promise<string> {
  const account = await fetchAccount(options.sourceAccount);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: options.contractId,
        function: "restore_payments",
        args: [],
      })
    )
    .setTimeout(300)
    .build();

  return tx.toXDR();
}

export async function buildRevokeTx(options: PasskeyTxOptions): Promise<string> {
  const account = await fetchAccount(options.sourceAccount);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: options.contractId,
        function: "revoke_agent_signer",
        args: [],
      })
    )
    .setTimeout(300)
    .build();

  return tx.toXDR();
}

export async function submitSignedTx(signedXdr: string): Promise<string> {
  const response = await fetch(`${HORIZON_URL}/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `tx=${encodeURIComponent(signedXdr)}`,
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`transaction failed: ${JSON.stringify(result)}`);
  }

  return result.hash;
}

async function fetchAccount(publicKey: string): Promise<Account> {
  const response = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
  if (!response.ok) {
    throw new Error(`failed to fetch account ${publicKey}`);
  }
  const data = await response.json();
  return new Account(publicKey, data.sequence);
}
