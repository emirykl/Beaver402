/**
 * The policy program's instructions, built by hand.
 *
 * The program is small and its interface is fixed, so the account lists and
 * the argument encodings are written out here rather than generated. The
 * order of accounts is the order of the Accounts structs in
 * solana/programs/beaver402_policy/src/lib.rs, and the discriminators are
 * Anchor's: the first eight bytes of sha256("global:<name>").
 */
import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  createKeyPairFromPrivateKeyBytes,
  getAddressDecoder,
  getAddressEncoder,
  getAddressFromPublicKey,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import * as StellarSdk from "@stellar/stellar-sdk";

import { limitsBytes, type SolanaLimits } from "./encoding.js";

export const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
export const ED25519_PROGRAM = address("Ed25519SigVerify111111111111111111111111111");
export const SECP256R1_PROGRAM = address("Secp256r1SigVerify1111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");
export const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

export const POLICY_SEED = "policy";

export function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/** The policy account for a policy id. */
export async function policyAddress(programId: Address, policyId: Buffer): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [Buffer.from(POLICY_SEED), policyId],
  });
  return pda;
}

export async function associatedToken(owner: Address, mint: Address): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

const addressEncoder = getAddressEncoder();

export function addressToBytes(value: Address): Buffer {
  return Buffer.from(addressEncoder.encode(value));
}

export function addressFromRaw(raw: Uint8Array): Address {
  return getAddressDecoder().decode(raw);
}

/**
 * The same ed25519 identity on both chains.
 *
 * Beaver402 keys are kept as Stellar secrets. The 32 byte seed inside one is
 * an ordinary ed25519 key, so the agent, the merchant and the fee account
 * each have one identity that shows up as a G address on Stellar and a
 * base58 address on Solana. A Solana transaction message is never 32 bytes
 * long and a Stellar authorization payload always is, so a signature made
 * on one chain can never be read as one for the other.
 */
export async function solanaKeyPair(stellarSecret: string): Promise<{ keyPair: CryptoKeyPair; address: Address }> {
  const seed = StellarSdk.Keypair.fromSecret(stellarSecret).rawSecretKey();
  const keyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(seed), true);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

/** The Solana address for a Stellar public key, the same 32 bytes. */
export function solanaAddressOf(stellarPublicKey: string): Address {
  return addressFromRaw(StellarSdk.StrKey.decodeEd25519PublicKey(stellarPublicKey));
}

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function bytesVec(value: Buffer): Buffer {
  return Buffer.concat([u32le(value.length), value]);
}

// ── The precompiles ────────────────────────────────────────────────

/**
 * One signature, with its key, signature and message all inside the same
 * instruction, which is the only layout the program accepts.
 */
function precompileInstruction(
  programAddress: Address,
  publicKey: Buffer,
  signature: Buffer,
  message: Buffer
): Instruction {
  const THIS = 0xffff;
  const dataStart = 2 + 14;
  const publicKeyOffset = dataStart;
  const signatureOffset = publicKeyOffset + publicKey.length;
  const messageOffset = signatureOffset + signature.length;
  const offsets = Buffer.alloc(14);
  offsets.writeUInt16LE(signatureOffset, 0);
  offsets.writeUInt16LE(THIS, 2);
  offsets.writeUInt16LE(publicKeyOffset, 4);
  offsets.writeUInt16LE(THIS, 6);
  offsets.writeUInt16LE(messageOffset, 8);
  offsets.writeUInt16LE(message.length, 10);
  offsets.writeUInt16LE(THIS, 12);
  return {
    programAddress,
    accounts: [],
    data: Buffer.concat([Buffer.from([1, 0]), offsets, publicKey, signature, message]),
  };
}

/** The merchant's signature over a challenge hash. */
export function ed25519Instruction(publicKey: Buffer, signature: Buffer, message: Buffer): Instruction {
  if (publicKey.length !== 32 || signature.length !== 64) {
    throw new Error("an ed25519 instruction needs a 32 byte key and a 64 byte signature");
  }
  return precompileInstruction(ED25519_PROGRAM, publicKey, signature, message);
}

/** The owner passkey's signature over authenticatorData ‖ sha256(clientDataJSON). */
export function secp256r1Instruction(compressedKey: Buffer, signature: Buffer, message: Buffer): Instruction {
  if (compressedKey.length !== 33 || signature.length !== 64) {
    throw new Error("a secp256r1 instruction needs a 33 byte key and a 64 byte signature");
  }
  return precompileInstruction(SECP256R1_PROGRAM, compressedKey, signature, message);
}

// ── The program's instructions ─────────────────────────────────────

export interface PayArgs {
  merchantPubkey: Buffer;
  requestDigest: Buffer;
  amount: bigint;
  nonce: Buffer;
  expiry: bigint;
}

export function encodePayArgs(args: PayArgs): Buffer {
  return Buffer.concat([discriminator("pay"), args.merchantPubkey, args.requestDigest, u64le(args.amount), args.nonce, u64le(args.expiry)]);
}

/** Read the arguments back out of a pay instruction's data. */
export function decodePayArgs(data: Uint8Array): PayArgs | null {
  const buf = Buffer.from(data);
  if (buf.length !== 8 + 32 + 32 + 8 + 32 + 8 || !buf.subarray(0, 8).equals(discriminator("pay"))) {
    return null;
  }
  return {
    merchantPubkey: buf.subarray(8, 40),
    requestDigest: buf.subarray(40, 72),
    amount: buf.readBigUInt64LE(72),
    nonce: buf.subarray(80, 112),
    expiry: buf.readBigUInt64LE(112),
  };
}

export interface PayAccounts {
  agent: Address;
  policy: Address;
  mint: Address;
  vault: Address;
  recipient: Address;
  recipientToken: Address;
}

export function payInstruction(programId: Address, accounts: PayAccounts, args: PayArgs): Instruction {
  return {
    programAddress: programId,
    accounts: [
      { address: accounts.agent, role: AccountRole.READONLY_SIGNER },
      { address: accounts.policy, role: AccountRole.WRITABLE },
      { address: accounts.mint, role: AccountRole.READONLY },
      { address: accounts.vault, role: AccountRole.WRITABLE },
      { address: accounts.recipient, role: AccountRole.READONLY },
      { address: accounts.recipientToken, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
    ],
    data: encodePayArgs(args),
  };
}

/** The owner actions the control panel can invoke, as on Stellar. */
export const SOLANA_OWNER_ACTIONS = [
  "freeze_payments",
  "restore_payments",
  "revoke_agent_signer",
  "set_agent_signer",
  "add_merchant",
  "remove_merchant",
  "reduce_limits",
  "recover_funds",
] as const;

export type SolanaOwnerAction = (typeof SOLANA_OWNER_ACTIONS)[number];

export interface OwnerActionInput {
  pubkey?: Address;
  limits?: SolanaLimits;
}

/** The bytes an action's arguments contribute to its passkey challenge. */
export function ownerActionArgs(action: SolanaOwnerAction, input: OwnerActionInput): Buffer {
  switch (action) {
    case "set_agent_signer":
    case "add_merchant":
    case "remove_merchant":
      if (!input.pubkey) throw new Error(`${action} needs a public key`);
      return addressToBytes(input.pubkey);
    case "reduce_limits":
      if (!input.limits) throw new Error("reduce_limits needs the new limits");
      return limitsBytes(input.limits);
    default:
      return Buffer.alloc(0);
  }
}

/** The arguments as the instruction carries them, in Borsh. */
function ownerInstructionData(
  action: SolanaOwnerAction,
  input: OwnerActionInput,
  clientDataJSON: Buffer,
  validUntil: bigint
): Buffer {
  const proof = Buffer.concat([bytesVec(clientDataJSON), u64le(validUntil)]);
  let args: Buffer = Buffer.alloc(0);
  if (action === "set_agent_signer" || action === "add_merchant" || action === "remove_merchant") {
    args = addressToBytes(input.pubkey!);
  } else if (action === "reduce_limits") {
    const l = input.limits!;
    // VelocityConfig in Borsh: max_payment_amount u64, max_tx_count u32,
    // max_total_amount u64, window_size u64, all little endian.
    args = Buffer.concat([
      u64le(BigInt(l.maxPaymentAmount)),
      u32le(l.maxTxCount),
      u64le(BigInt(l.maxTotalAmount)),
      u64le(BigInt(l.windowSize)),
    ]);
  }
  return Buffer.concat([discriminator(action), args, proof]);
}

export interface RecoverAccounts {
  mint: Address;
  vault: Address;
  recovery: Address;
  recoveryToken: Address;
}

export function ownerInstruction(
  programId: Address,
  policy: Address,
  action: SolanaOwnerAction,
  input: OwnerActionInput,
  clientDataJSON: Buffer,
  validUntil: bigint,
  recover?: RecoverAccounts
): Instruction {
  const data = ownerInstructionData(action, input, clientDataJSON, validUntil);
  if (action === "recover_funds") {
    if (!recover) throw new Error("recover_funds needs the token accounts");
    return {
      programAddress: programId,
      accounts: [
        { address: policy, role: AccountRole.WRITABLE },
        { address: recover.mint, role: AccountRole.READONLY },
        { address: recover.vault, role: AccountRole.WRITABLE },
        { address: recover.recovery, role: AccountRole.READONLY },
        { address: recover.recoveryToken, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      ],
      data,
    };
  }
  return {
    programAddress: programId,
    accounts: [
      { address: policy, role: AccountRole.WRITABLE },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
    ],
    data,
  };
}

export interface InitializeArgs {
  policyId: Buffer;
  owner: Buffer;
  rpIdHash: Buffer;
  networkId: Buffer;
  agentSigner: Address;
  recovery: Address;
  limits: SolanaLimits;
}

export function initializeInstruction(
  programId: Address,
  accounts: { payer: Address; policy: Address; mint: Address; vault: Address },
  args: InitializeArgs
): Instruction {
  const l = args.limits;
  const data = Buffer.concat([
    discriminator("initialize"),
    args.policyId,
    args.owner,
    args.rpIdHash,
    args.networkId,
    addressToBytes(args.agentSigner),
    addressToBytes(args.recovery),
    u64le(BigInt(l.maxPaymentAmount)),
    u32le(l.maxTxCount),
    u64le(BigInt(l.maxTotalAmount)),
    u64le(BigInt(l.windowSize)),
  ]);
  return {
    programAddress: programId,
    accounts: [
      { address: accounts.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: accounts.policy, role: AccountRole.WRITABLE },
      { address: accounts.mint, role: AccountRole.READONLY },
      { address: accounts.vault, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: ASSOCIATED_TOKEN_PROGRAM, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data,
  };
}

/** SetComputeUnitLimit. A payment uses about 26k units, an owner action 11k. */
export function computeUnitLimit(units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: Buffer.concat([Buffer.from([2]), u32le(units)]),
  };
}

/**
 * A secp256r1 public key in the compressed form the precompile takes. The
 * contract on Stellar and the passkey registration hold the uncompressed
 * point.
 */
export function compressP256(uncompressed: Buffer): Buffer {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error("expected an uncompressed P-256 point");
  }
  const x = uncompressed.subarray(1, 33);
  const yIsOdd = (uncompressed[64]! & 1) === 1;
  return Buffer.concat([Buffer.from([yIsOdd ? 0x03 : 0x02]), x]);
}
