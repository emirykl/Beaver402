// Shared field structure for both challenge and intent payloads.
// All security-critical fields that must match between merchant
// challenge and buyer intent for proof of intent verification.
export interface PayloadFields {
  version: string;
  merchantPubkey: string;
  httpMethod: string;
  normalizedEndpoint: string;
  bodyHash: string;
  recipient: string;
  asset: string;
  amount: string;
  network: string;
  nonce: string;
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

export interface PolicySignaturePayload {
  agentSignature: string;
  merchantPubkey: string;
  merchantSignature: string;
  challengeHash: string;
  intentHash: string;
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
