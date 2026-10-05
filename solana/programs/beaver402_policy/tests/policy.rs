//! The policy account, end to end on a LiteSVM ledger. Each test mirrors one
//! in contracts/payment_policy/src/test.rs where Stellar has a counterpart,
//! and the rest cover what is specific to Solana: precompile introspection,
//! instruction injection and account substitution.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_associated_token_account_interface::address::get_associated_token_address;

fn assert_refused(result: Result<(), String>, reason: &str) {
    match result {
        Ok(()) => panic!("expected {reason}, but it went through"),
        Err(got) => assert_eq!(got, reason, "refused for the wrong reason"),
    }
}

// ── Creating the account ──────────────────────────────────────────

#[test]
fn creates_the_account_with_its_configuration() {
    let env = Env::new();
    let state = env.state();
    assert_eq!(state.agent_signer, env.agent.pubkey());
    assert_eq!(state.asset, env.mint);
    assert_eq!(state.recovery, env.recovery.pubkey());
    assert_eq!(state.owner_key(), env.owner.compressed);
    assert_eq!(state.velocity(), pilot_limits());
    assert!(!state.is_frozen());
    assert!(state.is_merchant(&env.merchant.pubkey()));
}

#[test]
fn refuses_a_window_shorter_than_a_challenge() {
    let mut env = Env::bare();
    let mut limits = pilot_limits();
    limits.window_size = 899;
    assert_refused(env.initialize(limits), "InvalidConfig");
}

#[test]
fn refuses_more_payments_than_there_are_slots() {
    let mut env = Env::bare();
    let mut limits = pilot_limits();
    limits.max_tx_count = 17;
    assert_refused(env.initialize(limits), "InvalidConfig");
}

#[test]
fn refuses_a_per_payment_limit_above_the_total() {
    let mut env = Env::bare();
    let mut limits = pilot_limits();
    limits.max_payment_amount = limits.max_total_amount + 1;
    assert_refused(env.initialize(limits), "InvalidConfig");
}

#[test]
fn refuses_the_account_as_its_own_recovery_address() {
    let mut env = Env::bare();
    let mut args = env.initialize_args(pilot_limits());
    args.recovery = env.policy;
    assert_refused(env.initialize_with(args), "InvalidConfig");
}

#[test]
fn refuses_an_owner_key_that_is_not_a_compressed_point() {
    let mut env = Env::bare();
    let mut args = env.initialize_args(pilot_limits());
    args.owner[0] = 0x04;
    assert_refused(env.initialize_with(args), "InvalidConfig");
}

// ── Payments ──────────────────────────────────────────────────────

#[test]
fn pays_the_agreed_payment() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();

    assert_eq!(env.balance(&env.recipient_token()), 100_000);
    assert_eq!(env.balance(&env.vault), 10_000_000 - 100_000);
    let slot = env.state().slots.iter().find(|s| s.amount > 0).copied().unwrap();
    assert_eq!(slot.nonce, terms.nonce);
    assert_eq!(slot.challenge_hash, env.challenge_hash(&terms));
    assert_eq!(slot.merchant_pubkey, env.merchant.pubkey());
}

#[test]
fn refuses_a_replayed_challenge() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
    assert_refused(env.pay(&terms), "NonceReused");
    assert_eq!(env.balance(&env.recipient_token()), 100_000);
}

#[test]
fn refuses_while_frozen_and_pays_again_once_restored() {
    let mut env = Env::new();
    env.owner("freeze_payments").unwrap();
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "AccountFrozen");

    env.owner("restore_payments").unwrap();
    env.pay(&terms).unwrap();
}

#[test]
fn refuses_a_revoked_agent_until_it_is_set_again() {
    let mut env = Env::new();
    env.owner("revoke_agent_signer").unwrap();
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "SignerRevoked");

    let agent = env.agent.pubkey();
    env.owner_action("set_agent_signer", Some(agent), None, Assertion::default())
        .unwrap();
    env.pay(&terms).unwrap();
}

#[test]
fn refuses_a_payment_signed_by_another_key() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let impostor = Keypair::new();
    let pay = env.pay_instruction(&impostor.pubkey(), &terms, &terms, env.recipient_token());
    assert_refused(env.send(&[signature, pay], &[&impostor]), "InvalidBuyerSigner");
}

#[test]
fn refuses_a_merchant_the_owner_has_not_approved() {
    let mut env = Env::new();
    let merchant = env.merchant.pubkey();
    env.owner_action("remove_merchant", Some(merchant), None, Assertion::default())
        .unwrap();
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "UnauthorizedMerchant");
}

#[test]
fn refuses_more_than_the_merchant_signed_for() {
    let mut env = Env::new();
    let signed = env.terms(100_000);
    let mut paid = signed.clone();
    paid.amount = 900_000;
    assert_refused(env.pay_signed_for(&signed, &paid), "InvalidMerchantSignature");
}

#[test]
fn refuses_a_payment_rerouted_to_another_recipient() {
    let mut env = Env::new();
    let signed = env.terms(100_000);
    let attacker = Keypair::new().pubkey();
    env.create_token_account(attacker, 0);
    let mut paid = signed.clone();
    paid.recipient = attacker;
    assert_refused(env.pay_signed_for(&signed, &paid), "InvalidMerchantSignature");
}

#[test]
fn refuses_a_payment_for_another_request() {
    let mut env = Env::new();
    let signed = env.terms(100_000);
    let mut paid = signed.clone();
    paid.request_digest = sha256(b"POST https://api.merchant.test/other");
    assert_refused(env.pay_signed_for(&signed, &paid), "InvalidMerchantSignature");
}

#[test]
fn refuses_a_challenge_signed_for_another_network() {
    let mut env = Env::new();
    let mut terms = env.terms(100_000);
    terms.network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp".to_string();
    assert_refused(env.pay(&terms), "InvalidMerchantSignature");
}

#[test]
fn refuses_a_challenge_extended_by_the_agent() {
    let mut env = Env::new();
    let signed = env.terms(100_000);
    let mut paid = signed.clone();
    paid.expiry += 60;
    assert_refused(env.pay_signed_for(&signed, &paid), "InvalidMerchantSignature");
}

#[test]
fn refuses_an_expired_challenge() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    env.advance(301);
    assert_refused(env.pay(&terms), "ChallengeExpired");
}

#[test]
fn refuses_a_challenge_that_lives_too_long() {
    let mut env = Env::new();
    let mut terms = env.terms(100_000);
    terms.expiry = env.now() + 901;
    assert_refused(env.pay(&terms), "ExpiryTooFar");
}

#[test]
fn refuses_a_zero_expiry() {
    let mut env = Env::new();
    let mut terms = env.terms(100_000);
    terms.expiry = 0;
    assert_refused(env.pay(&terms), "ChallengeExpired");
}

#[test]
fn refuses_a_zero_amount() {
    let mut env = Env::new();
    let terms = env.terms(0);
    assert_refused(env.pay(&terms), "InvalidAmount");
}

#[test]
fn refuses_a_payment_above_the_per_payment_limit() {
    let mut env = Env::new();
    let terms = env.terms(1_000_001);
    assert_refused(env.pay(&terms), "PaymentLimitExceeded");
}

#[test]
fn pays_from_another_mint_never() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let mut pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    // Point the mint at another one. The vault constraint no longer holds.
    pay.accounts[2].pubkey = Pubkey::new_unique();
    let agent = env.agent.insecure_clone();
    assert!(env.send(&[signature, pay], &[&agent]).is_err());
}

#[test]
fn refuses_a_destination_that_is_not_the_recipients_token_account() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let attacker = Keypair::new().pubkey();
    let attacker_token = env.create_token_account(attacker, 0);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, attacker_token);
    let agent = env.agent.insecure_clone();
    assert!(env.send(&[signature, pay], &[&agent]).is_err());
    assert_eq!(env.balance(&attacker_token), 0);
}

// ── Velocity ──────────────────────────────────────────────────────

#[test]
fn the_payment_that_fills_the_count_freezes_the_account() {
    let mut env = Env::new();
    for _ in 0..5 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    assert!(env.state().is_frozen());
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "AccountFrozen");
}

#[test]
fn refuses_a_payment_that_would_cross_the_total() {
    let mut limits = pilot_limits();
    limits.max_tx_count = 10;
    limits.max_total_amount = 2_500_000;
    let mut env = Env::with_limits(limits);
    for _ in 0..2 {
        let terms = env.terms(1_000_000);
        env.pay(&terms).unwrap();
    }
    // 2 USDC spent; one more would take it to 3, over 2.5.
    let terms = env.terms(1_000_000);
    assert_refused(env.pay(&terms), "VelocityExceeded");

    // Exactly reaching the total goes through, and freezes the account.
    let terms = env.terms(500_000);
    env.pay(&terms).unwrap();
    assert!(env.state().is_frozen());
}

#[test]
fn restoring_does_not_reset_the_window() {
    let mut env = Env::new();
    for _ in 0..5 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    env.owner("restore_payments").unwrap();
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "VelocityExceeded");
}

#[test]
fn payments_leave_the_window_after_it_slides() {
    let mut env = Env::new();
    for _ in 0..5 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    env.owner("restore_payments").unwrap();
    env.advance(86_400);
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
}

// ── Transaction layout and precompile introspection ──────────────

#[test]
fn refuses_a_payment_without_a_merchant_signature() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    assert_refused(env.send(&[pay], &[&agent]), "InvalidSignatureFormat");
}

#[test]
fn refuses_a_signature_by_a_key_that_is_not_the_merchants() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let impostor = Keypair::new();
    let signature = env.merchant_signature(&impostor, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    assert_refused(env.send(&[signature, pay], &[&agent]), "InvalidMerchantSignature");
}

#[test]
fn refuses_precompile_offsets_that_point_elsewhere() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let mut signature = env.merchant_signature(&env.merchant, &hash);
    // Point the message at instruction 1, the payment itself. The precompile
    // would then verify bytes the program does not read.
    signature.data[14] = 1;
    signature.data[15] = 0;
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    assert!(env.send(&[signature, pay], &[&agent]).is_err());
    assert_eq!(env.balance(&env.recipient_token()), 0);
}

#[test]
fn refuses_two_payments_in_one_transaction() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let mut second_terms = terms.clone();
    second_terms.nonce = env.next_nonce();
    let second = env.pay_instruction(&env.agent.pubkey(), &second_terms, &second_terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    assert_refused(env.send(&[signature, pay, second], &[&agent]), "UnexpectedInstruction");
}

#[test]
fn refuses_a_payment_carrying_another_instruction() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let extra = Instruction {
        program_id: anchor_lang::solana_program::system_program::ID,
        accounts: vec![],
        data: vec![],
    };
    let agent = env.agent.insecure_clone();
    assert_refused(env.send(&[signature, pay, extra], &[&agent]), "UnexpectedInstruction");
}

#[test]
fn refuses_two_merchant_signatures() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let first = env.merchant_signature(&env.merchant, &hash);
    let second = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    assert_refused(env.send(&[first, second, pay], &[&agent]), "UnexpectedInstruction");
}

#[test]
fn accepts_compute_budget_instructions() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    // SetComputeUnitLimit(300_000)
    let mut data = vec![2u8];
    data.extend_from_slice(&300_000u32.to_le_bytes());
    let budget = Instruction {
        program_id: solana_sdk_ids::compute_budget::ID,
        accounts: vec![],
        data,
    };
    let agent = env.agent.insecure_clone();
    env.send(&[budget, signature, pay], &[&agent]).unwrap();
}

// ── Owner path ────────────────────────────────────────────────────

#[test]
fn an_owner_assertion_works_only_once() {
    let mut env = Env::new();
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    env.send(&[precompile.clone(), ix.clone()], &[]).unwrap();
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

#[test]
fn refuses_an_assertion_made_for_another_action() {
    let mut env = Env::new();
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("restore_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

#[test]
fn refuses_an_assertion_for_another_merchant() {
    let mut env = Env::new();
    let approved = Keypair::new().pubkey();
    let other = Keypair::new().pubkey();
    let (precompile, proof) =
        env.owner_assertion(&env.owner, "add_merchant", Some(approved), None, &Assertion::default());
    let ix = env.owner_instruction("add_merchant", Some(other), None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "ChallengeMismatch");
}

#[test]
fn refuses_a_passkey_that_is_not_the_owners() {
    let mut env = Env::new();
    let stranger = Passkey::new();
    let (precompile, proof) = env.owner_assertion(&stranger, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "UnauthorizedOwnerAction");
}

#[test]
fn refuses_an_assertion_from_another_domain() {
    let mut env = Env::new();
    let assertion = Assertion {
        rp_id: "beaver402-phish.test".to_string(),
        ..Assertion::default()
    };
    assert_refused(env.owner_action("freeze_payments", None, None, assertion), "WrongRelyingParty");
}

#[test]
fn refuses_an_assertion_without_user_verification() {
    let mut env = Env::new();
    let assertion = Assertion {
        flags: 0x01,
        ..Assertion::default()
    };
    assert_refused(env.owner_action("freeze_payments", None, None, assertion), "UserNotVerified");
}

#[test]
fn refuses_an_assertion_without_user_presence() {
    let mut env = Env::new();
    let assertion = Assertion {
        flags: 0x04,
        ..Assertion::default()
    };
    assert_refused(env.owner_action("freeze_payments", None, None, assertion), "InvalidSignatureFormat");
}

#[test]
fn refuses_a_registration_presented_as_an_assertion() {
    let mut env = Env::new();
    let assertion = Assertion {
        kind: "webauthn.create".to_string(),
        ..Assertion::default()
    };
    assert_refused(env.owner_action("freeze_payments", None, None, assertion), "InvalidSignatureFormat");
}

#[test]
fn refuses_an_expired_assertion() {
    let mut env = Env::new();
    let assertion = Assertion {
        valid_until: Some(env.now() - 1),
        ..Assertion::default()
    };
    assert_refused(env.owner_action("freeze_payments", None, None, assertion), "ChallengeExpired");
}

#[test]
fn refuses_an_assertion_valid_for_too_long() {
    let mut env = Env::new();
    let assertion = Assertion {
        valid_until: Some(env.now() + 601),
        ..Assertion::default()
    };
    assert_refused(env.owner_action("freeze_payments", None, None, assertion), "ExpiryTooFar");
}

#[test]
fn refuses_an_owner_action_carrying_a_payment() {
    let mut env = Env::new();
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    let terms = env.terms(100_000);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    assert_refused(env.send(&[precompile, ix, pay], &[&agent]), "UnexpectedInstruction");
}

#[test]
fn refuses_an_owner_action_without_a_passkey_assertion() {
    let mut env = Env::new();
    env.owner("freeze_payments").unwrap();
    // Whoever pays the fee, the agent included, cannot stand in for the
    // passkey: without the precompile there is nothing to authorize with.
    let proof = beaver402_policy::owner::OwnerProof {
        client_data_json: vec![],
        valid_until: env.now() + 60,
    };
    let ix = env.owner_instruction("restore_payments", None, None, proof);
    assert_refused(env.send(&[ix], &[]), "InvalidSignatureFormat");
    assert!(env.state().is_frozen());
}

#[test]
fn refuses_an_ed25519_signature_on_the_owner_path() {
    let mut env = Env::new();
    // An agent signature dressed up as an owner approval.
    let proof = beaver402_policy::owner::OwnerProof {
        client_data_json: vec![],
        valid_until: env.now() + 60,
    };
    let signature = env.merchant_signature(&env.agent, &[7u8; 32]);
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[signature, ix], &[]), "UnexpectedInstruction");
}

#[test]
fn the_owner_can_act_on_a_frozen_account() {
    let mut env = Env::new();
    env.owner("freeze_payments").unwrap();
    env.owner("revoke_agent_signer").unwrap();
    env.owner("restore_payments").unwrap();
    assert!(!env.state().is_frozen());
}

#[test]
fn limits_only_go_down() {
    let mut env = Env::new();
    let mut lower = pilot_limits();
    lower.max_payment_amount = 500_000;
    lower.max_tx_count = 3;
    env.owner_action("reduce_limits", None, Some(lower), Assertion::default())
        .unwrap();
    assert_eq!(env.state().velocity(), lower);

    let mut higher = lower;
    higher.max_tx_count = 4;
    assert_refused(
        env.owner_action("reduce_limits", None, Some(higher), Assertion::default()),
        "LimitIncrease",
    );

    let mut shorter = lower;
    shorter.window_size = 3_600;
    assert_refused(
        env.owner_action("reduce_limits", None, Some(shorter), Assertion::default()),
        "LimitIncrease",
    );
}

#[test]
fn recovers_funds_only_from_a_frozen_account() {
    let mut env = Env::new();
    assert_refused(env.owner("recover_funds"), "NotFrozen");

    env.owner("freeze_payments").unwrap();
    env.owner("recover_funds").unwrap();
    assert_eq!(env.balance(&env.recovery_token()), 10_000_000);
    assert_eq!(env.balance(&env.vault), 0);
    assert_refused(env.owner("recover_funds"), "NothingToRecover");
}

#[test]
fn the_merchant_list_has_room_for_eight() {
    let mut env = Env::new();
    for _ in 0..7 {
        let merchant = Keypair::new().pubkey();
        env.owner_action("add_merchant", Some(merchant), None, Assertion::default())
            .unwrap();
    }
    let ninth = Keypair::new().pubkey();
    assert_refused(
        env.owner_action("add_merchant", Some(ninth), None, Assertion::default()),
        "MerchantListFull",
    );
}

#[test]
fn recovery_goes_to_the_fixed_address_only() {
    let mut env = Env::new();
    env.owner("freeze_payments").unwrap();
    let (precompile, proof) = env.owner_assertion(&env.owner, "recover_funds", None, None, &Assertion::default());
    let mut ix = env.owner_instruction("recover_funds", None, None, proof);
    let thief = Keypair::new().pubkey();
    let thief_token = env.create_token_account(thief, 0);
    ix.accounts[3].pubkey = thief;
    ix.accounts[4].pubkey = thief_token;
    assert!(env.send(&[precompile, ix], &[]).is_err());
    assert_eq!(env.balance(&thief_token), 0);
    let _ = get_associated_token_address(&thief, &env.mint);
}

// ── Budget ────────────────────────────────────────────────────────

/// A payment and an owner action have to fit the default compute budget and
/// the 1232 byte transaction limit, with the payment run against a full
/// window so the slot scan is at its most expensive.
#[test]
fn payments_and_owner_actions_fit_the_limits() {
    use solana_message::Message;
    use solana_transaction::Transaction;

    let mut limits = pilot_limits();
    limits.max_tx_count = 16;
    limits.max_total_amount = 16_000_000;
    let mut env = Env::with_limits(limits);
    for _ in 0..15 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }

    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let message = Message::new(&[signature, pay], Some(&env.payer.pubkey()));
    let tx = Transaction::new(&[&env.payer, &env.agent], message, env.svm.latest_blockhash());
    let size = bincode_len(&tx);
    let meta = env.svm.send_transaction(tx).unwrap();
    println!("pay: {} compute units, {} bytes", meta.compute_units_consumed, size);
    assert!(meta.compute_units_consumed < 200_000);
    assert!(size <= 1232);

    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    env.svm.expire_blockhash();
    let message = Message::new(&[precompile, ix], Some(&env.payer.pubkey()));
    let tx = Transaction::new(&[&env.payer], message, env.svm.latest_blockhash());
    let size = bincode_len(&tx);
    let meta = env.svm.send_transaction(tx).unwrap();
    println!("freeze_payments: {} compute units, {} bytes", meta.compute_units_consumed, size);
    assert!(meta.compute_units_consumed < 200_000);
    assert!(size <= 1232);
}

fn bincode_len(tx: &solana_transaction::Transaction) -> usize {
    // signatures (compact length + 64 each) and the serialized message
    let message = tx.message.serialize();
    1 + 64 * tx.signatures.len() + message.len()
}

// ── Layout ────────────────────────────────────────────────────────

/// The backend reads the account at fixed offsets
/// (backend/src/chains/solana/policy-account.ts). Moving a field moves them.
#[test]
fn the_account_layout_is_the_one_the_backend_reads() {
    use beaver402_policy::state::{PaymentRecord, Policy, StoredLimits};
    use core::mem::{offset_of, size_of};

    assert_eq!(size_of::<Policy>(), 2960);
    assert_eq!(size_of::<PaymentRecord>(), 152);
    assert_eq!(size_of::<StoredLimits>(), 32);

    assert_eq!(offset_of!(Policy, owner_nonce), 0);
    assert_eq!(offset_of!(Policy, limits), 8);
    assert_eq!(offset_of!(StoredLimits, max_payment_amount), 0);
    assert_eq!(offset_of!(StoredLimits, max_total_amount), 8);
    assert_eq!(offset_of!(StoredLimits, window_size), 16);
    assert_eq!(offset_of!(StoredLimits, max_tx_count), 24);
    assert_eq!(offset_of!(Policy, slots), 40);
    assert_eq!(offset_of!(PaymentRecord, timestamp), 0);
    assert_eq!(offset_of!(PaymentRecord, amount), 8);
    assert_eq!(offset_of!(PaymentRecord, nonce), 16);
    assert_eq!(offset_of!(PaymentRecord, challenge_hash), 48);
    assert_eq!(offset_of!(PaymentRecord, intent_hash), 80);
    assert_eq!(offset_of!(PaymentRecord, merchant_pubkey), 112);
    assert_eq!(offset_of!(PaymentRecord, froze_account), 144);
    assert_eq!(offset_of!(Policy, merchants), 2472);
    assert_eq!(offset_of!(Policy, policy_id), 2728);
    assert_eq!(offset_of!(Policy, rp_id_hash), 2760);
    assert_eq!(offset_of!(Policy, network_id), 2792);
    assert_eq!(offset_of!(Policy, agent_signer), 2824);
    assert_eq!(offset_of!(Policy, asset), 2856);
    assert_eq!(offset_of!(Policy, recovery), 2888);
    assert_eq!(offset_of!(Policy, owner_prefix), 2920);
    assert_eq!(offset_of!(Policy, owner_x), 2921);
    assert_eq!(offset_of!(Policy, frozen), 2953);
    assert_eq!(offset_of!(Policy, merchant_count), 2954);
    assert_eq!(offset_of!(Policy, bump), 2955);
}
