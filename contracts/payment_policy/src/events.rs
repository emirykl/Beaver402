//! Everything the account announces.
//!
//! Events carry hashes, public keys and amounts, never request content. None
//! of them is emitted while a payment is being authorized: an x402
//! facilitator refuses a settlement whose simulation shows any event besides
//! the token transfer, so the proof of intent for a payment is announced by
//! publish_proof in a later transaction.

use soroban_sdk::{contractevent, Address, BytesN, Symbol};

/// Both parties agreed on this payment and the account authorized it.
#[contractevent(topics = ["poi", "verified"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProofOfIntent {
    #[topic]
    pub nonce: BytesN<32>,
    pub challenge_hash: BytesN<32>,
    pub intent_hash: BytesN<32>,
    pub merchant_pubkey: BytesN<32>,
    pub amount: i128,
}

/// Payments stopped, either because the owner said so (`manual`) or because
/// a payment reached a velocity limit (`velocity`).
#[contractevent(topics = ["frozen"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentsFrozen {
    #[topic]
    pub reason: Symbol,
    pub tx_count: u32,
    pub total_amount: i128,
}

#[contractevent(topics = ["frozen", "restored"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentsRestored {
    pub tx_count: u32,
    pub total_amount: i128,
}

#[contractevent(topics = ["signer", "revoked"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerRevoked {
    pub pubkey: BytesN<32>,
}

#[contractevent(topics = ["signer", "set"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerSet {
    pub pubkey: BytesN<32>,
}

#[contractevent(topics = ["merchant", "added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerchantAdded {
    pub pubkey: BytesN<32>,
}

#[contractevent(topics = ["merchant", "removed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MerchantRemoved {
    pub pubkey: BytesN<32>,
}

#[contractevent(topics = ["limits", "reduced"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LimitsReduced {
    pub max_payment_amount: i128,
    pub max_tx_count: u32,
    pub max_total_amount: i128,
    pub window_size: u64,
}

#[contractevent(topics = ["funds", "recovered"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundsRecovered {
    #[topic]
    pub token: Address,
    pub recovery: Address,
    pub amount: i128,
}
