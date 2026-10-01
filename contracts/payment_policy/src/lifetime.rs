//! Keeping the account's state on the ledger.
//!
//! Persistent entries that nobody extends get archived. The first testnet
//! deployment was, fifty days after it was created, and from then on every
//! call had to pay to restore the contract first, at a fee no x402
//! facilitator accepts. So the account is extended by every call that can
//! afford it, and anyone can extend it without making a payment.

use soroban_sdk::Env;

/// Ledgers close about every five seconds.
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// How far ahead the account and its code are kept alive: 150 days, inside
/// the network's 180 day maximum.
pub const INSTANCE_LIFETIME: u32 = 150 * LEDGERS_PER_DAY;

/// How much has to have gone by before an extension happens. Extending in
/// steps of a week keeps each extension, and its rent, small.
pub const EXTENSION_STEP: u32 = 7 * LEDGERS_PER_DAY;

/// Push the instance, and with it the contract code, back out to the full
/// lifetime once it has fallen a step short of it.
///
/// Payments never call this. Extending the code is rent on its whole size,
/// and a payment that happened to trigger it would cost more than an x402
/// facilitator accepts. Owner actions, publish_proof and extend_ttl do it
/// instead, and extend_ttl can be called by anyone at any time.
pub fn extend_instance(env: &Env) {
    let extend_to = INSTANCE_LIFETIME.min(env.storage().max_ttl());
    let threshold = extend_to - EXTENSION_STEP.min(extend_to / 2);
    env.storage().instance().extend_ttl(threshold, extend_to);
}
