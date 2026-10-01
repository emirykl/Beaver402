use soroban_sdk::{contracttype, Address, Bytes, BytesN};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Owner,
    /// sha256 of the WebAuthn relying party id the owner passkey was
    /// registered under, which is the domain the control panel is served on.
    RpIdHash,
    AgentSigner,
    Frozen,
    /// The one token this account pays in.
    Asset,
    /// Where the owner can send the remaining balance in an emergency.
    Recovery,
    VelocityConfig,
    /// The recent payments, one fixed slot each. See velocity.rs.
    Payments,
    Merchant(BytesN<32>),
}

/// The spending limits. They can only ever be lowered once the account
/// exists.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VelocityConfig {
    /// The most a single payment may move.
    pub max_payment_amount: i128,
    /// How many payments may fall inside one window.
    pub max_tx_count: u32,
    /// How much all payments inside one window may add up to.
    pub max_total_amount: i128,
    /// The length of the window in seconds. It slides: every payment counts
    /// for exactly this long after it was made.
    pub window_size: u64,
}

/// What the velocity window looks like at a given moment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VelocityState {
    pub tx_count: u32,
    pub total_amount: i128,
    /// When the oldest payment still counted was made, or zero if none is.
    /// That payment stops counting at window_start + window_size.
    pub window_start: u64,
}

/// One payment as the account remembers it.
///
/// While the payment counts toward the velocity window, its nonce refuses a
/// replay of the same challenge and its hashes wait for publish_proof. The
/// account cannot announce the proof while it authorizes the payment,
/// because an x402 facilitator refuses a settlement that emits any event
/// other than the token transfer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentRecord {
    pub timestamp: u64,
    /// Zero marks an empty slot.
    pub amount: i128,
    pub nonce: BytesN<32>,
    pub challenge_hash: BytesN<32>,
    pub intent_hash: BytesN<32>,
    pub merchant_pubkey: BytesN<32>,
    /// This payment reached a velocity limit and froze the account.
    pub froze_account: bool,
    /// Its proof of intent has been announced.
    pub published: bool,
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
///
/// The agent variant is much larger than the owner one. Boxing it is not an
/// option without an allocator, and the value only ever lives for one call.
#[allow(clippy::large_enum_variant)]
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicySignature {
    Agent(AgentSignature),
    Owner(PasskeySignature),
}
