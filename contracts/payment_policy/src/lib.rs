#![no_std]

mod crypto;
mod errors;
mod events;
mod lifetime;
mod passkey;
mod types;
mod velocity;

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    symbol_short, token, Address, BytesN, Env, Symbol, TryIntoVal, Vec,
};

use crate::crypto::{
    domain_separated_hash, settlement_preimage, verify_ed25519, CHALLENGE_DOMAIN, INTENT_DOMAIN,
};
use crate::errors::PolicyError;
use crate::events::{
    FundsRecovered, LimitsReduced, MerchantAdded, MerchantRemoved, PaymentsFrozen,
    PaymentsRestored, ProofOfIntent, SignerRevoked, SignerSet,
};
use crate::lifetime::extend_instance;
use crate::passkey::verify_passkey;
use crate::types::{
    AgentSignature, DataKey, PaymentRecord, PolicySignature, VelocityConfig, VelocityState,
};

/// Functions that only the account owner may authorize. Everything else that
/// this account signs for is a payment and goes through the agent path.
const OWNER_ACTIONS: [&str; 8] = [
    "freeze_payments",
    "restore_payments",
    "revoke_agent_signer",
    "set_agent_signer",
    "add_merchant",
    "remove_merchant",
    "reduce_limits",
    "recover_funds",
];

/// The longest a merchant challenge may stay valid, in seconds. The velocity
/// window is never shorter, which is what lets a payment's slot remember its
/// nonce for as long as the challenge could be replayed.
pub const MAX_CHALLENGE_LIFETIME: u64 = 900;

#[contract]
pub struct PaymentPolicyContract;

#[contractimpl]
impl PaymentPolicyContract {
    /// Create the account.
    ///
    /// Everything that decides where money can go is fixed here and cannot be
    /// changed later: the owner passkey and the domain it belongs to, the
    /// token the account pays in, and the address the owner can recover the
    /// balance to. The limits can only be lowered afterwards. There is no
    /// upgrade path; a different policy means a different account.
    pub fn __constructor(
        env: Env,
        owner: BytesN<65>,
        rp_id_hash: BytesN<32>,
        agent_signer: BytesN<32>,
        asset: Address,
        recovery: Address,
        velocity_config: VelocityConfig,
    ) -> Result<(), PolicyError> {
        if !velocity::is_valid(&velocity_config) {
            return Err(PolicyError::InvalidConfig);
        }
        if recovery == env.current_contract_address() || asset == env.current_contract_address()
        {
            return Err(PolicyError::InvalidConfig);
        }

        let storage = env.storage().instance();
        storage.set(&DataKey::Owner, &owner);
        storage.set(&DataKey::RpIdHash, &rp_id_hash);
        storage.set(&DataKey::AgentSigner, &agent_signer);
        storage.set(&DataKey::Asset, &asset);
        storage.set(&DataKey::Recovery, &recovery);
        storage.set(&DataKey::Frozen, &false);
        storage.set(&DataKey::VelocityConfig, &velocity_config);
        velocity::create_slots(&env, velocity_config.max_tx_count);

        extend_instance(&env);
        Ok(())
    }

    // ── Owner actions ─────────────────────────────────────────────

    pub fn freeze_payments(env: Env) -> Result<(), PolicyError> {
        require_owner(&env)?;

        env.storage().instance().set(&DataKey::Frozen, &true);

        let state = velocity::current_state(&env);
        PaymentsFrozen {
            reason: symbol_short!("manual"),
            tx_count: state.tx_count,
            total_amount: state.total_amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Let payments through again.
    ///
    /// The velocity window is left exactly as it is. Payments made before the
    /// freeze keep counting until they age out, so freezing and restoring
    /// cannot be used to reset the budget.
    pub fn restore_payments(env: Env) -> Result<(), PolicyError> {
        require_owner(&env)?;

        env.storage().instance().set(&DataKey::Frozen, &false);

        let state = velocity::current_state(&env);
        PaymentsRestored {
            tx_count: state.tx_count,
            total_amount: state.total_amount,
        }
        .publish(&env);
        Ok(())
    }

    pub fn revoke_agent_signer(env: Env) -> Result<(), PolicyError> {
        require_owner(&env)?;

        let old_signer: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::AgentSigner)
            .ok_or(PolicyError::SignerRevoked)?;

        env.storage().instance().remove(&DataKey::AgentSigner);

        SignerRevoked { pubkey: old_signer }.publish(&env);
        Ok(())
    }

    pub fn set_agent_signer(env: Env, new_pubkey: BytesN<32>) -> Result<(), PolicyError> {
        require_owner(&env)?;

        env.storage()
            .instance()
            .set(&DataKey::AgentSigner, &new_pubkey);

        SignerSet { pubkey: new_pubkey }.publish(&env);
        Ok(())
    }

    pub fn add_merchant(env: Env, merchant_pubkey: BytesN<32>) -> Result<(), PolicyError> {
        require_owner(&env)?;

        env.storage()
            .instance()
            .set(&DataKey::Merchant(merchant_pubkey.clone()), &true);

        MerchantAdded {
            pubkey: merchant_pubkey,
        }
        .publish(&env);
        Ok(())
    }

    pub fn remove_merchant(env: Env, merchant_pubkey: BytesN<32>) -> Result<(), PolicyError> {
        require_owner(&env)?;

        env.storage()
            .instance()
            .remove(&DataKey::Merchant(merchant_pubkey.clone()));

        MerchantRemoved {
            pubkey: merchant_pubkey,
        }
        .publish(&env);
        Ok(())
    }

    /// Replace the limits with tighter ones. Any attempt to loosen even one
    /// of them is refused, so the limits the account was created with are a
    /// ceiling for as long as it exists.
    pub fn reduce_limits(env: Env, config: VelocityConfig) -> Result<(), PolicyError> {
        require_owner(&env)?;

        if !velocity::is_valid(&config) {
            return Err(PolicyError::InvalidConfig);
        }
        let current: VelocityConfig = env
            .storage()
            .instance()
            .get(&DataKey::VelocityConfig)
            .ok_or(PolicyError::NotInitialized)?;
        if !velocity::only_reduces(&current, &config) {
            return Err(PolicyError::LimitIncrease);
        }

        env.storage()
            .instance()
            .set(&DataKey::VelocityConfig, &config);

        LimitsReduced {
            max_payment_amount: config.max_payment_amount,
            max_tx_count: config.max_tx_count,
            max_total_amount: config.max_total_amount,
            window_size: config.window_size,
        }
        .publish(&env);
        Ok(())
    }

    /// Move the account's whole balance of a token to the recovery address.
    ///
    /// This is the emergency exit. It only works on a frozen account, so it
    /// is always the second deliberate step, and the destination was fixed
    /// when the account was created, so nobody can point it anywhere else.
    /// The delegated signer cannot reach it: it is an owner action, and the
    /// agent path only ever authorizes a single agreed transfer.
    pub fn recover_funds(env: Env, token: Address) -> Result<i128, PolicyError> {
        require_owner(&env)?;

        if !is_frozen(&env) {
            return Err(PolicyError::NotFrozen);
        }

        let recovery: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recovery)
            .ok_or(PolicyError::NotInitialized)?;
        let this = env.current_contract_address();
        let client = token::TokenClient::new(&env, &token);

        let balance = client.balance(&this);
        if balance <= 0 {
            return Err(PolicyError::NothingToRecover);
        }

        // The account calls the token itself, so this transfer is authorized
        // by the account being the invoker, not by another signature.
        client.transfer(&this, &recovery, &balance);

        FundsRecovered {
            token,
            recovery,
            amount: balance,
        }
        .publish(&env);
        Ok(balance)
    }

    // ── Anyone may call these ─────────────────────────────────────

    /// Announce the proof of intent for a payment the account authorized.
    ///
    /// The content comes from what the account recorded while it verified the
    /// payment, not from the caller, so calling this can only ever publish
    /// the truth, and only once.
    pub fn publish_proof(env: Env, nonce: BytesN<32>) -> Result<(), PolicyError> {
        let payment = velocity::mark_published(&env, &nonce)?;

        ProofOfIntent {
            nonce,
            challenge_hash: payment.challenge_hash,
            intent_hash: payment.intent_hash,
            merchant_pubkey: payment.merchant_pubkey,
            amount: payment.amount,
        }
        .publish(&env);

        if payment.froze_account {
            let state = velocity::current_state(&env);
            PaymentsFrozen {
                reason: symbol_short!("velocity"),
                tx_count: state.tx_count,
                total_amount: state.total_amount,
            }
            .publish(&env);
        }

        extend_instance(&env);
        Ok(())
    }

    /// Keep the account and its code from being archived. Every call to the
    /// account does this as well; this exists so nobody has to make a
    /// payment just to keep it alive.
    pub fn extend_ttl(env: Env) {
        extend_instance(&env);
    }

    // ── Queries ───────────────────────────────────────────────────

    pub fn is_frozen(env: Env) -> bool {
        is_frozen(&env)
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
        velocity::current_state(&env)
    }

    pub fn get_asset(env: Env) -> Result<Address, PolicyError> {
        env.storage()
            .instance()
            .get(&DataKey::Asset)
            .ok_or(PolicyError::NotInitialized)
    }

    pub fn get_recovery(env: Env) -> Result<Address, PolicyError> {
        env.storage()
            .instance()
            .get(&DataKey::Recovery)
            .ok_or(PolicyError::NotInitialized)
    }

    /// The recorded payment with this nonce, for as long as it counts toward
    /// the velocity window.
    pub fn get_payment(env: Env, nonce: BytesN<32>) -> Option<PaymentRecord> {
        velocity::find(&env, &nonce)
    }
}

fn is_frozen(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Frozen)
        .unwrap_or(false)
}

/// The gate on every owner action. The authorization itself is checked in
/// __check_auth, which only accepts the owner passkey for these functions.
fn require_owner(env: &Env) -> Result<(), PolicyError> {
    env.storage()
        .instance()
        .get::<_, BytesN<65>>(&DataKey::Owner)
        .ok_or(PolicyError::NotInitialized)?;

    env.current_contract_address().require_auth();

    extend_instance(env);
    Ok(())
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

                let storage = env.storage().instance();
                let owner: BytesN<65> = storage
                    .get(&DataKey::Owner)
                    .ok_or(PolicyError::NotInitialized)?;
                let rp_id_hash: BytesN<32> = storage
                    .get(&DataKey::RpIdHash)
                    .ok_or(PolicyError::NotInitialized)?;

                // The owner path deliberately ignores the frozen flag. A
                // frozen account still has to accept the call that thaws it,
                // otherwise freezing would lock the owner out for good.
                verify_passkey(&env, &owner, &rp_id_hash, &signature_payload, &assertion)
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

/// Decide whether the delegated agent may make this payment.
///
/// Nothing in here emits an event. An x402 facilitator simulates the
/// settlement before submitting it and refuses anything that announces more
/// than the token transfer, so the proof of intent is written to storage and
/// published separately by publish_proof.
fn check_payment_authorization(
    env: &Env,
    signature_payload: &Hash<32>,
    signature: &AgentSignature,
    auth_context: &Vec<Context>,
) -> Result<(), PolicyError> {
    let storage = env.storage().instance();

    // 1. Refuse everything while the account is frozen
    if is_frozen(env) {
        return Err(PolicyError::AccountFrozen);
    }

    // 2. The delegated signer has to still exist
    let agent_signer: BytesN<32> = storage
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
    let merchant_allowed: bool = storage
        .get(&DataKey::Merchant(signature.merchant_pubkey.clone()))
        .unwrap_or(false);
    if !merchant_allowed {
        return Err(PolicyError::UnauthorizedMerchant);
    }

    // 5. The account pays in one token only, so the limits below are all in
    //    the same unit and a merchant cannot ask for anything else it holds.
    let asset: Address = storage
        .get(&DataKey::Asset)
        .ok_or(PolicyError::NotInitialized)?;
    if signature.asset != asset {
        return Err(PolicyError::AssetNotAllowed);
    }

    // 6. The amount has to be a real payment within the per payment limit
    let config: VelocityConfig = storage
        .get(&DataKey::VelocityConfig)
        .ok_or(PolicyError::NotInitialized)?;
    if signature.amount <= 0 {
        return Err(PolicyError::InvalidAmount);
    }
    if signature.amount > config.max_payment_amount {
        return Err(PolicyError::PaymentLimitExceeded);
    }

    // 7. Expiry. An unset expiry is invalid rather than eternal, and a
    //    challenge may not stay valid for longer than the replay record
    //    below is guaranteed to live.
    let now = env.ledger().timestamp();
    if signature.expiry == 0 || now > signature.expiry {
        return Err(PolicyError::ChallengeExpired);
    }
    if signature.expiry - now > MAX_CHALLENGE_LIFETIME {
        return Err(PolicyError::ExpiryTooFar);
    }

    // 8. Rebuild both hashes from the fields the agent supplied. Deriving
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

    // 9. Verify the merchant signature over the challenge hash we derived
    verify_ed25519(
        env,
        &signature.merchant_pubkey,
        &challenge_hash,
        &signature.merchant_signature,
    );

    // 10. The transfer being authorized has to be the one that was agreed
    check_settlement(env, signature, auth_context)?;

    // 11. Record the payment: refuse a spent nonce, apply the velocity
    //     limits to the amount both parties signed for, and keep what was
    //     verified for publish_proof. The account is deliberately not
    //     extended here; see lifetime::extend_instance.
    velocity::record(
        env,
        &config,
        PaymentRecord {
            timestamp: 0,
            amount: signature.amount,
            nonce: signature.nonce.clone(),
            challenge_hash,
            intent_hash,
            merchant_pubkey: signature.merchant_pubkey.clone(),
            froze_account: false,
            published: false,
        },
    )
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
    let transfer_fn = symbol_short!("transfer");
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

#[cfg(test)]
mod vectors_test;
