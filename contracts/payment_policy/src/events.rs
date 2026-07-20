use soroban_sdk::{symbol_short, BytesN, Env};

pub fn emit_proof_of_intent(
    env: &Env,
    challenge_hash: &BytesN<32>,
    intent_hash: &BytesN<32>,
    merchant_pubkey: &BytesN<32>,
    amount: i128,
) {
    env.events().publish(
        (symbol_short!("poi"), symbol_short!("verified")),
        (
            challenge_hash.clone(),
            intent_hash.clone(),
            merchant_pubkey.clone(),
            amount,
        ),
    );
}

pub fn emit_payment_frozen(env: &Env, reason: &str, tx_count: u32, total_amount: i128) {
    let reason_sym = match reason {
        "velocity" => symbol_short!("velocity"),
        "manual" => symbol_short!("manual"),
        _ => symbol_short!("unknown"),
    };
    env.events().publish(
        (symbol_short!("frozen"), reason_sym),
        (tx_count, total_amount),
    );
}

pub fn emit_signer_revoked(env: &Env, revoked_pubkey: &BytesN<32>) {
    env.events().publish(
        (symbol_short!("signer"), symbol_short!("revoked")),
        revoked_pubkey.clone(),
    );
}

pub fn emit_payment_restored(env: &Env) {
    env.events().publish(
        (symbol_short!("frozen"), symbol_short!("restored")),
        true,
    );
}
