use soroban_sdk::Env;

use crate::types::{DataKey, VelocityConfig, VelocityState};

/// Check velocity limits BEFORE this transaction. Returns false if already exceeded.
/// If within limits, updates the counters (including this tx) and auto-freezes
/// if the new totals exceed limits (freeze takes effect for subsequent txs).
pub fn check_and_update_velocity(env: &Env, amount: i128) -> bool {
    let config: VelocityConfig = match env.storage().instance().get(&DataKey::VelocityConfig) {
        Some(c) => c,
        None => return true,
    };

    let now = env.ledger().timestamp();

    let mut state: VelocityState = env
        .storage()
        .instance()
        .get(&DataKey::VelocityState)
        .unwrap_or(VelocityState {
            tx_count: 0,
            total_amount: 0,
            window_start: now,
        });

    // Deterministic window reset: advance by full windows elapsed
    if config.window_size > 0 {
        let elapsed = now.saturating_sub(state.window_start);
        if elapsed >= config.window_size {
            state.tx_count = 0;
            state.total_amount = 0;
            let windows = elapsed / config.window_size;
            state.window_start = state.window_start.saturating_add(windows * config.window_size);
        }
    }

    // Check if already at limit BEFORE this tx
    if state.tx_count >= config.max_tx_count || state.total_amount >= config.max_total_amount {
        return false;
    }

    // Overflow-safe counter updates
    state.tx_count = match state.tx_count.checked_add(1) {
        Some(v) => v,
        None => return false, // overflow means limit exceeded
    };
    state.total_amount = match state.total_amount.checked_add(amount) {
        Some(v) => v,
        None => return false,
    };

    // Save updated state
    env.storage()
        .instance()
        .set(&DataKey::VelocityState, &state);

    // Auto-freeze if this tx pushed us over the limit (takes effect on next tx)
    if state.tx_count >= config.max_tx_count || state.total_amount >= config.max_total_amount {
        env.storage().instance().set(&DataKey::Frozen, &true);
    }

    true
}

pub fn get_velocity_state(env: &Env) -> VelocityState {
    env.storage()
        .instance()
        .get(&DataKey::VelocityState)
        .unwrap_or(VelocityState {
            tx_count: 0,
            total_amount: 0,
            window_start: 0,
        })
}
