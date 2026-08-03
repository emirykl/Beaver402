#![cfg(test)]
extern crate std;

use ed25519_dalek::Keypair;
use ed25519_dalek::Signer;
use p256::ecdsa::signature::hazmat::PrehashSigner;
use p256::ecdsa::{Signature as P256Signature, SigningKey, VerifyingKey};
use rand::thread_rng;
use sha2::{Digest, Sha256};
use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::{Address as _, BytesN as _, Ledger, LedgerInfo},
    vec, Address, Bytes, BytesN, Env, Error, IntoVal, Symbol, Val, Vec,
};

use crate::types::{AgentSignature, PasskeySignature, PolicySignature, VelocityConfig};
use crate::{PaymentPolicyContract, PaymentPolicyContractClient};

fn generate_keypair() -> Keypair {
    Keypair::generate(&mut thread_rng())
}

/// A deterministic passkey. Tests need the same owner key every run so the
/// stored owner and the signing key always agree.
fn owner_signing_key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
}

fn owner_public_key(env: &Env) -> BytesN<65> {
    let verifying = VerifyingKey::from(&owner_signing_key());
    let encoded = verifying.to_encoded_point(false);
    let bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
    BytesN::from_array(env, &bytes)
}

fn base64url(input: &[u8]) -> std::string::String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = std::string::String::new();
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        }
    }
    out
}

/// Build the same assertion a browser authenticator would hand back for this
/// payload, so the owner tests exercise the real verification path.
fn create_owner_signature(env: &Env, payload: &BytesN<32>, user_present: bool) -> Val {
    create_owner_signature_for_challenge(env, &payload.to_array(), user_present)
}

fn create_owner_signature_for_challenge(
    env: &Env,
    challenge: &[u8; 32],
    user_present: bool,
) -> Val {
    let client_data = std::format!(
        "{{\"type\":\"webauthn.get\",\"challenge\":\"{}\",\"origin\":\"http://localhost:5173\",\"crossOrigin\":false}}",
        base64url(challenge)
    );
    let client_data_bytes = client_data.as_bytes();

    // 32 byte rpIdHash, then flags, then a four byte counter.
    let mut authenticator_data = std::vec![0u8; 37];
    authenticator_data[32] = if user_present { 0x05 } else { 0x04 };
    authenticator_data[36] = 1;

    let mut client_data_hash = Sha256::new();
    client_data_hash.update(client_data_bytes);
    let client_data_hash = client_data_hash.finalize();

    let mut digest = Sha256::new();
    digest.update(&authenticator_data);
    digest.update(client_data_hash);
    let digest = digest.finalize();

    let signature: P256Signature = owner_signing_key().sign_prehash(&digest).unwrap();
    let signature = signature.normalize_s().unwrap_or(signature);

    let passkey = PasskeySignature {
        authenticator_data: Bytes::from_slice(env, &authenticator_data),
        client_data_json: Bytes::from_slice(env, client_data_bytes),
        signature: BytesN::from_array(env, &signature.to_bytes().into()),
    };

    PolicySignature::Owner(passkey).into_val(env)
}

/// The authorization context Soroban builds when the owner calls one of the
/// account's own administrative functions.
fn owner_context(env: &Env, contract: &Address, function: &str) -> Vec<Context> {
    vec![
        env,
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(env, function),
            args: vec![env],
        }),
    ]
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

    let agent = AgentSignature {
        agent_signature: agent_sig,
        merchant_pubkey,
        merchant_signature: merchant_sig,
        challenge_hash: challenge_hash.clone(),
        intent_hash: challenge_hash.clone(), // matching = valid PoI
        nonce: nonce.clone(),
        expiry,
    };

    PolicySignature::Agent(agent).into_val(env)
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

    let owner_pub = owner_public_key(&env);
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

    let policy_sig = PolicySignature::Agent(AgentSignature {
        agent_signature: agent_sig,
        merchant_pubkey: merchant_pub,
        merchant_signature: merchant_sig,
        challenge_hash: challenge_hash.clone(),
        intent_hash: challenge_hash.clone(),
        nonce,
        expiry: 2000,
    });

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

    let policy_sig = PolicySignature::Agent(AgentSignature {
        agent_signature: agent_sig,
        merchant_pubkey: merchant_pub,
        merchant_signature: merchant_sig,
        challenge_hash,
        intent_hash,
        nonce,
        expiry: 2000,
    });

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

    let policy_sig = PolicySignature::Agent(AgentSignature {
        agent_signature: agent_sig,
        merchant_pubkey: merchant_pub,
        merchant_signature: merchant_sig,
        challenge_hash: challenge_hash.clone(),
        intent_hash: challenge_hash.clone(),
        nonce,
        expiry: 2000,
    });

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

// ── Owner authorization path ──────────────────────────────────────
// These exercise __check_auth directly rather than going through
// mock_all_auths, so they prove what the owner key actually gates.

#[test]
fn test_owner_can_freeze_with_passkey() {
    let (env, client, _owner_kp, _agent_kp, _merchant_kp) = setup_env();

    let payload = BytesN::random(&env);
    let sig = create_owner_signature(&env, &payload, true);
    let context = owner_context(&env, &client.address, "freeze_payments");

    let result =
        env.try_invoke_contract_check_auth::<Error>(&client.address, &payload, sig, &context);

    assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
}

#[test]
fn test_owner_can_restore_a_frozen_account() {
    let (env, client, _owner_kp, _agent_kp, _merchant_kp) = setup_env();

    client.freeze_payments();
    assert!(client.is_frozen());

    // The frozen flag must not block the owner, otherwise freezing the
    // account would lock the owner out of unfreezing it.
    let payload = BytesN::random(&env);
    let sig = create_owner_signature(&env, &payload, true);
    let context = owner_context(&env, &client.address, "restore_payments");

    let result =
        env.try_invoke_contract_check_auth::<Error>(&client.address, &payload, sig, &context);

    assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
}

#[test]
fn test_owner_can_set_a_signer_after_revocation() {
    let (env, client, _owner_kp, _agent_kp, _merchant_kp) = setup_env();

    client.revoke_agent_signer();

    // With no agent signer left the account would be bricked if owner
    // actions still went through the agent path.
    let payload = BytesN::random(&env);
    let sig = create_owner_signature(&env, &payload, true);
    let context = owner_context(&env, &client.address, "set_agent_signer");

    let result =
        env.try_invoke_contract_check_auth::<Error>(&client.address, &payload, sig, &context);

    assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
}

#[test]
fn test_agent_cannot_authorize_an_owner_action() {
    let (env, client, _owner_kp, agent_kp, merchant_kp) = setup_env();

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
    let context = owner_context(&env, &client.address, "revoke_agent_signer");

    let result =
        env.try_invoke_contract_check_auth::<Error>(&client.address, &payload, sig, &context);

    assert!(result.is_err());
}

#[test]
fn test_owner_signature_cannot_authorize_a_payment() {
    let (env, client, _owner_kp, _agent_kp, _merchant_kp) = setup_env();

    let payload = BytesN::random(&env);
    let sig = create_owner_signature(&env, &payload, true);

    let result = env.try_invoke_contract_check_auth::<Error>(
        &client.address,
        &payload,
        sig,
        &vec![&env],
    );

    assert!(result.is_err());
}

#[test]
fn test_owner_action_cannot_ride_along_with_a_transfer() {
    let (env, client, _owner_kp, _agent_kp, _merchant_kp) = setup_env();

    let token = Address::generate(&env);
    let payload = BytesN::random(&env);
    let sig = create_owner_signature(&env, &payload, true);

    let context = vec![
        &env,
        Context::Contract(ContractContext {
            contract: client.address.clone(),
            fn_name: Symbol::new(&env, "add_merchant"),
            args: vec![&env],
        }),
        Context::Contract(ContractContext {
            contract: token,
            fn_name: symbol_short!("transfer"),
            args: vec![&env, 1000i128.into_val(&env)],
        }),
    ];

    let result =
        env.try_invoke_contract_check_auth::<Error>(&client.address, &payload, sig, &context);

    assert!(result.is_err());
}

#[test]
fn test_passkey_requires_user_presence() {
    let (env, client, _owner_kp, _agent_kp, _merchant_kp) = setup_env();

    let payload = BytesN::random(&env);
    let sig = create_owner_signature(&env, &payload, false);
    let context = owner_context(&env, &client.address, "freeze_payments");

    let result =
        env.try_invoke_contract_check_auth::<Error>(&client.address, &payload, sig, &context);

    assert!(result.is_err());
}

#[test]
fn test_passkey_assertion_is_bound_to_its_payload() {
    let (env, client, _owner_kp, _agent_kp, _merchant_kp) = setup_env();

    // A perfectly valid assertion, but produced for a different challenge.
    let other_challenge = [9u8; 32];
    let sig = create_owner_signature_for_challenge(&env, &other_challenge, true);

    let payload = BytesN::random(&env);
    let context = owner_context(&env, &client.address, "freeze_payments");

    let result =
        env.try_invoke_contract_check_auth::<Error>(&client.address, &payload, sig, &context);

    assert!(result.is_err());
}
