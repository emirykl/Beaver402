#![no_std]

mod crypto;
mod errors;
mod events;
mod types;
mod velocity;

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    BytesN, Env, TryIntoVal, Vec,
};

use crate::crypto::verify_ed25519;
use crate::errors::PolicyError;
use crate::events::{
    emit_payment_frozen, emit_payment_restored, emit_proof_of_intent, emit_signer_revoked,
};
use crate::types::{DataKey, PolicySignature, VelocityConfig, VelocityState};
use crate::velocity::{check_and_update_velocity, get_velocity_state};

#[contract]
pub struct PaymentPolicyContract;

#[contractimpl]
impl PaymentPolicyContract {
    pub fn __constructor(
        env: Env,
        owner: BytesN<32>,
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
        let _: BytesN<32> = env
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
        let _owner: BytesN<32> = env
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
            .get::<_, BytesN<32>>(&DataKey::Owner)
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
            .get::<_, BytesN<32>>(&DataKey::Owner)
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
            .get::<_, BytesN<32>>(&DataKey::Owner)
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
            .get::<_, BytesN<32>>(&DataKey::Owner)
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
            .get::<_, BytesN<32>>(&DataKey::Owner)
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
        // 1. Check frozen state
        let frozen: bool = env
            .storage()
            .instance()
            .get(&DataKey::Frozen)
            .unwrap_or(false);
        if frozen {
            return Err(PolicyError::AccountFrozen);
        }

        // 2. Verify agent signer exists and is valid
        let agent_signer: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::AgentSigner)
            .ok_or(PolicyError::SignerRevoked)?;

        // 3. Verify agent (buyer) signature on the payload
        verify_ed25519(
            &env,
            &agent_signer,
            &signature_payload.into(),
            &signature.agent_signature,
        );

        // 4. Check merchant is in allowlist
        let merchant_allowed: bool = env
            .storage()
            .instance()
            .get(&DataKey::Merchant(signature.merchant_pubkey.clone()))
            .unwrap_or(false);
        if !merchant_allowed {
            return Err(PolicyError::UnauthorizedMerchant);
        }

        // 5. Verify merchant signature on the challenge hash
        verify_ed25519(
            &env,
            &signature.merchant_pubkey,
            &signature.challenge_hash,
            &signature.merchant_signature,
        );

        // 6. Verify challenge_hash == intent_hash (Proof of Intent)
        if signature.challenge_hash != signature.intent_hash {
            return Err(PolicyError::ChallengeMismatch);
        }

        // 7. Nonce replay check
        if env
            .storage()
            .instance()
            .has(&DataKey::Nonce(signature.nonce.clone()))
        {
            return Err(PolicyError::NonceReused);
        }
        env.storage()
            .instance()
            .set(&DataKey::Nonce(signature.nonce.clone()), &true);

        // 8. Expiry check (expiry=0 is not valid, all signatures must have an expiry)
        let now = env.ledger().timestamp();
        if signature.expiry == 0 || now > signature.expiry {
            return Err(PolicyError::ChallengeExpired);
        }

        // 9. Extract payment amount from auth_context for velocity tracking
        let mut payment_amount: i128 = 0;
        let transfer_fn = soroban_sdk::symbol_short!("transfer");
        for context in auth_context.iter() {
            if let Context::Contract(c) = context {
                if c.fn_name == transfer_fn && c.args.len() >= 3 {
                    let amount_val = c.args.get(2).unwrap();
                    let amount: Result<i128, _> = amount_val.try_into_val(&env);
                    if let Ok(a) = amount {
                        payment_amount += a;
                    }
                }
            }
        }

        // 10. Velocity check (always counts, even non-transfer auth calls)
        if !check_and_update_velocity(&env, payment_amount) {
            return Err(PolicyError::VelocityExceeded);
        }

        // 11. Emit Proof of Intent event
        emit_proof_of_intent(
            &env,
            &signature.challenge_hash,
            &signature.intent_hash,
            &signature.merchant_pubkey,
            payment_amount,
        );

        Ok(())
    }
}

#[cfg(test)]
mod test;
