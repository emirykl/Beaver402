/** Read-only devnet simulation of the P-256 instruction used for owner actions. */
import { createSign, generateKeyPairSync } from "node:crypto";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";

import { derToRawSignature } from "../src/passkey/owner-signature.js";
import { solana, solanaRpc, verifySolanaNetwork } from "../src/chains/solana/config.js";
import { computeUnitLimit, secp256r1Instruction, solanaKeyPair } from "../src/chains/solana/program.js";

async function main() {
  const feeSecret = process.env.MERCHANT_SECRET;
  if (!feeSecret) throw new Error("MERCHANT_SECRET is required for the simulation fee payer");
  const config = solana();
  const rpc = solanaRpc(config);
  await verifySolanaNetwork(config, rpc);

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const point = publicKey.export({ format: "jwk" });
  const x = Buffer.from(point.x!, "base64url");
  const y = Buffer.from(point.y!, "base64url");
  const compressed = Buffer.concat([Buffer.from([2 + (y[31]! & 1)]), x]);
  const message = Buffer.from("Beaver402 Solana P-256 precompile smoke test");
  const der = createSign("sha256").update(message).sign(privateKey);
  const signature = derToRawSignature(der);

  const fee = await solanaKeyPair(feeSecret);
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(fee.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([computeUnitLimit(40_000), secp256r1Instruction(compressed, signature, message)], m)
  );
  const signed = await signTransaction([fee.keyPair], compileTransaction(transactionMessage));
  const wire = getBase64EncodedWireTransaction(signed);
  const result = await rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: false, commitment: "confirmed" }).send();
  console.log(JSON.stringify({ err: result.value.err, logs: result.value.logs }, null, 2));
  if (result.value.err) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
