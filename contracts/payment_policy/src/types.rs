use soroban_sdk::{contracttype, Address, Bytes, BytesN};

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
/// over the Soroban payload, the merchant signature, and the fields both
/// sides claim to have agreed on.
///
/// The challenge and intent hashes are deliberately absent. The contract
/// derives them from these fields instead of trusting hashes handed to it,
/// which is what makes the merchant signature prove agreement about this
/// exact recipient, asset and amount rather than about an opaque digest.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSignature {
    pub agent_signature: BytesN<64>,
    pub merchant_pubkey: BytesN<32>,
    pub merchant_signature: BytesN<64>,
    /// Hash of the HTTP side of the paid request. The endpoint and the body
    /// stay off the ledger.
    pub request_digest: BytesN<32>,
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
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
