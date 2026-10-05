//! The precompile instructions, from the side of someone trying to get a
//! signature accepted that the merchant or the owner never made. The runtime
//! verifies a precompile's signature over whatever bytes its offsets name;
//! the program has to make sure those are the bytes it compares.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use beaver402_policy::constants::INTENT_DOMAIN;
use beaver402_policy::encoding::{domain_separated_hash, settlement_preimage, Settlement};
use common::*;
use solana_keypair::Keypair;
use solana_signer::Signer;

fn assert_refused(result: Result<(), String>, reason: &str) {
    match result {
        Ok(()) => panic!("expected {reason}, but it went through"),
        Err(got) => assert_eq!(got, reason, "refused for the wrong reason"),
    }
}

/// Byte positions in an ed25519 precompile instruction built by
/// new_ed25519_instruction_with_signature: two header bytes, then the
/// offsets of its one signature.
const SIGNATURE_INDEX: usize = 4;
const PUBLIC_KEY_INDEX: usize = 8;
const MESSAGE_INDEX: usize = 14;

/// Send a payment whose merchant signature instruction has been changed by
/// `tamper`. The signature instruction is the first in the transaction.
fn pay_with_signature(env: &mut Env, signature: Instruction, terms: &Terms) -> Result<(), String> {
    let pay = env.pay_instruction(&env.agent.pubkey(), terms, terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    env.send(&[signature, pay], &[&agent])
}

/// One ed25519 precompile instruction verifying several signatures, each
/// with its key, signature and message inside the instruction.
fn ed25519_many(entries: &[(&Keypair, &[u8])]) -> Instruction {
    let header = 2 + 14 * entries.len();
    let mut offsets = Vec::new();
    let mut body = Vec::new();
    for (signer, message) in entries {
        let signature: [u8; 64] = signer.sign_message(message).into();
        let key_at = header + body.len();
        body.extend_from_slice(signer.pubkey().as_ref());
        let signature_at = header + body.len();
        body.extend_from_slice(&signature);
        let message_at = header + body.len();
        body.extend_from_slice(message);
        for value in [
            signature_at as u16,
            u16::MAX,
            key_at as u16,
            u16::MAX,
            message_at as u16,
            message.len() as u16,
            u16::MAX,
        ] {
            offsets.extend_from_slice(&value.to_le_bytes());
        }
    }
    let mut data = vec![entries.len() as u8, 0];
    data.extend_from_slice(&offsets);
    data.extend_from_slice(&body);
    Instruction {
        program_id: solana_sdk_ids::ed25519_program::ID,
        accounts: vec![],
        data,
    }
}

fn intent_hash(env: &Env, terms: &Terms) -> [u8; 32] {
    let network_id = sha256(terms.network.as_bytes());
    domain_separated_hash(
        INTENT_DOMAIN,
        &settlement_preimage(&Settlement {
            request_digest: &terms.request_digest,
            recipient: &terms.recipient,
            asset: &env.mint,
            amount: terms.amount,
            network_id: &network_id,
            nonce: &terms.nonce,
            expiry: terms.expiry,
        }),
    )
}

// ── Where the verified bytes come from ───────────────────────────

/// The precompile accepts an explicit index for its own instruction as well
/// as the "this instruction" marker, and verifies the same bytes. The
/// program only accepts the marker, so these are refused by the program
/// itself rather than by a failing signature.
#[test]
fn refuses_a_signature_read_through_an_explicit_index() {
    for field in [SIGNATURE_INDEX, PUBLIC_KEY_INDEX, MESSAGE_INDEX] {
        let mut env = Env::new();
        let terms = env.terms(100_000);
        let hash = env.challenge_hash(&terms);
        let mut signature = env.merchant_signature(&env.merchant, &hash);
        signature.data[field] = 0;
        signature.data[field + 1] = 0;
        assert_refused(pay_with_signature(&mut env, signature, &terms), "InvalidSignatureFormat");
        assert_eq!(env.balance(&env.recipient_token()), 0);
    }
}

#[test]
fn refuses_a_key_read_from_the_payment_instruction() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let mut signature = env.merchant_signature(&env.merchant, &hash);
    // The pay instruction carries the merchant key in its arguments. Point
    // the precompile at it: the signature no longer verifies, or if it did,
    // the program would not have read the key it checked.
    signature.data[PUBLIC_KEY_INDEX] = 1;
    signature.data[PUBLIC_KEY_INDEX + 1] = 0;
    assert!(pay_with_signature(&mut env, signature, &terms).is_err());
    assert_eq!(env.balance(&env.recipient_token()), 0);
}

#[test]
fn refuses_a_precompile_instruction_with_no_signature() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let empty = Instruction {
        program_id: solana_sdk_ids::ed25519_program::ID,
        accounts: vec![],
        data: vec![0, 0],
    };
    assert_refused(pay_with_signature(&mut env, empty, &terms), "InvalidSignatureFormat");
}

#[test]
fn refuses_a_precompile_instruction_with_two_signatures() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let merchant = env.merchant.insecure_clone();
    let both = ed25519_many(&[(&merchant, &hash), (&merchant, b"anything else")]);
    assert_refused(pay_with_signature(&mut env, both, &terms), "InvalidSignatureFormat");
}

#[test]
fn a_hand_built_single_signature_instruction_is_accepted() {
    // The layout check is about the meaning of the offsets, not about the
    // one helper that happens to build them.
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let merchant = env.merchant.insecure_clone();
    let one = ed25519_many(&[(&merchant, &hash)]);
    pay_with_signature(&mut env, one, &terms).unwrap();
    assert_eq!(env.balance(&env.recipient_token()), 100_000);
}

#[test]
fn the_merchant_signature_may_come_after_the_payment() {
    // The runtime verifies every precompile before the program runs, so the
    // position does not matter; what the program reads is the same.
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    env.send(&[pay, signature], &[&agent]).unwrap();
}

// ── What the merchant signed ─────────────────────────────────────

#[test]
fn refuses_a_merchant_signature_over_the_intent_hash() {
    // Same fields, other domain: a signature on the agent's intent must not
    // pass as the merchant's challenge.
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let intent = intent_hash(&env, &terms);
    let signature = env.merchant_signature(&env.merchant, &intent);
    assert_refused(pay_with_signature(&mut env, signature, &terms), "InvalidMerchantSignature");
}

#[test]
fn refuses_a_merchant_signature_over_more_than_the_hash() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let mut message = env.challenge_hash(&terms).to_vec();
    message.push(0);
    let merchant = env.merchant.insecure_clone();
    let signature = ed25519_many(&[(&merchant, &message)]);
    assert_refused(pay_with_signature(&mut env, signature, &terms), "InvalidMerchantSignature");
}

#[test]
fn refuses_a_merchant_signature_over_part_of_the_hash() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let merchant = env.merchant.insecure_clone();
    let signature = ed25519_many(&[(&merchant, &hash[..31])]);
    assert_refused(pay_with_signature(&mut env, signature, &terms), "InvalidMerchantSignature");
}

#[test]
fn refuses_the_agent_signing_as_the_merchant() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.agent, &hash);
    assert_refused(pay_with_signature(&mut env, signature, &terms), "InvalidMerchantSignature");
}

#[test]
fn refuses_an_approved_merchant_signing_for_another_approved_merchant() {
    // Two merchants on the list. The second one signs a challenge, the
    // payment names the first. The key that signed has to be the key named.
    let mut env = Env::new();
    let second = Keypair::new();
    env.owner_action("add_merchant", Some(second.pubkey()), None, Assertion::default())
        .unwrap();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&second, &hash);
    assert_refused(pay_with_signature(&mut env, signature, &terms), "InvalidMerchantSignature");
}

#[test]
fn refuses_a_passkey_signature_on_the_payment_path() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let (passkey_signature, _) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    assert_refused(
        env.send(&[passkey_signature, signature, pay], &[&agent]),
        "UnexpectedInstruction",
    );
}

// ── Who signs the transaction ────────────────────────────────────

#[test]
fn the_merchant_as_fee_payer_cannot_pay_itself() {
    // The merchant settles the payment and signs it as the fee payer. It
    // must not be able to stand in for the agent as well.
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let merchant = env.merchant.insecure_clone();
    let pay = env.pay_instruction(&merchant.pubkey(), &terms, &terms, env.recipient_token());
    assert_refused(env.send(&[signature, pay], &[&merchant]), "InvalidBuyerSigner");
}

#[test]
fn the_fee_payer_cannot_stand_in_for_the_agent() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let payer = env.payer.pubkey();
    let pay = env.pay_instruction(&payer, &terms, &terms, env.recipient_token());
    assert_refused(env.send(&[signature, pay], &[]), "InvalidBuyerSigner");
}

#[test]
fn refuses_a_payment_the_agent_did_not_sign() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let mut pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    pay.accounts[0].is_signer = false;
    assert_refused(env.send(&[signature, pay], &[]), "AccountNotSigner");
    assert_eq!(env.balance(&env.recipient_token()), 0);
}

// ── The owner path ───────────────────────────────────────────────

#[test]
fn refuses_two_passkey_signatures_for_one_owner_action() {
    let mut env = Env::new();
    let (first, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let (second, _) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[first, second, ix], &[]), "UnexpectedInstruction");
    assert!(!env.state().is_frozen());
}

#[test]
fn refuses_two_owner_actions_on_one_assertion() {
    let mut env = Env::new();
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let freeze = env.owner_instruction("freeze_payments", None, None, proof.clone());
    let again = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, freeze, again], &[]), "UnexpectedInstruction");
}

#[test]
fn refuses_a_passkey_signature_read_through_an_explicit_index() {
    let mut env = Env::new();
    let (mut precompile, proof) =
        env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    precompile.data[MESSAGE_INDEX] = 0;
    precompile.data[MESSAGE_INDEX + 1] = 0;
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    assert_refused(env.send(&[precompile, ix], &[]), "InvalidSignatureFormat");
    assert!(!env.state().is_frozen());
}

#[test]
fn an_owner_action_accepts_compute_budget_instructions() {
    let mut env = Env::new();
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let ix = env.owner_instruction("freeze_payments", None, None, proof);
    // SetComputeUnitPrice(1)
    let mut data = vec![3u8];
    data.extend_from_slice(&1u64.to_le_bytes());
    let price = Instruction {
        program_id: solana_sdk_ids::compute_budget::ID,
        accounts: vec![],
        data,
    };
    env.send(&[price, precompile, ix], &[]).unwrap();
    assert!(env.state().is_frozen());
}

#[test]
fn refuses_a_compute_budget_lookalike() {
    // An instruction for a program that is not the compute budget program,
    // carrying compute budget data, is just another instruction.
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    let mut data = vec![2u8];
    data.extend_from_slice(&300_000u32.to_le_bytes());
    let lookalike = Instruction {
        program_id: Pubkey::new_unique(),
        accounts: vec![],
        data,
    };
    let agent = env.agent.insecure_clone();
    assert!(env.send(&[lookalike, signature, pay], &[&agent]).is_err());
    assert_eq!(env.balance(&env.recipient_token()), 0);
}
