#![cfg(test)]
extern crate std;

use ed25519_dalek::Keypair;
use ed25519_dalek::Signer;
use rand::thread_rng;
use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::{Address as _, BytesN as _, Ledger, LedgerInfo},
    vec, Address, BytesN, Env, Error, IntoVal, Val,
};

use crate::types::{PolicySignature, VelocityConfig};
use crate::{PaymentPolicyContract, PaymentPolicyContractClient};

fn generate_keypair() -> Keypair {
    Keypair::generate(&mut thread_rng())
}

fn create_policy_signature(
    env: &Env,
    agent_kp: &Keypair,
    merchant_kp: &Keypair,
    payload: &BytesN<32>,
    challenge_hash: &BytesN<32>,
    nonce: &BytesN<32>,
    expiry: u64,
) -> Val {
    let agent_sig: BytesN<64> = agent_kp
        .sign(payload.to_array().as_slice())
        .to_bytes()
        .into_val(env);

    let merchant_sig: BytesN<64> = merchant_kp
        .sign(challenge_hash.to_array().as_slice())
        .to_bytes()
        .into_val(env);

    let merchant_pubkey: BytesN<32> = merchant_kp.public.to_bytes().into_val(env);

    let policy_sig = PolicySignature {
        agent_signature: agent_sig,
        merchant_pubkey,
        merchant_signature: merchant_sig,
        challenge_hash: challenge_hash.clone(),
        intent_hash: challenge_hash.clone(), // matching = valid PoI
        nonce: nonce.clone(),
        expiry,
    };

    policy_sig.into_val(env)
}

fn setup_env() -> (
    Env,
    PaymentPolicyContractClient<'static>,
    Keypair,
    Keypair,
    Keypair,
) {
    let env = Env::default();
    env.mock_all_auths();

    let owner_kp = generate_keypair();
    let agent_kp = generate_keypair();
    let merchant_kp = generate_keypair();

    let owner_pub: BytesN<32> = owner_kp.public.to_bytes().into_val(&env);
    let agent_pub: BytesN<32> = agent_kp.public.to_bytes().into_val(&env);

    let velocity_config = VelocityConfig {
        max_tx_count: 10,
        max_total_amount: 100_000_000_000, // 10,000 USDC (7 decimals)
        window_size: 86400,                // 1 day
    };

    let contract_id = env.register(
        PaymentPolicyContract,
        (&owner_pub, &agent_pub, &velocity_config),
    );
    let client = PaymentPolicyContractClient::new(&env, &contract_id);

    let merchant_pub: BytesN<32> = merchant_kp.public.to_bytes().into_val(&env);
    client.add_merchant(&merchant_pub);

    // Set ledger info
    env.ledger().set(LedgerInfo {
        timestamp: 1000,
        protocol_version: 26,
        sequence_number: 100,
        network_id: [0u8; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10000,
    });

    (env, client, owner_kp, agent_kp, merchant_kp)
}

#[test]
fn test_valid_two_party_auth() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);
    let expiry = 2000u64;

    let sig = create_policy_signature(
        &env,
        &agent_kp,
        &merchant_kp,
        &payload,
        &challenge_hash,
        &nonce,
        expiry,
    );

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig,
        &vec![&env],
    );

    assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
}

#[test]
fn test_invalid_merchant_signature() {
    let (env, client, _owner_kp, agent_kp, _merchant_kp) = setup_env();

    let fake_merchant = generate_keypair();
    // Use the real merchant's pubkey but sign with the fake one
    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    let agent_sig: BytesN<64> = agent_kp
        .sign(payload.to_array().as_slice())
        .to_bytes()
        .into_val(&env);

    // Sign with fake merchant but use real merchant pubkey
    let merchant_sig: BytesN<64> = fake_merchant
        .sign(challenge_hash.to_array().as_slice())
        .to_bytes()
        .into_val(&env);

    let merchant_pub: BytesN<32> = _merchant_kp.public.to_bytes().into_val(&env);

    let policy_sig = PolicySignature {
        agent_signature: agent_sig,
        merchant_pubkey: merchant_pub,
        merchant_signature: merchant_sig,
        challenge_hash: challenge_hash.clone(),
        intent_hash: challenge_hash.clone(),
        nonce,
        expiry: 2000,
    };

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        policy_sig.into_val(&env),
        &vec![&env],
    );

    assert!(result.is_err());
}

#[test]
fn test_challenge_intent_mismatch() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let intent_hash = BytesN::random(&env); // different!
    let nonce = BytesN::random(&env);

    let agent_sig: BytesN<64> = agent_kp
        .sign(payload.to_array().as_slice())
        .to_bytes()
        .into_val(&env);

    let merchant_sig: BytesN<64> = merchant_kp
        .sign(challenge_hash.to_array().as_slice())
        .to_bytes()
        .into_val(&env);

    let merchant_pub: BytesN<32> = merchant_kp.public.to_bytes().into_val(&env);

    let policy_sig = PolicySignature {
        agent_signature: agent_sig,
        merchant_pubkey: merchant_pub,
        merchant_signature: merchant_sig,
        challenge_hash,
        intent_hash,
        nonce,
        expiry: 2000,
    };

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        policy_sig.into_val(&env),
        &vec![&env],
    );

    assert!(result.is_err());
}

#[test]
fn test_nonce_replay() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    // First call should succeed
    let sig1 = create_policy_signature(
        &env,
        &agent_kp,
        &merchant_kp,
        &payload,
        &challenge_hash,
        &nonce,
        2000,
    );

    let result1 = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig1,
        &vec![&env],
    );
    assert!(result1.is_ok());

    // Second call with same nonce should fail
    let payload2 = BytesN::random(&env);
    let challenge_hash2 = BytesN::random(&env);
    let sig2 = create_policy_signature(
        &env,
        &agent_kp,
        &merchant_kp,
        &payload2,
        &challenge_hash2,
        &nonce, // same nonce!
        2000,
    );

    let result2 = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload2,
        sig2,
        &vec![&env],
    );
    assert!(result2.is_err());
}

#[test]
fn test_expired_challenge() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    // Set expiry in the past (ledger timestamp is 1000)
    let sig = create_policy_signature(
        &env,
        &agent_kp,
        &merchant_kp,
        &payload,
        &challenge_hash,
        &nonce,
        500, // expired
    );

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig,
        &vec![&env],
    );

    assert!(result.is_err());
}

#[test]
fn test_unauthorized_merchant() {
    let (env, client, _owner_kp, agent_kp, _merchant_kp) = setup_env();

    // Use a merchant that's not in the allowlist
    let unknown_merchant = generate_keypair();

    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    let agent_sig: BytesN<64> = agent_kp
        .sign(payload.to_array().as_slice())
        .to_bytes()
        .into_val(&env);

    let merchant_pub: BytesN<32> = unknown_merchant.public.to_bytes().into_val(&env);
    let merchant_sig: BytesN<64> = unknown_merchant
        .sign(challenge_hash.to_array().as_slice())
        .to_bytes()
        .into_val(&env);

    let policy_sig = PolicySignature {
        agent_signature: agent_sig,
        merchant_pubkey: merchant_pub,
        merchant_signature: merchant_sig,
        challenge_hash: challenge_hash.clone(),
        intent_hash: challenge_hash.clone(),
        nonce,
        expiry: 2000,
    };

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        policy_sig.into_val(&env),
        &vec![&env],
    );

    assert!(result.is_err());
}

#[test]
fn test_frozen_account() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    // Freeze the account
    client.freeze_payments();

    assert!(client.is_frozen());

    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    let sig = create_policy_signature(
        &env,
        &agent_kp,
        &merchant_kp,
        &payload,
        &challenge_hash,
        &nonce,
        2000,
    );

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig,
        &vec![&env],
    );

    assert!(result.is_err());
}

#[test]
fn test_freeze_restore_cycle() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    // Freeze
    client.freeze_payments();
    assert!(client.is_frozen());

    // Restore
    client.restore_payments();
    assert!(!client.is_frozen());

    // Should work after restore
    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    let sig = create_policy_signature(
        &env,
        &agent_kp,
        &merchant_kp,
        &payload,
        &challenge_hash,
        &nonce,
        2000,
    );

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig,
        &vec![&env],
    );

    assert!(result.is_ok());
}

#[test]
fn test_revoked_signer() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    // Revoke the agent signer
    client.revoke_agent_signer();

    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    let sig = create_policy_signature(
        &env,
        &agent_kp,
        &merchant_kp,
        &payload,
        &challenge_hash,
        &nonce,
        2000,
    );

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig,
        &vec![&env],
    );

    assert!(result.is_err());
}

#[test]
fn test_velocity_auto_freeze() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    // Update velocity to very low limit
    let strict_config = VelocityConfig {
        max_tx_count: 2,
        max_total_amount: 100_000_000_000,
        window_size: 86400,
    };
    client.update_velocity_config(&strict_config);

    // Create a fake token contract address for auth context
    let token_addr = Address::generate(&env);
    let recipient_addr = Address::generate(&env);
    let amount: i128 = 1_000_000_000; // 100 USDC

    // Make 3 payments (velocity limit is 2)
    for i in 0..3 {
        let payload = BytesN::random(&env);
        let challenge_hash = BytesN::random(&env);
        let nonce = BytesN::random(&env);

        let sig = create_policy_signature(
            &env,
            &agent_kp,
            &merchant_kp,
            &payload,
            &challenge_hash,
            &nonce,
            2000,
        );

        // Build auth context with a transfer call
        let transfer_context = Context::Contract(ContractContext {
            contract: token_addr.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![
                &env,
                client.address.clone().into_val(&env),
                recipient_addr.clone().into_val(&env),
                amount.into_val(&env),
            ],
        });

        let result = env.try_invoke_contract_check_auth::<Error>(
            &client.address,
            &payload,
            sig,
            &vec![&env, transfer_context],
        );

        if i < 2 {
            // First 2 payments should succeed (max_tx_count=2)
            assert!(result.is_ok(), "Payment {} should succeed", i);
        } else {
            // 3rd payment should fail (account frozen after 2nd tx)
            assert!(result.is_err(), "Payment {} should fail (frozen)", i);
        }
    }

    // Account should be frozen after hitting velocity limit
    assert!(client.is_frozen());
}

#[test]
fn test_set_new_agent_signer() {
    let (env, client, _owner_kp, _agent_kp, merchant_kp) = setup_env();

    let new_agent = generate_keypair();
    let new_pub: BytesN<32> = new_agent.public.to_bytes().into_val(&env);
    client.set_agent_signer(&new_pub);

    // New signer should work
    let payload = BytesN::random(&env);
    let challenge_hash = BytesN::random(&env);
    let nonce = BytesN::random(&env);

    let sig = create_policy_signature(
        &env,
        &new_agent,
        &merchant_kp,
        &payload,
        &challenge_hash,
        &nonce,
        2000,
    );

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig,
        &vec![&env],
    );

    assert!(result.is_ok());
}

#[test]
fn test_query_functions() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

    let agent_pub: BytesN<32> = agent_kp.public.to_bytes().into_val(&env);
    let merchant_pub: BytesN<32> = merchant_kp.public.to_bytes().into_val(&env);

    assert!(!client.is_frozen());
    assert_eq!(client.get_agent_signer(), agent_pub);
    assert!(client.is_merchant(&merchant_pub));

    let unknown_pub = BytesN::random(&env);
    assert!(!client.is_merchant(&unknown_pub));
}
