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

use crate::crypto::CHALLENGE_DOMAIN;
use crate::types::{AgentSignature, PasskeySignature, PolicySignature, VelocityConfig};
use crate::{PaymentPolicyContract, PaymentPolicyContractClient};

/// The ledger these tests run against reports this network id, and the
/// merchant has to sign against the same value for a challenge to verify.
const TEST_NETWORK_ID: [u8; 32] = [0u8; 32];

fn generate_keypair() -> Keypair {
    Keypair::generate(&mut thread_rng())
}

fn random_bytes(env: &Env) -> [u8; 32] {
    BytesN::<32>::random(env).to_array()
}

// ── Passkey helpers ───────────────────────────────────────────────

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

// ── Payment helpers ───────────────────────────────────────────────

/// The settlement terms a merchant and an agent agree on.
struct Payment {
    request_digest: [u8; 32],
    recipient: Address,
    asset: Address,
    amount: i128,
    nonce: [u8; 32],
    expiry: u64,
}

fn address_strkey(address: &Address) -> [u8; 56] {
    let text = address.to_string();
    let mut buf = [0u8; 56];
    text.copy_into_slice(&mut buf);
    buf
}

/// The off chain mirror of crypto::settlement_preimage. Keeping an
/// independent implementation here is deliberate: if the two ever drift, the
/// merchant signature stops verifying and the tests say so.
fn settlement_preimage(payment: &Payment, network_id: &[u8; 32]) -> std::vec::Vec<u8> {
    let mut out = std::vec::Vec::new();
    out.extend_from_slice(&payment.request_digest);
    out.extend_from_slice(&address_strkey(&payment.recipient));
    out.extend_from_slice(&address_strkey(&payment.asset));
    out.extend_from_slice(&payment.amount.to_be_bytes());
    out.extend_from_slice(network_id);
    out.extend_from_slice(&payment.nonce);
    out.extend_from_slice(&payment.expiry.to_be_bytes());
    out
}

fn domain_hash(domain: &str, data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([domain.len() as u8]);
    hasher.update(domain.as_bytes());
    hasher.update(data);
    hasher.finalize().into()
}

fn challenge_hash(payment: &Payment, network_id: &[u8; 32]) -> [u8; 32] {
    domain_hash(CHALLENGE_DOMAIN, &settlement_preimage(payment, network_id))
}

fn create_agent_signature(
    env: &Env,
    agent_kp: &Keypair,
    merchant_kp: &Keypair,
    payload: &BytesN<32>,
    payment: &Payment,
) -> Val {
    create_agent_signature_on_network(
        env,
        agent_kp,
        merchant_kp,
        payload,
        payment,
        &TEST_NETWORK_ID,
    )
}

fn create_agent_signature_on_network(
    env: &Env,
    agent_kp: &Keypair,
    merchant_kp: &Keypair,
    payload: &BytesN<32>,
    payment: &Payment,
    network_id: &[u8; 32],
) -> Val {
    let agent_sig: BytesN<64> = agent_kp
        .sign(payload.to_array().as_slice())
        .to_bytes()
        .into_val(env);

    let merchant_sig: BytesN<64> = merchant_kp
        .sign(&challenge_hash(payment, network_id))
        .to_bytes()
        .into_val(env);

    let agent = AgentSignature {
        agent_signature: agent_sig,
        merchant_pubkey: merchant_kp.public.to_bytes().into_val(env),
        merchant_signature: merchant_sig,
        request_digest: BytesN::from_array(env, &payment.request_digest),
        recipient: payment.recipient.clone(),
        asset: payment.asset.clone(),
        amount: payment.amount,
        nonce: BytesN::from_array(env, &payment.nonce),
        expiry: payment.expiry,
    };

    PolicySignature::Agent(agent).into_val(env)
}

/// The authorization context Soroban builds when the account transfers a
/// token to the merchant.
fn transfer_context(env: &Env, from: &Address, payment: &Payment) -> Vec<Context> {
    transfer_context_with(env, from, &payment.asset, &payment.recipient, payment.amount)
}

fn transfer_context_with(
    env: &Env,
    from: &Address,
    asset: &Address,
    to: &Address,
    amount: i128,
) -> Vec<Context> {
    vec![
        env,
        Context::Contract(ContractContext {
            contract: asset.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![
                env,
                from.into_val(env),
                to.into_val(env),
                amount.into_val(env),
            ],
        }),
    ]
}

struct Fixture {
    env: Env,
    client: PaymentPolicyContractClient<'static>,
    agent_kp: Keypair,
    merchant_kp: Keypair,
    asset: Address,
    recipient: Address,
}

impl Fixture {
    fn payment(&self) -> Payment {
        Payment {
            request_digest: random_bytes(&self.env),
            recipient: self.recipient.clone(),
            asset: self.asset.clone(),
            amount: 1_000_000,
            nonce: random_bytes(&self.env),
            expiry: 2000,
        }
    }

    fn sign(&self, payload: &BytesN<32>, payment: &Payment) -> Val {
        create_agent_signature(
            &self.env,
            &self.agent_kp,
            &self.merchant_kp,
            payload,
            payment,
        )
    }

    fn context(&self, payment: &Payment) -> Vec<Context> {
        transfer_context(&self.env, &self.client.address, payment)
    }

    fn authorize(&self, payload: &BytesN<32>, sig: Val, context: &Vec<Context>) -> bool {
        self.env
            .try_invoke_contract_check_auth::<Error>(&self.client.address, payload, sig, context)
            .is_ok()
    }

    /// Run one complete, well formed payment.
    fn pay(&self, payment: &Payment) -> bool {
        let payload = BytesN::random(&self.env);
        let sig = self.sign(&payload, payment);
        self.authorize(&payload, sig, &self.context(payment))
    }
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let agent_kp = generate_keypair();
    let merchant_kp = generate_keypair();

    let owner_pub = owner_public_key(&env);
    let agent_pub: BytesN<32> = agent_kp.public.to_bytes().into_val(&env);

    let velocity_config = VelocityConfig {
        max_tx_count: 10,
        max_total_amount: 100_000_000_000, // 10,000 USDC at 7 decimals
        window_size: 86400,
    };

    let contract_id = env.register(
        PaymentPolicyContract,
        (&owner_pub, &agent_pub, &velocity_config),
    );
    let client = PaymentPolicyContractClient::new(&env, &contract_id);

    let merchant_pub: BytesN<32> = merchant_kp.public.to_bytes().into_val(&env);
    client.add_merchant(&merchant_pub);

    env.ledger().set(LedgerInfo {
        timestamp: 1000,
        protocol_version: 26,
        sequence_number: 100,
        network_id: TEST_NETWORK_ID,
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 10000,
    });

    let asset = Address::generate(&env);
    let recipient = Address::generate(&env);

    Fixture {
        env,
        client,
        agent_kp,
        merchant_kp,
        asset,
        recipient,
    }
}

// ── Agent authorization path ──────────────────────────────────────

#[test]
fn test_valid_two_party_auth() {
    let f = setup();
    assert!(f.pay(&f.payment()));
}

#[test]
fn test_unauthorized_merchant() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);

    let stranger = generate_keypair();
    let sig = create_agent_signature(&f.env, &f.agent_kp, &stranger, &payload, &payment);

    assert!(!f.authorize(&payload, sig, &f.context(&payment)));
}

#[test]
fn test_invalid_merchant_signature() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);

    // Signed by an impostor, but presented under the allowlisted merchant's
    // public key. This is what a forged challenge looks like on chain.
    let impostor = generate_keypair();
    let sig = create_agent_signature(&f.env, &f.agent_kp, &impostor, &payload, &payment);
    let sig = with_merchant_pubkey(&f.env, sig, &f.merchant_kp);

    assert!(!f.authorize(&payload, sig, &f.context(&payment)));
}

#[test]
fn test_wrong_agent_key_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);

    let impostor = generate_keypair();
    let sig = create_agent_signature(&f.env, &impostor, &f.merchant_kp, &payload, &payment);

    assert!(!f.authorize(&payload, sig, &f.context(&payment)));
}

#[test]
fn test_nonce_replay() {
    let f = setup();
    let payment = f.payment();

    assert!(f.pay(&payment));

    // Everything freshly signed, but the nonce has been seen before.
    let replayed = Payment {
        nonce: payment.nonce,
        ..f.payment()
    };
    assert!(!f.pay(&replayed));
}

#[test]
fn test_expired_challenge() {
    let f = setup();
    let expired = Payment {
        expiry: 500, // the ledger is at 1000
        ..f.payment()
    };
    assert!(!f.pay(&expired));
}

#[test]
fn test_challenge_without_an_expiry_is_rejected() {
    let f = setup();
    let eternal = Payment {
        expiry: 0,
        ..f.payment()
    };
    assert!(!f.pay(&eternal));
}

#[test]
fn test_frozen_account() {
    let f = setup();
    f.client.freeze_payments();
    assert!(f.client.is_frozen());

    assert!(!f.pay(&f.payment()));
}

#[test]
fn test_revoked_signer() {
    let f = setup();
    f.client.revoke_agent_signer();

    assert!(!f.pay(&f.payment()));
}

#[test]
fn test_velocity_auto_freeze() {
    let f = setup();
    f.client.update_velocity_config(&VelocityConfig {
        max_tx_count: 2,
        max_total_amount: 100_000_000_000,
        window_size: 86400,
    });

    assert!(f.pay(&f.payment()));
    assert!(f.pay(&f.payment()));

    // The second payment reached the limit, which freezes the account.
    assert!(f.client.is_frozen());
    assert!(!f.pay(&f.payment()));
}

// ── Settlement binding ────────────────────────────────────────────
// The merchant signs for one specific transfer. These check that the
// transfer actually being authorized is that one and nothing else.

#[test]
fn test_recipient_mismatch_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    let elsewhere = Address::generate(&f.env);
    let context = transfer_context_with(
        &f.env,
        &f.client.address,
        &payment.asset,
        &elsewhere,
        payment.amount,
    );

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_amount_mismatch_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    let context = transfer_context_with(
        &f.env,
        &f.client.address,
        &payment.asset,
        &payment.recipient,
        payment.amount * 1000,
    );

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_asset_mismatch_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    let other_token = Address::generate(&f.env);
    let context = transfer_context_with(
        &f.env,
        &f.client.address,
        &other_token,
        &payment.recipient,
        payment.amount,
    );

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_transfer_must_spend_this_account() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    let someone_else = Address::generate(&f.env);
    let context = transfer_context_with(
        &f.env,
        &someone_else,
        &payment.asset,
        &payment.recipient,
        payment.amount,
    );

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_payment_without_a_transfer_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    assert!(!f.authorize(&payload, sig, &vec![&f.env]));
}

#[test]
fn test_a_second_transfer_cannot_ride_along() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    let elsewhere = Address::generate(&f.env);
    let context = vec![
        &f.env,
        Context::Contract(ContractContext {
            contract: payment.asset.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![
                &f.env,
                f.client.address.into_val(&f.env),
                payment.recipient.into_val(&f.env),
                payment.amount.into_val(&f.env),
            ],
        }),
        Context::Contract(ContractContext {
            contract: payment.asset.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![
                &f.env,
                f.client.address.into_val(&f.env),
                elsewhere.into_val(&f.env),
                payment.amount.into_val(&f.env),
            ],
        }),
    ];

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_challenge_signed_for_another_network_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);

    let other_network = [9u8; 32];
    let sig = create_agent_signature_on_network(
        &f.env,
        &f.agent_kp,
        &f.merchant_kp,
        &payload,
        &payment,
        &other_network,
    );

    assert!(!f.authorize(&payload, sig, &f.context(&payment)));
}

#[test]
fn test_tampered_request_digest_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);

    // The merchant signed one paid request, the agent presents another.
    let sig = f.sign(&payload, &payment);
    let sig = with_request_digest(&f.env, sig, &random_bytes(&f.env));

    assert!(!f.authorize(&payload, sig, &f.context(&payment)));
}

// ── Owner authorization path ──────────────────────────────────────
// These exercise __check_auth directly rather than going through
// mock_all_auths, so they prove what the owner key actually gates.

#[test]
fn test_owner_can_freeze_with_passkey() {
    let f = setup();
    let payload = BytesN::random(&f.env);
    let sig = create_owner_signature(&f.env, &payload, true);
    let context = owner_context(&f.env, &f.client.address, "freeze_payments");

    assert!(f.authorize(&payload, sig, &context));
}

#[test]
fn test_owner_can_restore_a_frozen_account() {
    let f = setup();
    f.client.freeze_payments();
    assert!(f.client.is_frozen());

    // The frozen flag must not block the owner, otherwise freezing the
    // account would lock the owner out of unfreezing it.
    let payload = BytesN::random(&f.env);
    let sig = create_owner_signature(&f.env, &payload, true);
    let context = owner_context(&f.env, &f.client.address, "restore_payments");

    assert!(f.authorize(&payload, sig, &context));
}

#[test]
fn test_owner_can_set_a_signer_after_revocation() {
    let f = setup();
    f.client.revoke_agent_signer();

    // With no agent signer left the account would be bricked if owner
    // actions still went through the agent path.
    let payload = BytesN::random(&f.env);
    let sig = create_owner_signature(&f.env, &payload, true);
    let context = owner_context(&f.env, &f.client.address, "set_agent_signer");

    assert!(f.authorize(&payload, sig, &context));
}

#[test]
fn test_agent_cannot_authorize_an_owner_action() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);
    let context = owner_context(&f.env, &f.client.address, "revoke_agent_signer");

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_owner_signature_cannot_authorize_a_payment() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = create_owner_signature(&f.env, &payload, true);

    assert!(!f.authorize(&payload, sig, &f.context(&payment)));
}

#[test]
fn test_owner_action_cannot_ride_along_with_a_transfer() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = create_owner_signature(&f.env, &payload, true);

    let context = vec![
        &f.env,
        Context::Contract(ContractContext {
            contract: f.client.address.clone(),
            fn_name: Symbol::new(&f.env, "add_merchant"),
            args: vec![&f.env],
        }),
        Context::Contract(ContractContext {
            contract: payment.asset.clone(),
            fn_name: symbol_short!("transfer"),
            args: vec![
                &f.env,
                f.client.address.into_val(&f.env),
                payment.recipient.into_val(&f.env),
                payment.amount.into_val(&f.env),
            ],
        }),
    ];

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_passkey_requires_user_presence() {
    let f = setup();
    let payload = BytesN::random(&f.env);
    let sig = create_owner_signature(&f.env, &payload, false);
    let context = owner_context(&f.env, &f.client.address, "freeze_payments");

    assert!(!f.authorize(&payload, sig, &context));
}

#[test]
fn test_passkey_assertion_is_bound_to_its_payload() {
    let f = setup();

    // A perfectly valid assertion, but produced for a different challenge.
    let other_challenge = [9u8; 32];
    let sig = create_owner_signature_for_challenge(&f.env, &other_challenge, true);

    let payload = BytesN::random(&f.env);
    let context = owner_context(&f.env, &f.client.address, "freeze_payments");

    assert!(!f.authorize(&payload, sig, &context));
}

// ── Owner functions and queries ───────────────────────────────────

#[test]
fn test_freeze_restore_cycle() {
    let f = setup();

    f.client.freeze_payments();
    assert!(f.client.is_frozen());

    f.client.restore_payments();
    assert!(!f.client.is_frozen());

    assert!(f.pay(&f.payment()));
}

#[test]
fn test_set_new_agent_signer() {
    let f = setup();

    let replacement = generate_keypair();
    let replacement_pub: BytesN<32> = replacement.public.to_bytes().into_val(&f.env);
    f.client.set_agent_signer(&replacement_pub);
    assert_eq!(f.client.get_agent_signer(), replacement_pub);

    // The retired key no longer authorizes anything.
    assert!(!f.pay(&f.payment()));

    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = create_agent_signature(&f.env, &replacement, &f.merchant_kp, &payload, &payment);
    assert!(f.authorize(&payload, sig, &f.context(&payment)));
}

#[test]
fn test_query_functions() {
    let f = setup();

    let agent_pub: BytesN<32> = f.agent_kp.public.to_bytes().into_val(&f.env);
    let merchant_pub: BytesN<32> = f.merchant_kp.public.to_bytes().into_val(&f.env);

    assert!(!f.client.is_frozen());
    assert_eq!(f.client.get_agent_signer(), agent_pub);
    assert!(f.client.is_merchant(&merchant_pub));

    let unknown = BytesN::random(&f.env);
    assert!(!f.client.is_merchant(&unknown));
}

// ── Tampering helpers ─────────────────────────────────────────────

fn with_merchant_pubkey(env: &Env, sig: Val, merchant_kp: &Keypair) -> Val {
    match sig.into_val(env) {
        PolicySignature::Agent(agent) => PolicySignature::Agent(AgentSignature {
            merchant_pubkey: merchant_kp.public.to_bytes().into_val(env),
            ..agent
        })
        .into_val(env),
        other => other.into_val(env),
    }
}

fn with_request_digest(env: &Env, sig: Val, digest: &[u8; 32]) -> Val {
    match sig.into_val(env) {
        PolicySignature::Agent(agent) => PolicySignature::Agent(AgentSignature {
            request_digest: BytesN::from_array(env, digest),
            ..agent
        })
        .into_val(env),
        other => other.into_val(env),
    }
}
