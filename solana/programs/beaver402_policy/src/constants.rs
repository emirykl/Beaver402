/// Seed for the policy account. The second seed is the policy id chosen at
/// creation, so one program can hold any number of accounts.
pub const POLICY_SEED: &[u8] = b"policy";

/// The merchant challenge and the buyer intent cover the same fields but are
/// hashed under different domains, so a signature over one can never be
/// replayed as a signature over the other. The Solana family has its own
/// domains because its preimage differs from Stellar's.
pub const CHALLENGE_DOMAIN: &str = "beaver402:challenge:solana:v1";
pub const INTENT_DOMAIN: &str = "beaver402:intent:solana:v1";

/// What an owner passkey assertion signs over, see owner::challenge.
pub const OWNER_DOMAIN: &str = "beaver402:owner:solana:v1";

/// The longest a merchant challenge may stay valid, in seconds. The velocity
/// window is never shorter, which is what lets a payment's slot remember its
/// nonce for as long as the challenge could be replayed.
pub const MAX_CHALLENGE_LIFETIME: u64 = 900;

/// The longest an owner assertion may stay usable, in seconds.
pub const MAX_OWNER_VALIDITY: u64 = 600;

/// The most payments one window can be configured to hold. Every payment
/// reads and writes all slots, so this bounds its cost.
pub const MAX_TRACKED_PAYMENTS: usize = 16;

/// How many merchants the owner can approve at once.
pub const MAX_MERCHANTS: usize = 8;

/// The settlement preimage is exactly this long. See encoding.rs.
pub const SETTLEMENT_PREIMAGE_LEN: usize = 176;
