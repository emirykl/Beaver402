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
    testutils::{
        storage::Instance as _,
        Address as _, BytesN as _, Events as _, Ledger, LedgerInfo,
    },
    token::{StellarAssetClient, TokenClient},
    vec,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Error, Event as _, IntoVal, Symbol, Val, Vec,
};

use crate::crypto::{CHALLENGE_DOMAIN, INTENT_DOMAIN};
use crate::errors::PolicyError;
use crate::events::{FundsRecovered, LimitsReduced, PaymentsFrozen, ProofOfIntent};
use crate::lifetime::{EXTENSION_STEP, INSTANCE_LIFETIME};
use crate::types::{
    AgentSignature, DataKey, PasskeySignature, PaymentRecord, PolicySignature, VelocityConfig,
};
use crate::{PaymentPolicyContract, PaymentPolicyContractClient, MAX_CHALLENGE_LIFETIME};

/// The ledger these tests run against reports this network id, and the
/// merchant has to sign against the same value for a challenge to verify.
const TEST_NETWORK_ID: [u8; 32] = [0u8; 32];

/// The domain the owner passkey belongs to in these tests.
const RP_ID: &str = "beaver402.test";

/// Stellar USDC has seven decimals.
const USDC: i128 = 10_000_000;

/// The ledger time every test starts at.
const START: u64 = 1000;

/// The mainnet pilot limits.
fn pilot_limits() -> VelocityConfig {
    VelocityConfig {
        max_payment_amount: USDC,
        max_tx_count: 5,
        max_total_amount: 5 * USDC,
        window_size: 86_400,
    }
}

fn generate_keypair() -> Keypair {
    Keypair::generate(&mut thread_rng())
}

fn random_bytes(env: &Env) -> [u8; 32] {
    BytesN::<32>::random(env).to_array()
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().into()
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

/// What a browser authenticator would hand back. Each field can be bent to
/// show what the contract refuses.
struct Assertion {
    challenge: [u8; 32],
    rp_id: &'static str,
    flags: u8,
    kind: &'static str,
}

/// User present and user verified.
const PRESENT_AND_VERIFIED: u8 = 0x05;

impl Assertion {
    fn for_payload(payload: &BytesN<32>) -> Self {
        Assertion {
            challenge: payload.to_array(),
            rp_id: RP_ID,
            flags: PRESENT_AND_VERIFIED,
            kind: "webauthn.get",
        }
    }

    fn sign(&self, env: &Env) -> Val {
        let client_data = std::format!(
            "{{\"type\":\"{}\",\"challenge\":\"{}\",\"origin\":\"https://{}\",\"crossOrigin\":false}}",
            self.kind,
            base64url(&self.challenge),
            self.rp_id
        );
        let client_data_bytes = client_data.as_bytes();

        // 32 byte rpIdHash, then flags, then a four byte counter.
        let mut authenticator_data = std::vec::Vec::new();
        authenticator_data.extend_from_slice(&sha256(self.rp_id.as_bytes()));
        authenticator_data.push(self.flags);
        authenticator_data.extend_from_slice(&[0, 0, 0, 1]);

        let mut digest = Sha256::new();
        digest.update(&authenticator_data);
        digest.update(sha256(client_data_bytes));
        let digest = digest.finalize();

        let signature: P256Signature = owner_signing_key().sign_prehash(&digest).unwrap();
        let signature = signature.normalize_s().unwrap_or(signature);

        PolicySignature::Owner(PasskeySignature {
            authenticator_data: Bytes::from_slice(env, &authenticator_data),
            client_data_json: Bytes::from_slice(env, client_data_bytes),
            signature: BytesN::from_array(env, &signature.to_bytes().into()),
        })
        .into_val(env)
    }
}

fn create_owner_signature(env: &Env, payload: &BytesN<32>) -> Val {
    Assertion::for_payload(payload).sign(env)
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
#[derive(Clone)]
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

fn intent_hash(payment: &Payment) -> [u8; 32] {
    domain_hash(INTENT_DOMAIN, &settlement_preimage(payment, &TEST_NETWORK_ID))
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
    recovery: Address,
}

impl Fixture {
    fn payment(&self) -> Payment {
        Payment {
            request_digest: random_bytes(&self.env),
            recipient: self.recipient.clone(),
            asset: self.asset.clone(),
            amount: USDC / 10,
            nonce: random_bytes(&self.env),
            expiry: self.env.ledger().timestamp() + 300,
        }
    }

    fn payment_of(&self, amount: i128) -> Payment {
        Payment {
            amount,
            ..self.payment()
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

    fn try_authorize(
        &self,
        payload: &BytesN<32>,
        sig: Val,
        context: &Vec<Context>,
    ) -> Result<(), PolicyError> {
        match self.env.try_invoke_contract_check_auth::<PolicyError>(
            &self.client.address,
            payload,
            sig,
            context,
        ) {
            Ok(()) => Ok(()),
            Err(Ok(policy_error)) => Err(policy_error),
            // A trap, such as a signature that does not verify, has no
            // policy code. InvalidSignatureFormat stands in for it here.
            Err(Err(_)) => Err(PolicyError::InvalidSignatureFormat),
        }
    }

    fn authorize(&self, payload: &BytesN<32>, sig: Val, context: &Vec<Context>) -> bool {
        self.env
            .try_invoke_contract_check_auth::<Error>(&self.client.address, payload, sig, context)
            .is_ok()
    }

    /// Run one complete, well formed payment and report the policy's verdict.
    fn try_pay(&self, payment: &Payment) -> Result<(), PolicyError> {
        let payload = BytesN::random(&self.env);
        let sig = self.sign(&payload, payment);
        self.try_authorize(&payload, sig, &self.context(payment))
    }

    fn pay(&self, payment: &Payment) -> bool {
        self.try_pay(payment).is_ok()
    }

    fn owner_may(&self, function: &str) -> Result<(), PolicyError> {
        let payload = BytesN::random(&self.env);
        let sig = create_owner_signature(&self.env, &payload);
        let context = owner_context(&self.env, &self.client.address, function);
        self.try_authorize(&payload, sig, &context)
    }

    fn advance(&self, seconds: u64) {
        let mut info = self.env.ledger().get();
        info.timestamp += seconds;
        info.sequence_number += (seconds / 5) as u32;
        self.env.ledger().set(info);
    }

    fn advance_ledgers(&self, ledgers: u32) {
        let mut info = self.env.ledger().get();
        info.sequence_number += ledgers;
        info.timestamp += ledgers as u64 * 5;
        self.env.ledger().set(info);
    }

    fn instance_ttl(&self) -> u32 {
        self.env
            .as_contract(&self.client.address, || self.env.storage().instance().get_ttl())
    }

    /// How many bytes the velocity window takes up in storage.
    fn window_size_in_bytes(&self) -> u32 {
        self.env.as_contract(&self.client.address, || {
            let slots: Vec<PaymentRecord> = self
                .env
                .storage()
                .instance()
                .get(&DataKey::Payments)
                .unwrap();
            slots.to_xdr(&self.env).len()
        })
    }

    fn balance(&self, address: &Address) -> i128 {
        TokenClient::new(&self.env, &self.asset).balance(address)
    }
}

fn setup() -> Fixture {
    setup_with(pilot_limits())
}

fn setup_with(limits: VelocityConfig) -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    env.ledger().set(LedgerInfo {
        timestamp: START,
        protocol_version: 28,
        sequence_number: 100,
        network_id: TEST_NETWORK_ID,
        base_reserve: 10,
        min_temp_entry_ttl: 100,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 3_110_400,
    });

    let agent_kp = generate_keypair();
    let merchant_kp = generate_keypair();

    let owner_pub = owner_public_key(&env);
    let rp_id_hash = BytesN::from_array(&env, &sha256(RP_ID.as_bytes()));
    let agent_pub: BytesN<32> = agent_kp.public.to_bytes().into_val(&env);

    let issuer = Address::generate(&env);
    let asset = env.register_stellar_asset_contract_v2(issuer).address();
    let recovery = Address::generate(&env);
    let recipient = Address::generate(&env);

    let contract_id = env.register(
        PaymentPolicyContract,
        (&owner_pub, &rp_id_hash, &agent_pub, &asset, &recovery, &limits),
    );
    let client = PaymentPolicyContractClient::new(&env, &contract_id);

    let merchant_pub: BytesN<32> = merchant_kp.public.to_bytes().into_val(&env);
    client.add_merchant(&merchant_pub);

    StellarAssetClient::new(&env, &asset).mint(&contract_id, &(5 * USDC));

    Fixture {
        env,
        client,
        agent_kp,
        merchant_kp,
        asset,
        recipient,
        recovery,
    }
}

// ── Creating the account ──────────────────────────────────────────

#[test]
fn test_account_is_created_with_its_fixed_parameters() {
    let f = setup();

    assert_eq!(f.client.get_asset(), f.asset);
    assert_eq!(f.client.get_recovery(), f.recovery);
    assert_eq!(f.client.get_velocity_config(), pilot_limits());
    assert!(!f.client.is_frozen());
}

#[test]
#[should_panic]
fn test_account_refuses_a_limit_of_zero() {
    setup_with(VelocityConfig {
        max_payment_amount: 0,
        ..pilot_limits()
    });
}

#[test]
#[should_panic]
fn test_account_refuses_a_per_payment_limit_above_the_total() {
    setup_with(VelocityConfig {
        max_payment_amount: 6 * USDC,
        ..pilot_limits()
    });
}

#[test]
#[should_panic]
fn test_account_refuses_more_payments_than_it_can_track() {
    setup_with(VelocityConfig {
        max_tx_count: 17,
        ..pilot_limits()
    });
}

#[test]
#[should_panic]
fn test_account_refuses_a_window_shorter_than_a_challenge_can_live() {
    // A slot remembers a nonce only while its payment is in the window, so a
    // shorter window would let a still valid challenge be replayed.
    setup_with(VelocityConfig {
        window_size: MAX_CHALLENGE_LIFETIME - 1,
        ..pilot_limits()
    });
}

// ── Agent authorization path ──────────────────────────────────────

#[test]
fn test_valid_two_party_auth() {
    let f = setup();
    assert_eq!(f.try_pay(&f.payment()), Ok(()));
}

#[test]
fn test_unauthorized_merchant() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);

    let stranger = generate_keypair();
    let sig = create_agent_signature(&f.env, &f.agent_kp, &stranger, &payload, &payment);

    assert_eq!(
        f.try_authorize(&payload, sig, &f.context(&payment)),
        Err(PolicyError::UnauthorizedMerchant)
    );
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
    assert_eq!(f.try_pay(&replayed), Err(PolicyError::NonceReused));
}

#[test]
fn test_expired_challenge() {
    let f = setup();
    let expired = Payment {
        expiry: START - 1,
        ..f.payment()
    };
    assert_eq!(f.try_pay(&expired), Err(PolicyError::ChallengeExpired));
}

#[test]
fn test_challenge_without_an_expiry_is_rejected() {
    let f = setup();
    let eternal = Payment {
        expiry: 0,
        ..f.payment()
    };
    assert_eq!(f.try_pay(&eternal), Err(PolicyError::ChallengeExpired));
}

#[test]
fn test_challenge_may_live_for_the_maximum_and_no_longer() {
    let f = setup();

    let longest = Payment {
        expiry: START + MAX_CHALLENGE_LIFETIME,
        ..f.payment()
    };
    assert_eq!(f.try_pay(&longest), Ok(()));

    let too_long = Payment {
        expiry: START + MAX_CHALLENGE_LIFETIME + 1,
        ..f.payment()
    };
    assert_eq!(f.try_pay(&too_long), Err(PolicyError::ExpiryTooFar));
}

#[test]
fn test_frozen_account() {
    let f = setup();
    f.client.freeze_payments();
    assert!(f.client.is_frozen());

    assert_eq!(f.try_pay(&f.payment()), Err(PolicyError::AccountFrozen));
}

#[test]
fn test_revoked_signer() {
    let f = setup();
    f.client.revoke_agent_signer();

    assert_eq!(f.try_pay(&f.payment()), Err(PolicyError::SignerRevoked));
}

// ── Amounts and the asset ─────────────────────────────────────────

#[test]
fn test_a_payment_of_zero_is_refused() {
    let f = setup();
    assert_eq!(f.try_pay(&f.payment_of(0)), Err(PolicyError::InvalidAmount));
}

#[test]
fn test_a_negative_payment_is_refused() {
    let f = setup();
    assert_eq!(f.try_pay(&f.payment_of(-1)), Err(PolicyError::InvalidAmount));
}

#[test]
fn test_a_payment_up_to_the_per_payment_limit_is_allowed() {
    let f = setup();
    assert_eq!(f.try_pay(&f.payment_of(USDC)), Ok(()));
}

#[test]
fn test_a_payment_over_the_per_payment_limit_is_refused() {
    let f = setup();
    assert_eq!(
        f.try_pay(&f.payment_of(USDC + 1)),
        Err(PolicyError::PaymentLimitExceeded)
    );
}

#[test]
fn test_a_payment_in_another_token_is_refused() {
    let f = setup();

    // The merchant signed for another token and the transfer really is in
    // that token, so everything agrees except the account's own asset.
    let other_token = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    let payment = Payment {
        asset: other_token,
        ..f.payment()
    };

    assert_eq!(f.try_pay(&payment), Err(PolicyError::AssetNotAllowed));
}

// ── Velocity ──────────────────────────────────────────────────────

#[test]
fn test_payments_up_to_the_count_limit_then_freeze() {
    let f = setup();

    for _ in 0..4 {
        assert_eq!(f.try_pay(&f.payment()), Ok(()));
        assert!(!f.client.is_frozen());
    }

    // The fifth payment fills the window and freezes the account behind it.
    assert_eq!(f.try_pay(&f.payment()), Ok(()));
    assert!(f.client.is_frozen());
    assert_eq!(f.try_pay(&f.payment()), Err(PolicyError::AccountFrozen));
}

#[test]
fn test_the_total_is_never_exceeded_not_even_by_the_payment_that_reaches_it() {
    let f = setup_with(VelocityConfig {
        max_payment_amount: 2 * USDC,
        max_tx_count: 10,
        max_total_amount: 5 * USDC,
        window_size: 86_400,
    });

    assert!(f.pay(&f.payment_of(2 * USDC)));
    assert!(f.pay(&f.payment_of(2 * USDC)));

    // 4 + 1.5 would be 5.5, over the limit.
    assert_eq!(
        f.try_pay(&f.payment_of(15 * USDC / 10)),
        Err(PolicyError::VelocityExceeded)
    );
    assert!(!f.client.is_frozen());

    // 4 + 1 lands exactly on it, which is allowed and freezes the account.
    assert_eq!(f.try_pay(&f.payment_of(USDC)), Ok(()));
    assert!(f.client.is_frozen());
    assert_eq!(f.client.get_velocity_state().total_amount, 5 * USDC);
}

#[test]
fn test_restoring_does_not_reset_the_window() {
    let f = setup();

    for _ in 0..5 {
        assert!(f.pay(&f.payment()));
    }
    assert!(f.client.is_frozen());

    f.client.restore_payments();
    assert!(!f.client.is_frozen());

    // The five payments still count, so the budget is still spent.
    assert_eq!(f.try_pay(&f.payment()), Err(PolicyError::VelocityExceeded));
    assert_eq!(f.client.get_velocity_state().tx_count, 5);
}

#[test]
fn test_the_window_slides() {
    let f = setup_with(VelocityConfig {
        max_payment_amount: USDC,
        max_tx_count: 2,
        max_total_amount: 2 * USDC,
        window_size: 1000,
    });

    assert!(f.pay(&f.payment())); // at 1000
    f.advance(50);
    assert!(f.pay(&f.payment())); // at 1050, fills the window
    f.client.restore_payments();

    // At 1999 both payments are still inside the last thousand seconds.
    f.advance(949);
    assert_eq!(f.try_pay(&f.payment()), Err(PolicyError::VelocityExceeded));

    // At 2000 the first one has aged out and makes room for exactly one.
    f.advance(1);
    let state = f.client.get_velocity_state();
    assert_eq!(state.tx_count, 1);
    assert_eq!(state.window_start, START + 50);
    assert_eq!(f.try_pay(&f.payment()), Ok(()));
}

#[test]
fn test_a_fixed_window_boundary_does_not_allow_a_burst() {
    // With a fixed window, four payments at the end of one window and four
    // at the start of the next would all go through within seconds. A
    // sliding window counts all of them together.
    let f = setup_with(VelocityConfig {
        max_payment_amount: USDC,
        max_tx_count: 5,
        max_total_amount: 5 * USDC,
        window_size: 86_400,
    });

    f.advance(86_400 - 10);
    for _ in 0..4 {
        assert!(f.pay(&f.payment()));
    }

    f.advance(20);
    assert!(f.pay(&f.payment()));
    assert!(f.client.is_frozen());
    f.client.restore_payments();
    assert_eq!(f.try_pay(&f.payment()), Err(PolicyError::VelocityExceeded));
}

// ── Limits only go down ───────────────────────────────────────────

#[test]
fn test_limits_can_be_reduced() {
    let f = setup();
    let tighter = VelocityConfig {
        max_payment_amount: USDC / 2,
        max_tx_count: 3,
        max_total_amount: 2 * USDC,
        window_size: 2 * 86_400,
    };

    f.client.reduce_limits(&tighter);

    // Events belong to the last invocation, so they are read before anything
    // else is called.
    let expected = LimitsReduced {
        max_payment_amount: tighter.max_payment_amount,
        max_tx_count: tighter.max_tx_count,
        max_total_amount: tighter.max_total_amount,
        window_size: tighter.window_size,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [expected.to_xdr(&f.env, &f.client.address)]
    );
    assert_eq!(f.client.get_velocity_config(), tighter);

    assert_eq!(
        f.try_pay(&f.payment_of(USDC)),
        Err(PolicyError::PaymentLimitExceeded)
    );
}

#[test]
fn test_no_limit_can_be_raised() {
    let f = setup();
    let base = pilot_limits();

    let loosened = [
        VelocityConfig {
            max_payment_amount: base.max_payment_amount + 1,
            ..base.clone()
        },
        VelocityConfig {
            max_tx_count: base.max_tx_count + 1,
            ..base.clone()
        },
        VelocityConfig {
            max_total_amount: base.max_total_amount + 1,
            ..base.clone()
        },
        // A shorter window lets payments stop counting sooner.
        VelocityConfig {
            window_size: base.window_size - 1,
            ..base.clone()
        },
    ];

    for config in loosened.iter() {
        assert_eq!(
            f.client.try_reduce_limits(config),
            Err(Ok(PolicyError::LimitIncrease))
        );
    }
    assert_eq!(f.client.get_velocity_config(), base);
}

#[test]
fn test_reducing_to_an_unusable_configuration_is_refused() {
    let f = setup();
    let zero = VelocityConfig {
        max_tx_count: 0,
        ..pilot_limits()
    };
    assert_eq!(
        f.client.try_reduce_limits(&zero),
        Err(Ok(PolicyError::InvalidConfig))
    );
}

// ── Proof of intent ───────────────────────────────────────────────

#[test]
fn test_authorizing_a_payment_emits_no_event() {
    let f = setup();
    assert!(f.pay(&f.payment()));

    // A facilitator refuses a settlement whose simulation shows anything but
    // the token transfer, so the account must stay silent here.
    assert!(f
        .env
        .events()
        .all()
        .filter_by_contract(&f.client.address)
        .events()
        .is_empty());
}

#[test]
fn test_the_payment_that_freezes_the_account_emits_no_event_either() {
    let f = setup();
    for _ in 0..4 {
        assert!(f.pay(&f.payment()));
    }
    assert!(f.pay(&f.payment()));
    assert!(f.client.is_frozen());
    assert!(f
        .env
        .events()
        .all()
        .filter_by_contract(&f.client.address)
        .events()
        .is_empty());
}

#[test]
fn test_the_proof_is_published_from_what_the_account_recorded() {
    let f = setup();
    let payment = f.payment();
    assert!(f.pay(&payment));

    let nonce = BytesN::from_array(&f.env, &payment.nonce);
    let record = f.client.get_payment(&nonce).expect("the payment left a record");
    assert!(!record.published);

    f.client.publish_proof(&nonce);

    let expected = ProofOfIntent {
        nonce: nonce.clone(),
        challenge_hash: BytesN::from_array(&f.env, &challenge_hash(&payment, &TEST_NETWORK_ID)),
        intent_hash: BytesN::from_array(&f.env, &intent_hash(&payment)),
        merchant_pubkey: f.merchant_kp.public.to_bytes().into_val(&f.env),
        amount: payment.amount,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [expected.to_xdr(&f.env, &f.client.address)]
    );
    assert!(f.client.get_payment(&nonce).unwrap().published);
}

#[test]
fn test_a_proof_is_published_once() {
    let f = setup();
    let payment = f.payment();
    assert!(f.pay(&payment));

    let nonce = BytesN::from_array(&f.env, &payment.nonce);
    f.client.publish_proof(&nonce);
    assert_eq!(
        f.client.try_publish_proof(&nonce),
        Err(Ok(PolicyError::ProofAlreadyPublished))
    );
}

#[test]
fn test_there_is_no_proof_for_a_payment_that_never_happened() {
    let f = setup();
    let unknown = BytesN::random(&f.env);
    assert_eq!(
        f.client.try_publish_proof(&unknown),
        Err(Ok(PolicyError::ProofNotFound))
    );
}

#[test]
fn test_the_proof_of_the_payment_that_froze_the_account_says_so() {
    let f = setup();
    for _ in 0..4 {
        assert!(f.pay(&f.payment()));
    }
    let last = f.payment();
    assert!(f.pay(&last));

    let nonce = BytesN::from_array(&f.env, &last.nonce);
    f.client.publish_proof(&nonce);

    let events = f.env.events().all().filter_by_contract(&f.client.address);
    let frozen = PaymentsFrozen {
        reason: symbol_short!("velocity"),
        tx_count: 5,
        total_amount: 5 * last.amount,
    };
    assert_eq!(events.events().len(), 2);
    assert_eq!(events.events()[1], frozen.to_xdr(&f.env, &f.client.address));
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

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::SettlementMismatch)
    );
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
        payment.amount * 2,
    );

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::SettlementMismatch)
    );
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

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::SettlementMismatch)
    );
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

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::SettlementMismatch)
    );
}

#[test]
fn test_payment_without_a_transfer_is_rejected() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    assert_eq!(
        f.try_authorize(&payload, sig, &vec![&f.env]),
        Err(PolicyError::SettlementMismatch)
    );
}

#[test]
fn test_a_second_transfer_cannot_ride_along() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = f.sign(&payload, &payment);

    let elsewhere = Address::generate(&f.env);
    let mut context = f.context(&payment);
    context.append(&transfer_context_with(
        &f.env,
        &f.client.address,
        &payment.asset,
        &elsewhere,
        payment.amount,
    ));

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::SettlementMismatch)
    );
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
fn test_owner_can_authorize_every_owner_action_with_the_passkey() {
    let f = setup();
    for action in [
        "freeze_payments",
        "restore_payments",
        "revoke_agent_signer",
        "set_agent_signer",
        "add_merchant",
        "remove_merchant",
        "reduce_limits",
        "recover_funds",
    ] {
        assert_eq!(f.owner_may(action), Ok(()), "owner refused for {}", action);
    }
}

#[test]
fn test_owner_can_restore_a_frozen_account() {
    let f = setup();
    f.client.freeze_payments();
    assert!(f.client.is_frozen());

    // The frozen flag must not block the owner, otherwise freezing the
    // account would lock the owner out of unfreezing it.
    assert_eq!(f.owner_may("restore_payments"), Ok(()));
}

#[test]
fn test_owner_can_set_a_signer_after_revocation() {
    let f = setup();
    f.client.revoke_agent_signer();

    // With no agent signer left the account would be bricked if owner
    // actions still went through the agent path.
    assert_eq!(f.owner_may("set_agent_signer"), Ok(()));
}

#[test]
fn test_agent_cannot_authorize_an_owner_action() {
    let f = setup();
    let payment = f.payment();

    for action in ["revoke_agent_signer", "reduce_limits", "recover_funds"] {
        let payload = BytesN::random(&f.env);
        let sig = f.sign(&payload, &payment);
        let context = owner_context(&f.env, &f.client.address, action);
        assert_eq!(
            f.try_authorize(&payload, sig, &context),
            Err(PolicyError::UnauthorizedOwnerAction),
            "agent allowed {}",
            action
        );
    }
}

#[test]
fn test_owner_signature_cannot_authorize_a_payment() {
    let f = setup();
    let payment = f.payment();
    let payload = BytesN::random(&f.env);
    let sig = create_owner_signature(&f.env, &payload);

    assert_eq!(
        f.try_authorize(&payload, sig, &f.context(&payment)),
        Err(PolicyError::UnauthorizedOwnerAction)
    );
}

#[test]
fn test_owner_action_cannot_ride_along_with_a_transfer() {
    let f = setup();
    let payment = f.payment();

    for action in ["add_merchant", "recover_funds"] {
        let payload = BytesN::random(&f.env);
        let sig = create_owner_signature(&f.env, &payload);
        let mut context = owner_context(&f.env, &f.client.address, action);
        context.append(&f.context(&payment));

        assert_eq!(
            f.try_authorize(&payload, sig, &context),
            Err(PolicyError::UnauthorizedOwnerAction),
            "{} rode along with a transfer",
            action
        );
    }
}

#[test]
fn test_passkey_requires_user_presence() {
    let f = setup();
    let payload = BytesN::random(&f.env);
    let sig = Assertion {
        flags: 0x04,
        ..Assertion::for_payload(&payload)
    }
    .sign(&f.env);
    let context = owner_context(&f.env, &f.client.address, "freeze_payments");

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::InvalidSignatureFormat)
    );
}

#[test]
fn test_passkey_requires_user_verification() {
    let f = setup();
    let payload = BytesN::random(&f.env);
    let sig = Assertion {
        flags: 0x01,
        ..Assertion::for_payload(&payload)
    }
    .sign(&f.env);
    let context = owner_context(&f.env, &f.client.address, "freeze_payments");

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::UserNotVerified)
    );
}

#[test]
fn test_passkey_assertion_from_another_domain_is_refused() {
    let f = setup();
    let payload = BytesN::random(&f.env);

    // Signed by the real owner key, which is what a phishing page that got
    // the owner to touch their authenticator would end up with.
    let sig = Assertion {
        rp_id: "beaver4O2.test",
        ..Assertion::for_payload(&payload)
    }
    .sign(&f.env);
    let context = owner_context(&f.env, &f.client.address, "recover_funds");

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::WrongRelyingParty)
    );
}

#[test]
fn test_passkey_registration_response_is_not_an_assertion() {
    let f = setup();
    let payload = BytesN::random(&f.env);
    let sig = Assertion {
        kind: "webauthn.create",
        ..Assertion::for_payload(&payload)
    }
    .sign(&f.env);
    let context = owner_context(&f.env, &f.client.address, "freeze_payments");

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::InvalidSignatureFormat)
    );
}

#[test]
fn test_passkey_assertion_is_bound_to_its_payload() {
    let f = setup();

    // A perfectly valid assertion, but produced for a different challenge.
    let sig = Assertion {
        challenge: [9u8; 32],
        ..Assertion::for_payload(&BytesN::random(&f.env))
    }
    .sign(&f.env);

    let payload = BytesN::random(&f.env);
    let context = owner_context(&f.env, &f.client.address, "freeze_payments");

    assert_eq!(
        f.try_authorize(&payload, sig, &context),
        Err(PolicyError::ChallengeMismatch)
    );
}

// ── Recovering the funds ──────────────────────────────────────────

#[test]
fn test_funds_cannot_be_recovered_from_an_account_that_is_not_frozen() {
    let f = setup();
    assert_eq!(
        f.client.try_recover_funds(&f.asset),
        Err(Ok(PolicyError::NotFrozen))
    );
    assert_eq!(f.balance(&f.client.address), 5 * USDC);
}

#[test]
fn test_recovery_moves_the_whole_balance_to_the_fixed_address() {
    let f = setup();
    f.client.freeze_payments();

    assert_eq!(f.client.recover_funds(&f.asset), 5 * USDC);

    let expected = FundsRecovered {
        token: f.asset.clone(),
        recovery: f.recovery.clone(),
        amount: 5 * USDC,
    };
    assert_eq!(
        f.env.events().all().filter_by_contract(&f.client.address),
        [expected.to_xdr(&f.env, &f.client.address)]
    );

    assert_eq!(f.balance(&f.client.address), 0);
    assert_eq!(f.balance(&f.recovery), 5 * USDC);
}

#[test]
fn test_an_empty_account_has_nothing_to_recover() {
    let f = setup();
    f.client.freeze_payments();
    f.client.recover_funds(&f.asset);

    assert_eq!(
        f.client.try_recover_funds(&f.asset),
        Err(Ok(PolicyError::NothingToRecover))
    );
}

#[test]
fn test_a_stray_token_can_be_recovered_too() {
    let f = setup();
    let stray = f
        .env
        .register_stellar_asset_contract_v2(Address::generate(&f.env))
        .address();
    StellarAssetClient::new(&f.env, &stray).mint(&f.client.address, &123);

    f.client.freeze_payments();
    assert_eq!(f.client.recover_funds(&stray), 123);
    assert_eq!(TokenClient::new(&f.env, &stray).balance(&f.recovery), 123);
}

// ── Lifetime ──────────────────────────────────────────────────────

#[test]
fn test_the_account_starts_with_its_full_lifetime() {
    let f = setup();
    assert_eq!(f.instance_ttl(), INSTANCE_LIFETIME);
}

#[test]
fn test_anyone_can_extend_the_account() {
    let f = setup();

    f.advance_ledgers(EXTENSION_STEP + 1);
    assert_eq!(f.instance_ttl(), INSTANCE_LIFETIME - EXTENSION_STEP - 1);

    f.client.extend_ttl();
    assert_eq!(f.instance_ttl(), INSTANCE_LIFETIME);
}

#[test]
fn test_a_drift_shorter_than_a_step_is_left_alone() {
    let f = setup();

    f.advance_ledgers(EXTENSION_STEP - 1);
    f.client.extend_ttl();
    assert_eq!(f.instance_ttl(), INSTANCE_LIFETIME - EXTENSION_STEP + 1);
}

#[test]
fn test_a_payment_never_pays_for_extending_the_account() {
    let f = setup();

    // Extending the code would be rent on its whole size, which no x402
    // facilitator would accept inside a payment.
    f.advance_ledgers(EXTENSION_STEP + 1);
    assert!(f.pay(&f.payment()));
    assert_eq!(f.instance_ttl(), INSTANCE_LIFETIME - EXTENSION_STEP - 1);
}

#[test]
fn test_publishing_a_proof_extends_the_account() {
    let f = setup();

    // The proof record only lives for a day, so the account ages first and
    // the payment happens just before publishing.
    f.advance_ledgers(EXTENSION_STEP + 1);
    let payment = f.payment();
    assert!(f.pay(&payment));
    f.client
        .publish_proof(&BytesN::from_array(&f.env, &payment.nonce));
    assert_eq!(f.instance_ttl(), INSTANCE_LIFETIME);
}

#[test]
fn test_owner_actions_extend_the_account() {
    let f = setup();

    f.advance_ledgers(EXTENSION_STEP + 1);
    f.client.freeze_payments();
    assert_eq!(f.instance_ttl(), INSTANCE_LIFETIME);
}

#[test]
fn test_the_window_never_changes_size() {
    // A payment that grew the stored window would be charged rent on the
    // extra bytes for the rest of the account's life.
    let f = setup();
    let empty = f.window_size_in_bytes();

    for _ in 0..3 {
        assert!(f.pay(&f.payment()));
        assert_eq!(f.window_size_in_bytes(), empty);
    }

    // Including when an old payment ages out and its slot is reused.
    f.advance(86_400);
    assert!(f.pay(&f.payment_of(USDC)));
    assert_eq!(f.window_size_in_bytes(), empty);
}

#[test]
fn test_a_replay_is_refused_for_as_long_as_the_challenge_is_valid() {
    let f = setup();
    let payment = Payment {
        expiry: START + MAX_CHALLENGE_LIFETIME,
        ..f.payment()
    };
    assert!(f.pay(&payment));

    // Right up to its expiry the spent challenge is refused for its nonce.
    f.advance(MAX_CHALLENGE_LIFETIME);
    assert_eq!(f.try_pay(&payment), Err(PolicyError::NonceReused));

    // After that it is dead on its own.
    f.advance(1);
    assert_eq!(f.try_pay(&payment), Err(PolicyError::ChallengeExpired));
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
fn test_a_removed_merchant_can_no_longer_be_paid() {
    let f = setup();
    let merchant_pub: BytesN<32> = f.merchant_kp.public.to_bytes().into_val(&f.env);

    f.client.remove_merchant(&merchant_pub);
    assert!(!f.client.is_merchant(&merchant_pub));
    assert_eq!(f.try_pay(&f.payment()), Err(PolicyError::UnauthorizedMerchant));
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
