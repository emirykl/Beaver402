export interface ChallengeFields {
  version: string;
  domainSeparator: string;
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

export interface IntentFields {
  version: string;
  domainSeparator: string;
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
