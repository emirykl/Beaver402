// Shared field structure for both challenge and intent payloads.
// All security-critical fields that must match between merchant
// challenge and buyer intent for proof of intent verification.
export interface PayloadFields {
  version: string;
  /** Merchant signing key, as a Stellar G address. */
  merchantPubkey: string;
  httpMethod: string;
  normalizedEndpoint: string;
  bodyHash: string;
  /** Where the payment lands, as a 56 character Stellar address. */
  recipient: string;
  /** Token contract address, as a 56 character C address. */
  asset: string;
  /** Stroops, as a decimal string. */
  amount: string;
  /** Network passphrase. The contract compares its sha256 against the
   *  network id reported by the ledger. */
  network: string;
  /** 32 random bytes, hex encoded. */
  nonce: string;
  /** Unix seconds, as a decimal string. */
  expiry: string;
}

// Backward-compatible aliases
export type ChallengeFields = PayloadFields;
export type IntentFields = PayloadFields;

export interface SignedChallenge {
  fields: ChallengeFields;
  hash: string;
  merchantSignature: string;
  merchantPubkey: string;
}

export interface SignedIntent {
  fields: IntentFields;
  hash: string;
}

/**
 * The signature payload the contract expects for the agent path.
 *
 * The challenge and intent hashes are absent on purpose: the contract
 * rebuilds them from these fields rather than trusting hashes handed to it.
 */
export interface PolicySignaturePayload {
  agentSignature: string;
  merchantPubkey: string;
  merchantSignature: string;
  requestDigest: string;
  recipient: string;
  asset: string;
  amount: string;
  nonce: string;
  expiry: string;
}

export interface PaymentRequest {
  amount: string;
  asset: string;
  recipient: string;
  network: string;
}

export interface VelocityConfig {
  maxTxCount: number;
  maxTotalAmount: string;
  windowSize: number;
}
