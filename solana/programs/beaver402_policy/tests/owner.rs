//! What the owner passkey can do, and what an assertion can be stretched to
//! do beyond the one action it was made for.

mod common;

use beaver402_policy::state::VelocityConfig;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn assert_refused(result: Result<(), String>, reason: &str) {
    match result {
        Ok(()) => panic!("expected {reason}, but it went through"),
        Err(got) => assert_eq!(got, reason, "refused for the wrong reason"),
    }
}

fn reduce(env: &mut Env, limits: VelocityConfig) -> Result<(), String> {
    env.owner_action("reduce_limits", None, Some(limits), Assertion::default())
}

// ── Limits ────────────────────────────────────────────────────────

#[test]
fn no_limit_can_be_raised_on_its_own() {
    let base = pilot_limits();
    let raises = [
        VelocityConfig { max_payment_amount: base.max_payment_amount + 1, ..base },
        VelocityConfig { max_tx_count: base.max_tx_count + 1, ..base },
        VelocityConfig { max_total_amount: base.max_total_amount + 1, ..base },
        VelocityConfig { window_size: base.window_size - 1, ..base },
    ];
    for raised in raises {
        let mut env = Env::new();
        assert_refused(reduce(&mut env, raised), "LimitIncrease");
        assert_eq!(env.state().velocity(), base);
    }
}

#[test]
fn lowering_one_limit_cannot_carry_another_up() {
    let mut env = Env::new();
    let mut mixed = pilot_limits();
    mixed.max_payment_amount = 100_000;
    mixed.max_tx_count = 6;
    assert_refused(reduce(&mut env, mixed), "LimitIncrease");
}

#[test]
fn the_same_limits_again_are_accepted() {
    let mut env = Env::new();
    reduce(&mut env, pilot_limits()).unwrap();
    assert_eq!(env.state().velocity(), pilot_limits());
}

#[test]
fn a_longer_window_is_a_reduction() {
    let mut env = Env::new();
    let mut longer = pilot_limits();
    longer.window_size = 7 * 86_400;
    reduce(&mut env, longer).unwrap();
    assert_eq!(env.state().velocity().window_size, 7 * 86_400);
}

#[test]
fn reducing_to_an_unusable_configuration_is_refused() {
    let base = pilot_limits();
    let unusable = [
        VelocityConfig { max_payment_amount: 0, ..base },
        VelocityConfig { max_tx_count: 0, ..base },
        VelocityConfig { max_total_amount: 0, ..base },
        VelocityConfig { max_total_amount: base.max_payment_amount - 1, ..base },
    ];
    for config in unusable {
        let mut env = Env::new();
        assert_refused(reduce(&mut env, config), "InvalidConfig");
        assert_eq!(env.state().velocity(), base);
    }
}

#[test]
fn reduced_limits_apply_to_the_next_payment() {
    let mut env = Env::new();
    let mut lower = pilot_limits();
    lower.max_payment_amount = 500_000;
    reduce(&mut env, lower).unwrap();
    let terms = env.terms(500_001);
    assert_refused(env.pay(&terms), "PaymentLimitExceeded");
    let terms = env.terms(500_000);
    env.pay(&terms).unwrap();
}

#[test]
fn a_lower_count_takes_effect_on_payments_already_made() {
    let mut env = Env::new();
    for _ in 0..3 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    let mut lower = pilot_limits();
    lower.max_tx_count = 3;
    reduce(&mut env, lower).unwrap();
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "VelocityExceeded");
}

#[test]
fn an_assertion_for_some_limits_cannot_set_others() {
    let mut env = Env::new();
    let mut signed = pilot_limits();
    signed.max_payment_amount = 900_000;
    let mut sent = pilot_limits();
    sent.max_payment_amount = 800_000;
    let (precompile, proof) = env.owner_assertion(&env.owner, "reduce_limits", None, Some(signed), &Assertion::default());
    let ix = env.owner_instruction("reduce_limits", None, Some(sent), proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

// ── Merchants ─────────────────────────────────────────────────────

#[test]
fn adding_a_merchant_twice_keeps_one_entry() {
    let mut env = Env::new();
    let merchant = env.merchant.pubkey();
    env.owner_action("add_merchant", Some(merchant), None, Assertion::default())
        .unwrap();
    assert_eq!(env.state().merchant_count, 1);
}

#[test]
fn removing_a_merchant_not_on_the_list_changes_nothing() {
    let mut env = Env::new();
    let stranger = Keypair::new().pubkey();
    env.owner_action("remove_merchant", Some(stranger), None, Assertion::default())
        .unwrap();
    let state = env.state();
    assert_eq!(state.merchant_count, 1);
    assert!(state.is_merchant(&env.merchant.pubkey()));
}

#[test]
fn removing_a_merchant_makes_room_for_another() {
    let mut env = Env::new();
    let mut added = Vec::new();
    for _ in 0..7 {
        let merchant = Keypair::new().pubkey();
        env.owner_action("add_merchant", Some(merchant), None, Assertion::default())
            .unwrap();
        added.push(merchant);
    }
    env.owner_action("remove_merchant", Some(added[2]), None, Assertion::default())
        .unwrap();
    let newcomer = Keypair::new().pubkey();
    env.owner_action("add_merchant", Some(newcomer), None, Assertion::default())
        .unwrap();
    let state = env.state();
    assert_eq!(state.merchant_count, 8);
    assert!(!state.is_merchant(&added[2]));
    assert!(state.is_merchant(&newcomer));
    for merchant in added.iter().filter(|m| **m != added[2]) {
        assert!(state.is_merchant(merchant));
    }
}

#[test]
fn removing_one_merchant_leaves_the_others_payable() {
    let mut env = Env::new();
    let other = Keypair::new();
    env.owner_action("add_merchant", Some(other.pubkey()), None, Assertion::default())
        .unwrap();
    let first = env.merchant.pubkey();
    env.owner_action("remove_merchant", Some(first), None, Assertion::default())
        .unwrap();
    env.merchant = other;
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
}

#[test]
fn a_merchant_can_be_approved_again_after_removal() {
    let mut env = Env::new();
    let merchant = env.merchant.pubkey();
    env.owner_action("remove_merchant", Some(merchant), None, Assertion::default())
        .unwrap();
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "UnauthorizedMerchant");
    env.owner_action("add_merchant", Some(merchant), None, Assertion::default())
        .unwrap();
    env.pay(&terms).unwrap();
}

// ── The agent ─────────────────────────────────────────────────────

#[test]
fn a_new_agent_replaces_the_old_one() {
    let mut env = Env::new();
    let new = Keypair::new();
    env.owner_action("set_agent_signer", Some(new.pubkey()), None, Assertion::default())
        .unwrap();

    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "InvalidBuyerSigner");
    env.agent = new;
    env.pay(&terms).unwrap();
}

#[test]
fn the_agent_cannot_be_set_to_nobody() {
    let mut env = Env::new();
    let nobody = anchor_lang::prelude::Pubkey::default();
    let nonce = env.state().owner_nonce;
    assert_refused(
        env.owner_action("set_agent_signer", Some(nobody), None, Assertion::default()),
        "InvalidConfig",
    );
    assert_eq!(env.state().agent_signer, env.agent.pubkey());
    assert_eq!(env.state().owner_nonce, nonce);
}

#[test]
fn revoking_twice_is_refused() {
    let mut env = Env::new();
    env.owner("revoke_agent_signer").unwrap();
    assert_refused(env.owner("revoke_agent_signer"), "SignerRevoked");
}

// ── Stretching an assertion ──────────────────────────────────────

#[test]
fn an_old_assertion_dies_when_another_action_goes_first() {
    let mut env = Env::new();
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    // A different action moves the counter before the first one is sent.
    let merchant = Keypair::new().pubkey();
    env.owner_action("add_merchant", Some(merchant), None, Assertion::default())
        .unwrap();
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
    assert!(!env.state().is_frozen());
}

#[test]
fn an_assertion_for_one_account_does_not_work_on_another() {
    // Same owner, same passkey, two accounts. The challenge names the
    // account, so an approval for one cannot be replayed on the other.
    let mut env = Env::new();
    let first = env.policy_id;
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());

    env.use_policy(sha256(b"beaver402 second policy"));
    env.initialize(pilot_limits()).unwrap();
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
    assert!(!env.state().is_frozen());

    env.use_policy(first);
    assert!(!env.state().is_frozen());
}

#[test]
fn a_failed_action_does_not_use_up_the_counter() {
    let mut env = Env::new();
    let nonce = env.state().owner_nonce;
    assert_refused(env.owner("recover_funds"), "NotFrozen");
    assert_eq!(env.state().owner_nonce, nonce);
    env.owner("freeze_payments").unwrap();
    assert_eq!(env.state().owner_nonce, nonce + 1);
}

#[test]
fn refuses_a_challenge_with_something_appended() {
    let mut env = Env::new();
    let valid_until = env.now() + 300;
    let challenge = env.owner_challenge("freeze_payments", None, None, valid_until);
    let carried = format!("{}AA", encode_challenge(&challenge));
    let json = client_data("webauthn.get", &carried);
    let (precompile, proof) = env.signed_assertion(&env.owner, json, RP_ID, 0x05, valid_until);
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

#[test]
fn refuses_a_challenge_hidden_behind_a_decoy() {
    // Two challenge keys. The program reads the first, so a real challenge
    // tucked in after a decoy proves nothing.
    let mut env = Env::new();
    let valid_until = env.now() + 300;
    let challenge = encode_challenge(&env.owner_challenge("freeze_payments", None, None, valid_until));
    let json = format!(
        r#"{{"type":"webauthn.get","challenge":"{}","challenge":"{}","origin":"https://{}"}}"#,
        encode_challenge(&[9u8; 32]),
        challenge,
        RP_ID
    )
    .into_bytes();
    let (precompile, proof) = env.signed_assertion(&env.owner, json, RP_ID, 0x05, valid_until);
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

#[test]
fn refuses_client_data_other_than_what_the_passkey_signed() {
    let mut env = Env::new();
    let (precompile, mut proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    proof.client_data_json.push(b' ');
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "InvalidSignatureFormat");
}

#[test]
fn refuses_a_deadline_other_than_the_one_signed() {
    let mut env = Env::new();
    let (precompile, mut proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    proof.valid_until += 60;
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

#[test]
fn refuses_client_data_without_a_challenge() {
    let mut env = Env::new();
    let valid_until = env.now() + 300;
    let json = br#"{"type":"webauthn.get","origin":"https://beaver402.test"}"#.to_vec();
    let (precompile, proof) = env.signed_assertion(&env.owner, json, RP_ID, 0x05, valid_until);
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

#[test]
fn an_assertion_is_good_until_its_last_second() {
    let mut env = Env::new();
    let valid_until = env.now() + 600;
    let (precompile, proof) = env.owner_assertion(
        &env.owner,
        "freeze_payments",
        None,
        None,
        &Assertion {
            valid_until: Some(valid_until),
            ..Assertion::default()
        },
    );
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    env.advance(600);
    env.send(&[precompile, ix], &[]).unwrap();
    assert!(env.state().is_frozen());
}

// ── Recovery ──────────────────────────────────────────────────────

#[test]
fn funds_can_be_recovered_after_the_limits_froze_the_account() {
    let mut env = Env::new();
    for _ in 0..5 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    assert!(env.state().is_frozen());
    env.owner("recover_funds").unwrap();
    assert_eq!(env.balance(&env.recovery_token()), 10_000_000 - 500_000);
    assert_eq!(env.balance(&env.vault), 0);
}

#[test]
fn the_account_keeps_working_after_a_recovery() {
    let mut env = Env::new();
    env.owner("freeze_payments").unwrap();
    env.owner("recover_funds").unwrap();
    env.fund_vault(2_000_000);
    env.owner("restore_payments").unwrap();
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
    assert_eq!(env.balance(&env.vault), 1_900_000);
}

#[test]
fn nothing_but_the_passkey_can_recover_funds() {
    let mut env = Env::new();
    env.owner("freeze_payments").unwrap();
    let proof = beaver402_policy::owner::OwnerProof {
        client_data_json: vec![],
        valid_until: env.now() + 60,
    };
    let ix = env.owner_instruction("recover_funds", None, None, proof);
    assert_refused(env.send(&[ix], &[]), "InvalidSignatureFormat");
    assert_eq!(env.balance(&env.vault), 10_000_000);
}
