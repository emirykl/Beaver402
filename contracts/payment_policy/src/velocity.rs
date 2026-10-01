//! The record of recent payments.
//!
//! One fixed set of slots does three jobs. It is the velocity window, it is
//! what refuses a replayed challenge, and it holds each payment's proof of
//! intent until publish_proof announces it.
//!
//! A slot is only reused once its payment has left the window, and the
//! window is never shorter than the longest a challenge may live, so a
//! challenge has always expired by the time the slot that remembers its
//! nonce is handed to another payment.
//!
//! The slots never change size. A payment that made stored state grow would
//! pay rent on the extra bytes for the rest of the account's life, and one
//! that created a new entry would pay at least a day of rent for it. Either
//! takes a payment over what an x402 facilitator accepts.

use soroban_sdk::{BytesN, Env, Vec};

use crate::errors::PolicyError;
use crate::types::{DataKey, PaymentRecord, VelocityConfig, VelocityState};
use crate::MAX_CHALLENGE_LIFETIME;

/// The most payments one window can be configured to hold. Every payment
/// reads and writes all slots, so this bounds its cost.
pub const MAX_TRACKED_PAYMENTS: u32 = 16;

fn empty_slot(env: &Env) -> PaymentRecord {
    let zero = BytesN::from_array(env, &[0u8; 32]);
    PaymentRecord {
        timestamp: 0,
        amount: 0,
        nonce: zero.clone(),
        challenge_hash: zero.clone(),
        intent_hash: zero.clone(),
        merchant_pubkey: zero,
        froze_account: false,
        published: false,
    }
}

/// A slot holds a payment. Real payments always move a positive amount.
fn is_used(slot: &PaymentRecord) -> bool {
    slot.amount > 0
}

/// A payment counts for exactly window_size seconds after it was made,
/// whatever happens in between. Freezing and restoring the account does not
/// clear it, so cycling the account cannot buy a fresh budget.
fn counts(slot: &PaymentRecord, config: &VelocityConfig, now: u64) -> bool {
    is_used(slot) && now.saturating_sub(slot.timestamp) < config.window_size
}

/// Give the account its slots. Called once, when the account is created.
pub fn create_slots(env: &Env, capacity: u32) {
    let mut slots = Vec::new(env);
    for _ in 0..capacity {
        slots.push_back(empty_slot(env));
    }
    save(env, &slots);
}

fn load(env: &Env) -> Vec<PaymentRecord> {
    env.storage()
        .instance()
        .get(&DataKey::Payments)
        .unwrap_or(Vec::new(env))
}

fn save(env: &Env, slots: &Vec<PaymentRecord>) {
    env.storage().instance().set(&DataKey::Payments, slots);
}

fn summarize(slots: &Vec<PaymentRecord>, config: &VelocityConfig, now: u64) -> VelocityState {
    let mut state = VelocityState {
        tx_count: 0,
        total_amount: 0,
        window_start: 0,
    };
    for slot in slots.iter() {
        if !counts(&slot, config, now) {
            continue;
        }
        state.tx_count += 1;
        state.total_amount = state.total_amount.saturating_add(slot.amount);
        if state.window_start == 0 || slot.timestamp < state.window_start {
            state.window_start = slot.timestamp;
        }
    }
    state
}

/// Record a payment, or refuse it.
///
/// Refused when its nonce has been seen, when the window already holds as
/// many payments as allowed, or when it would take the total over the
/// limit. The check is on the total after this payment, so the limit is
/// never exceeded, not even by the payment that reaches it.
///
/// A payment that fills the window freezes the account behind it, and the
/// record says so. That cannot happen on the refused attempt instead,
/// because a refusal unwinds everything the authorization wrote.
pub fn record(
    env: &Env,
    config: &VelocityConfig,
    mut payment: PaymentRecord,
) -> Result<(), PolicyError> {
    let now = env.ledger().timestamp();
    let mut slots = load(env);

    for slot in slots.iter() {
        if is_used(&slot) && slot.nonce == payment.nonce {
            return Err(PolicyError::NonceReused);
        }
    }

    let before = summarize(&slots, config, now);
    if before.tx_count >= config.max_tx_count {
        return Err(PolicyError::VelocityExceeded);
    }
    let total = before
        .total_amount
        .checked_add(payment.amount)
        .ok_or(PolicyError::VelocityExceeded)?;
    if total > config.max_total_amount {
        return Err(PolicyError::VelocityExceeded);
    }

    // There is always a free slot here: fewer payments count than the limit
    // allows, and the limit never exceeds the number of slots.
    let free = slots
        .iter()
        .position(|slot| !counts(&slot, config, now))
        .ok_or(PolicyError::VelocityExceeded)?;

    let filled = before.tx_count + 1 >= config.max_tx_count || total >= config.max_total_amount;
    payment.timestamp = now;
    payment.froze_account = filled;
    payment.published = false;
    slots.set(free as u32, payment);
    save(env, &slots);

    if filled {
        env.storage().instance().set(&DataKey::Frozen, &true);
    }
    Ok(())
}

/// The recorded payment with this nonce, while its slot still holds it.
pub fn find(env: &Env, nonce: &BytesN<32>) -> Option<PaymentRecord> {
    load(env)
        .iter()
        .find(|slot| is_used(slot) && slot.nonce == *nonce)
}

/// Mark a payment's proof as announced. Refused if there is no such payment
/// or its proof was announced already.
pub fn mark_published(env: &Env, nonce: &BytesN<32>) -> Result<PaymentRecord, PolicyError> {
    let mut slots = load(env);
    let index = slots
        .iter()
        .position(|slot| is_used(&slot) && slot.nonce == *nonce)
        .ok_or(PolicyError::ProofNotFound)? as u32;

    let mut payment = slots.get(index).ok_or(PolicyError::ProofNotFound)?;
    if payment.published {
        return Err(PolicyError::ProofAlreadyPublished);
    }
    payment.published = true;
    slots.set(index, payment.clone());
    save(env, &slots);
    Ok(payment)
}

/// The window as it stands right now.
pub fn current_state(env: &Env) -> VelocityState {
    let config: Option<VelocityConfig> = env.storage().instance().get(&DataKey::VelocityConfig);
    match config {
        Some(config) => summarize(&load(env), &config, env.ledger().timestamp()),
        None => VelocityState {
            tx_count: 0,
            total_amount: 0,
            window_start: 0,
        },
    }
}

/// Whether a configuration is one the account can run with.
///
/// The window may not be shorter than the longest a challenge lives. A slot
/// is reused once its payment leaves the window, and the nonce it remembers
/// has to belong to an expired challenge by then.
pub fn is_valid(config: &VelocityConfig) -> bool {
    config.max_payment_amount > 0
        && config.max_total_amount > 0
        && config.max_payment_amount <= config.max_total_amount
        && config.max_tx_count > 0
        && config.max_tx_count <= MAX_TRACKED_PAYMENTS
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
