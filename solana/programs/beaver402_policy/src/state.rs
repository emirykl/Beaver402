use anchor_lang::prelude::*;

use crate::constants::{MAX_MERCHANTS, MAX_TRACKED_PAYMENTS};

/// The spending limits, as instructions carry them. They can only ever be
/// lowered once the account exists. Amounts are in the mint's smallest unit.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VelocityConfig {
    /// The most a single payment may move.
    pub max_payment_amount: u64,
    /// How many payments may fall inside one window.
    pub max_tx_count: u32,
    /// How much all payments inside one window may add up to.
    pub max_total_amount: u64,
    /// The length of the window in seconds. It slides: every payment counts
    /// for exactly this long after it was made.
    pub window_size: u64,
}

/// The same limits as the account stores them. The account is read in place
/// rather than copied, because at nearly three kilobytes a copy does not fit
/// the program's stack, so every stored type is plain bytes with no padding.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StoredLimits {
    pub max_payment_amount: u64,
    pub max_total_amount: u64,
    pub window_size: u64,
    pub max_tx_count: u32,
    pub _padding: [u8; 4],
}

impl From<VelocityConfig> for StoredLimits {
    fn from(c: VelocityConfig) -> Self {
        Self {
            max_payment_amount: c.max_payment_amount,
            max_total_amount: c.max_total_amount,
            window_size: c.window_size,
            max_tx_count: c.max_tx_count,
            _padding: [0; 4],
        }
    }
}

impl From<StoredLimits> for VelocityConfig {
    fn from(s: StoredLimits) -> Self {
        Self {
            max_payment_amount: s.max_payment_amount,
            max_tx_count: s.max_tx_count,
            max_total_amount: s.max_total_amount,
            window_size: s.window_size,
        }
    }
}

/// One payment as the account remembers it. While it counts toward the
/// velocity window its nonce refuses a replay of the same challenge.
#[zero_copy]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PaymentRecord {
    pub timestamp: u64,
    /// Zero marks an empty slot.
    pub amount: u64,
    pub nonce: [u8; 32],
    pub challenge_hash: [u8; 32],
    pub intent_hash: [u8; 32],
    pub merchant_pubkey: Pubkey,
    /// Non-zero when this payment reached a velocity limit and froze the
    /// account.
    pub froze_account: u8,
    pub _padding: [u8; 7],
}

/// The policy account. It owns the vault, the token account the agent pays
/// from, so only this program can move money out of it.
///
/// Fields are ordered by alignment so the layout has no hidden padding.
#[account(zero_copy)]
#[derive(Debug)]
pub struct Policy {
    /// Counts owner actions, so an assertion authorizes exactly one.
    pub owner_nonce: u64,
    pub limits: StoredLimits,
    pub slots: [PaymentRecord; MAX_TRACKED_PAYMENTS],
    pub merchants: [Pubkey; MAX_MERCHANTS],
    /// Chosen at creation, the second PDA seed.
    pub policy_id: [u8; 32],
    /// sha256 of the WebAuthn relying party id the passkey belongs to.
    pub rp_id_hash: [u8; 32],
    /// sha256 of the CAIP-2 id of the cluster the account was created on. A
    /// program cannot read the genesis hash, so the cluster is fixed here.
    pub network_id: [u8; 32],
    /// The delegated agent key. The default key means revoked.
    pub agent_signer: Pubkey,
    /// The one mint this account pays in.
    pub asset: Pubkey,
    /// Owner of the token account the balance goes to in an emergency.
    pub recovery: Pubkey,
    /// The owner passkey: the parity byte of a compressed secp256r1 point,
    /// then its x coordinate. The precompile takes the 33 bytes together.
    pub owner_prefix: u8,
    pub owner_x: [u8; 32],
    pub frozen: u8,
    pub merchant_count: u8,
    pub bump: u8,
    pub _padding: [u8; 4],
}

impl Policy {
    pub fn owner_key(&self) -> [u8; 33] {
        let mut key = [0u8; 33];
        key[0] = self.owner_prefix;
        key[1..].copy_from_slice(&self.owner_x);
        key
    }

    pub fn is_frozen(&self) -> bool {
        self.frozen != 0
    }

    pub fn is_merchant(&self, key: &Pubkey) -> bool {
        self.merchants[..self.merchant_count as usize].contains(key)
    }

    pub fn agent_revoked(&self) -> bool {
        self.agent_signer == Pubkey::default()
    }

    pub fn velocity(&self) -> VelocityConfig {
        self.limits.into()
    }
}

#[event]
pub struct PolicyCreated {
    pub policy: Pubkey,
    pub agent_signer: Pubkey,
    pub asset: Pubkey,
    pub recovery: Pubkey,
}

/// The proof of intent. Emitted by the payment itself: on Solana the merchant
/// settles, so nothing forbids the account from speaking while it pays.
#[event]
pub struct ProofOfIntent {
    pub policy: Pubkey,
    pub nonce: [u8; 32],
    pub challenge_hash: [u8; 32],
    pub intent_hash: [u8; 32],
    pub merchant_pubkey: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

/// Why payments stopped.
pub const FROZEN_MANUAL: u8 = 0;
pub const FROZEN_VELOCITY: u8 = 1;

#[event]
pub struct PaymentsFrozen {
    pub policy: Pubkey,
    pub reason: u8,
    pub tx_count: u32,
    pub total_amount: u64,
}

#[event]
pub struct PaymentsRestored {
    pub policy: Pubkey,
    pub tx_count: u32,
    pub total_amount: u64,
}

#[event]
pub struct SignerRevoked {
    pub policy: Pubkey,
    pub pubkey: Pubkey,
}

#[event]
pub struct SignerSet {
    pub policy: Pubkey,
    pub pubkey: Pubkey,
}

#[event]
pub struct MerchantAdded {
    pub policy: Pubkey,
    pub pubkey: Pubkey,
}

#[event]
pub struct MerchantRemoved {
    pub policy: Pubkey,
    pub pubkey: Pubkey,
}

#[event]
pub struct LimitsReduced {
    pub policy: Pubkey,
    pub max_payment_amount: u64,
    pub max_tx_count: u32,
    pub max_total_amount: u64,
    pub window_size: u64,
}

#[event]
pub struct FundsRecovered {
    pub policy: Pubkey,
    pub recovery: Pubkey,
    pub amount: u64,
}
