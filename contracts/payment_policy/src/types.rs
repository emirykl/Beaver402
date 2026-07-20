use soroban_sdk::{contracttype, Address, BytesN};

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

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicySignature {
    pub agent_signature: BytesN<64>,
    pub merchant_pubkey: BytesN<32>,
    pub merchant_signature: BytesN<64>,
    pub challenge_hash: BytesN<32>,
    pub intent_hash: BytesN<32>,
    pub nonce: BytesN<32>,
    pub expiry: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentParams {
    pub recipient: Address,
    pub asset: Address,
    pub amount: i128,
}
