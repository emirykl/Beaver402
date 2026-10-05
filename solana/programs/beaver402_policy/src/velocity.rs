//! The record of recent payments, the same design as the Soroban contract's
//! velocity.rs.
//!
//! One fixed set of slots is both the velocity window and what refuses a
//! replayed challenge. A slot is only reused once its payment has left the
//! window, and the window is never shorter than the longest a challenge may
//! live, so a challenge has always expired by the time the slot that
//! remembers its nonce is handed to another payment.

use anchor_lang::prelude::*;

use crate::constants::{MAX_CHALLENGE_LIFETIME, MAX_TRACKED_PAYMENTS};
use crate::error::PolicyError;
use crate::state::{PaymentRecord, Policy, VelocityConfig};

/// What the velocity window looks like at a given moment.
pub struct VelocityState {
    pub tx_count: u32,
    pub total_amount: u64,
}

fn is_used(slot: &PaymentRecord) -> bool {
    slot.amount > 0
}

/// A payment counts for exactly window_size seconds after it was made,
/// whatever happens in between. Freezing and restoring does not clear it.
fn counts(slot: &PaymentRecord, window_size: u64, now: u64) -> bool {
    is_used(slot) && now.saturating_sub(slot.timestamp) < window_size
}

pub fn summarize(policy: &Policy, now: u64) -> VelocityState {
    let mut state = VelocityState {
        tx_count: 0,
        total_amount: 0,
    };
    for slot in policy.slots.iter() {
        if counts(slot, policy.limits.window_size, now) {
            state.tx_count += 1;
            state.total_amount = state.total_amount.saturating_add(slot.amount);
        }
    }
    state
}

/// Record a payment, or refuse it.
///
/// Refused when its nonce has been seen, when the window already holds as
/// many payments as allowed, or when it would take the total over the limit.
/// A payment that fills the window freezes the account behind it.
pub fn record(policy: &mut Policy, mut payment: PaymentRecord, now: u64) -> Result<bool> {
    if policy
        .slots
        .iter()
        .any(|slot| is_used(slot) && slot.nonce == payment.nonce)
    {
        return err!(PolicyError::NonceReused);
    }

    let limits = policy.limits;
    let before = summarize(policy, now);
    if before.tx_count >= limits.max_tx_count {
        return err!(PolicyError::VelocityExceeded);
    }
    let total = before
        .total_amount
        .checked_add(payment.amount)
        .ok_or(error!(PolicyError::VelocityExceeded))?;
    if total > limits.max_total_amount {
        return err!(PolicyError::VelocityExceeded);
    }

    // There is always a free slot here: fewer payments count than the limit
    // allows, and the limit never exceeds the number of slots.
    let free = policy
        .slots
        .iter()
        .position(|slot| !counts(slot, limits.window_size, now))
        .ok_or(error!(PolicyError::VelocityExceeded))?;

    let filled =
        before.tx_count + 1 >= limits.max_tx_count || total >= limits.max_total_amount;
    payment.timestamp = now;
    payment.froze_account = filled as u8;
    policy.slots[free] = payment;
    if filled {
        policy.frozen = 1;
    }
    Ok(filled)
}

/// Whether a configuration is one the account can run with.
pub fn is_valid(config: &VelocityConfig) -> bool {
    config.max_payment_amount > 0
        && config.max_total_amount > 0
        && config.max_payment_amount <= config.max_total_amount
        && config.max_tx_count > 0
        && config.max_tx_count as usize <= MAX_TRACKED_PAYMENTS
        && config.window_size >= MAX_CHALLENGE_LIFETIME
}

/// Whether moving from one configuration to another tightens or keeps every
/// limit. A shorter window lets payments stop counting sooner, so it counts
/// as an increase.
pub fn only_reduces(current: &VelocityConfig, next: &VelocityConfig) -> bool {
    next.max_payment_amount <= current.max_payment_amount
        && next.max_tx_count <= current.max_tx_count
        && next.max_total_amount <= current.max_total_amount
        && next.window_size >= current.window_size
}
