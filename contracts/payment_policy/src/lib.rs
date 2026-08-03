#![no_std]

mod crypto;
mod errors;
mod events;
mod passkey;
mod types;
mod velocity;

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, BytesN, Env, Symbol, TryIntoVal, Vec,
};

use crate::crypto::{
    domain_separated_hash, settlement_preimage, verify_ed25519, CHALLENGE_DOMAIN, INTENT_DOMAIN,
};
use crate::errors::PolicyError;
use crate::events::{
    emit_payment_frozen, emit_payment_restored, emit_proof_of_intent, emit_signer_revoked,
};
use crate::passkey::verify_passkey;
use crate::types::{
    AgentSignature, DataKey, PolicySignature, VelocityConfig, VelocityState,
};
use crate::velocity::{check_and_update_velocity, get_velocity_state};

/// Functions that only the account owner may authorize. Everything else that
/// this account signs for is a payment and goes through the agent path.
const OWNER_ACTIONS: [&str; 7] = [
    "freeze_payments",
    "restore_payments",
    "revoke_agent_signer",
    "set_agent_signer",
    "add_merchant",
    "remove_merchant",
    "update_velocity_config",
];

#[contract]
pub struct PaymentPolicyContract;

#[contractimpl]
impl PaymentPolicyContract {
    pub fn __constructor(
        env: Env,
        owner: BytesN<65>,
        agent_signer: BytesN<32>,
        velocity_config: VelocityConfig,
    ) {
        validate_velocity_config(&velocity_config);
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage()
            .instance()
            .set(&DataKey::AgentSigner, &agent_signer);
        env.storage().instance().set(&DataKey::Frozen, &false);
        env.storage()
            .instance()
            .set(&DataKey::VelocityConfig, &velocity_config);
    }

    pub fn freeze_payments(env: Env) -> Result<(), PolicyError> {
        let _: BytesN<65> = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(PolicyError::NotInitialized)?;

        env.current_contract_address()
            .require_auth();

        env.storage().instance().set(&DataKey::Frozen, &true);

        let state = get_velocity_state(&env);
        emit_payment_frozen(&env, "manual", state.tx_count, state.total_amount);
        Ok(())
    }

    pub fn restore_payments(env: Env) -> Result<(), PolicyError> {
        let _owner: BytesN<65> = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(PolicyError::NotInitialized)?;

        env.current_contract_address()
            .require_auth();

        env.storage().instance().set(&DataKey::Frozen, &false);

        env.storage().instance().set(
            &DataKey::VelocityState,
            &VelocityState {
                tx_count: 0,
                total_amount: 0,
                window_start: env.ledger().timestamp(),
            },
        );

        emit_payment_restored(&env);
        Ok(())
    }

    pub fn revoke_agent_signer(env: Env) -> Result<(), PolicyError> {
        env.storage()
            .instance()
            .get::<_, BytesN<65>>(&DataKey::Owner)
            .ok_or(PolicyError::NotInitialized)?;

        env.current_contract_address()
            .require_auth();

        let old_signer: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::AgentSigner)
            .ok_or(PolicyError::NotInitialized)?;

        env.storage()
            .instance()
            .remove(&DataKey::AgentSigner);

        emit_signer_revoked(&env, &old_signer);
        Ok(())
    }

    pub fn set_agent_signer(env: Env, new_pubkey: BytesN<32>) -> Result<(), PolicyError> {
        env.storage()
            .instance()
            .get::<_, BytesN<65>>(&DataKey::Owner)
            .ok_or(PolicyError::NotInitialized)?;

        env.current_contract_address()
            .require_auth();

        env.storage()
            .instance()
            .set(&DataKey::AgentSigner, &new_pubkey);
        Ok(())
    }

    pub fn add_merchant(env: Env, merchant_pubkey: BytesN<32>) -> Result<(), PolicyError> {
        env.storage()
            .instance()
            .get::<_, BytesN<65>>(&DataKey::Owner)
            .ok_or(PolicyError::NotInitialized)?;

        env.current_contract_address()
            .require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Merchant(merchant_pubkey), &true);
        Ok(())
    }

    pub fn remove_merchant(env: Env, merchant_pubkey: BytesN<32>) -> Result<(), PolicyError> {
        env.storage()
            .instance()
            .get::<_, BytesN<65>>(&DataKey::Owner)
            .ok_or(PolicyError::NotInitialized)?;

        env.current_contract_address()
            .require_auth();

        env.storage()
            .instance()
            .remove(&DataKey::Merchant(merchant_pubkey));
        Ok(())
    }

    pub fn update_velocity_config(
        env: Env,
        config: VelocityConfig,
    ) -> Result<(), PolicyError> {
        env.storage()
            .instance()
            .get::<_, BytesN<65>>(&DataKey::Owner)
            .ok_or(PolicyError::NotInitialized)?;

        env.current_contract_address()
            .require_auth();

        validate_velocity_config(&config);
        env.storage()
            .instance()
            .set(&DataKey::VelocityConfig, &config);
        Ok(())
    }

    // Query functions
    pub fn is_frozen(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Frozen)
            .unwrap_or(false)
    }

    pub fn get_agent_signer(env: Env) -> Result<BytesN<32>, PolicyError> {
        env.storage()
            .instance()
            .get(&DataKey::AgentSigner)
            .ok_or(PolicyError::SignerRevoked)
    }

    pub fn is_merchant(env: Env, merchant_pubkey: BytesN<32>) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Merchant(merchant_pubkey))
            .unwrap_or(false)
    }

    pub fn get_velocity_config(env: Env) -> Result<VelocityConfig, PolicyError> {
        env.storage()
            .instance()
            .get(&DataKey::VelocityConfig)
            .ok_or(PolicyError::NotInitialized)
    }

    pub fn get_velocity_state(env: Env) -> VelocityState {
        velocity::get_velocity_state(&env)
    }
}

fn validate_velocity_config(config: &VelocityConfig) {
    assert!(config.max_tx_count > 0, "max_tx_count must be positive");
    assert!(
        config.max_total_amount > 0,
        "max_total_amount must be positive"
    );
    assert!(config.window_size > 0, "window_size must be positive");
}

#[contractimpl]
impl CustomAccountInterface for PaymentPolicyContract {
    type Error = PolicyError;
    type Signature = PolicySignature;

    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: PolicySignature,
        auth_context: Vec<Context>,
    ) -> Result<(), PolicyError> {
        // What is being authorized decides which key has to approve it. The
        // caller cannot reach for the cheaper path by presenting a different
        // kind of signature, and cannot hide an owner action inside a payment
        // batch, because a mixed batch is refused outright.
        let owner_actions = count_owner_actions(&env, &auth_context);
        let owner_path = owner_actions > 0;
        if owner_path && owner_actions != auth_context.len() {
            return Err(PolicyError::UnauthorizedOwnerAction);
        }

        match signature {
            PolicySignature::Owner(assertion) => {
                if !owner_path {
                    return Err(PolicyError::UnauthorizedOwnerAction);
                }

                let owner: BytesN<65> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Owner)
                    .ok_or(PolicyError::NotInitialized)?;

                // The owner path deliberately ignores the frozen flag. A
                // frozen account still has to accept the call that thaws it,
                // otherwise freezing would lock the owner out for good.
                verify_passkey(&env, &owner, &signature_payload, &assertion)
            }
            PolicySignature::Agent(agent) => {
                if owner_path {
                    return Err(PolicyError::UnauthorizedOwnerAction);
                }

                check_payment_authorization(&env, &signature_payload, &agent, &auth_context)
            }
        }
    }
}

/// Count the authorized calls that target an owner only function on this very
/// contract. Calls into any other contract never qualify, so a token transfer
/// can never be mistaken for account administration.
fn count_owner_actions(env: &Env, auth_context: &Vec<Context>) -> u32 {
    let this_contract = env.current_contract_address();
    let mut count = 0u32;

    for context in auth_context.iter() {
        if let Context::Contract(c) = context {
            if c.contract != this_contract {
                continue;
            }
            for name in OWNER_ACTIONS.iter() {
                if c.fn_name == Symbol::new(env, name) {
                    count += 1;
                    break;
                }
            }
        }
    }

    count
}

fn check_payment_authorization(
    env: &Env,
    signature_payload: &Hash<32>,
    signature: &AgentSignature,
    auth_context: &Vec<Context>,
) -> Result<(), PolicyError> {
    // 1. Refuse everything while the account is frozen
    let frozen: bool = env
        .storage()
        .instance()
        .get(&DataKey::Frozen)
        .unwrap_or(false);
    if frozen {
        return Err(PolicyError::AccountFrozen);
    }

    // 2. The delegated signer has to still exist
    let agent_signer: BytesN<32> = env
        .storage()
        .instance()
        .get(&DataKey::AgentSigner)
        .ok_or(PolicyError::SignerRevoked)?;

    // 3. Verify the agent signature over the Soroban payload
    verify_ed25519(
        env,
        &agent_signer,
        &signature_payload.to_bytes(),
        &signature.agent_signature,
    );

    // 4. The merchant has to be on the allowlist
    let merchant_allowed: bool = env
        .storage()
        .instance()
        .get(&DataKey::Merchant(signature.merchant_pubkey.clone()))
        .unwrap_or(false);
    if !merchant_allowed {
        return Err(PolicyError::UnauthorizedMerchant);
    }

    // 5. Rebuild both hashes from the fields the agent supplied. Deriving
    //    them here rather than accepting them is what turns the merchant
    //    signature into a statement about this exact settlement. The network
    //    id comes from the ledger, so a challenge signed for another network
    //    cannot be replayed here.
    let network_id = env.ledger().network_id();
    let preimage = settlement_preimage(
        env,
        &signature.request_digest,
        &signature.recipient,
        &signature.asset,
        signature.amount,
        &network_id,
        &signature.nonce,
        signature.expiry,
    )?;
    let challenge_hash = domain_separated_hash(env, CHALLENGE_DOMAIN, &preimage).to_bytes();
    let intent_hash = domain_separated_hash(env, INTENT_DOMAIN, &preimage).to_bytes();

    // 6. Verify the merchant signature over the challenge hash we derived
    verify_ed25519(
        env,
        &signature.merchant_pubkey,
        &challenge_hash,
        &signature.merchant_signature,
    );

    // 7. The transfer being authorized has to be the one that was agreed
    check_settlement(env, signature, auth_context)?;

    // 8. Nonce replay check. Temporary storage lets the entries expire on
    //    their own instead of growing instance storage forever.
    let nonce_key = DataKey::Nonce(signature.nonce.clone());
    if env.storage().temporary().has(&nonce_key) {
        return Err(PolicyError::NonceReused);
    }
    env.storage().temporary().set(&nonce_key, &true);
    // Keep the nonce around long enough to actually block a replay, but stay
    // under the ledger maximum so the call cannot fail on an invalid ttl.
    let max_ttl = env.storage().max_ttl();
    let desired_ttl: u32 = 7200;
    let ttl = desired_ttl.min(max_ttl);
    env.storage().temporary().extend_ttl(&nonce_key, ttl, ttl);

    // 9. Expiry. An unset expiry is treated as invalid rather than eternal.
    let now = env.ledger().timestamp();
    if signature.expiry == 0 || now > signature.expiry {
        return Err(PolicyError::ChallengeExpired);
    }

    // 10. A negative amount would wind the velocity counter backwards
    if signature.amount < 0 {
        return Err(PolicyError::InvalidAmount);
    }

    // 11. Velocity, measured against the amount both parties signed for
    if !check_and_update_velocity(env, signature.amount) {
        return Err(PolicyError::VelocityExceeded);
    }

    // 12. Announce the proof of intent with hashes rather than request content
    emit_proof_of_intent(
        env,
        &challenge_hash,
        &intent_hash,
        &signature.merchant_pubkey,
        signature.amount,
    );

    Ok(())
}

/// Confirm that what the account is being asked to authorize is exactly the
/// transfer the merchant and the agent both signed for.
///
/// Every transfer in the batch is checked, not just the first one, and a
/// batch carrying more than one transfer is refused. Otherwise an agreed
/// payment could be used as cover for a second, unagreed one.
fn check_settlement(
    env: &Env,
    signature: &AgentSignature,
    auth_context: &Vec<Context>,
) -> Result<(), PolicyError> {
    let transfer_fn = soroban_sdk::symbol_short!("transfer");
    let this_contract = env.current_contract_address();
    let mut matched = false;

    for context in auth_context.iter() {
        let Context::Contract(c) = context else {
            return Err(PolicyError::SettlementMismatch);
        };

        if c.fn_name != transfer_fn {
            return Err(PolicyError::SettlementMismatch);
        }
        if matched {
            return Err(PolicyError::SettlementMismatch);
        }
        if c.contract != signature.asset || c.args.len() < 3 {
            return Err(PolicyError::SettlementMismatch);
        }

        let from: Address = c
            .args
            .get(0)
            .unwrap()
            .try_into_val(env)
            .map_err(|_| PolicyError::SettlementMismatch)?;
        let to: Address = c
            .args
            .get(1)
            .unwrap()
            .try_into_val(env)
            .map_err(|_| PolicyError::SettlementMismatch)?;
        let amount: i128 = c
            .args
            .get(2)
            .unwrap()
            .try_into_val(env)
            .map_err(|_| PolicyError::SettlementMismatch)?;

        // The account may only ever spend its own balance.
        if from != this_contract || to != signature.recipient || amount != signature.amount {
            return Err(PolicyError::SettlementMismatch);
        }

        matched = true;
    }

    if !matched {
        return Err(PolicyError::SettlementMismatch);
    }

    Ok(())
}

#[cfg(test)]
mod test;
