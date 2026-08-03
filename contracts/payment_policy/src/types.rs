use soroban_sdk::{contracttype, Bytes, BytesN};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Owner,
    AgentSigner,
    Frozen,
    VelocityConfig,
    VelocityState,
    Merchant(BytesN<32>),
    Nonce(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VelocityConfig {
    pub max_tx_count: u32,
    pub max_total_amount: i128,
    pub window_size: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VelocityState {
    pub tx_count: u32,
    pub total_amount: i128,
    pub window_start: u64,
}

/// What the delegated agent presents to settle a payment: its own signature
/// over the Soroban payload, plus the merchant side of the proof of intent.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSignature {
    pub agent_signature: BytesN<64>,
    pub merchant_pubkey: BytesN<32>,
    pub merchant_signature: BytesN<64>,
    pub challenge_hash: BytesN<32>,
    pub intent_hash: BytesN<32>,
    pub nonce: BytesN<32>,
    pub expiry: u64,
}

/// A WebAuthn assertion from the owner's passkey. The raw authenticator
/// fields travel to the contract because the signature covers them, and the
/// challenge the authenticator echoes back is what ties the assertion to a
/// single Soroban authorization.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PasskeySignature {
    pub authenticator_data: Bytes,
    pub client_data_json: Bytes,
    pub signature: BytesN<64>,
}

/// The account answers to two different parties, so it accepts two different
/// kinds of proof. Which one applies is decided by what is being authorized,
/// never by which one the caller happens to supply.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicySignature {
    Agent(AgentSignature),
    Owner(PasskeySignature),
}
