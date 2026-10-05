//! What the program writes to the ledger. The collector and the status page
//! read these events, and the proof of intent is the public record that a
//! payment was the one both sides agreed on.

mod common;

use beaver402_policy::constants::{CHALLENGE_DOMAIN, INTENT_DOMAIN};
use beaver402_policy::encoding::{domain_separated_hash, settlement_preimage, Settlement};
use beaver402_policy::state::{
    FundsRecovered, LimitsReduced, MerchantAdded, PaymentsFrozen, PaymentsRestored, PolicyCreated, ProofOfIntent,
    SignerRevoked,
};
use common::*;
use solana_signer::Signer;

fn pay_logs(env: &mut Env, terms: &Terms) -> Vec<String> {
    let hash = env.challenge_hash(terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let pay = env.pay_instruction(&env.agent.pubkey(), terms, terms, env.recipient_token());
    let agent = env.agent.insecure_clone();
    env.send_logs(&[signature, pay], &[&agent]).unwrap()
}

fn owner_logs(env: &mut Env, action: &str) -> Vec<String> {
    let (precompile, proof) = env.owner_assertion(&env.owner, action, None, None, &Assertion::default());
    let ix = env.owner_instruction(action, None, None, proof);
    env.send_logs(&[precompile, ix], &[]).unwrap()
}

#[test]
fn a_payment_publishes_its_proof_of_intent() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    let logs = pay_logs(&mut env, &terms);
    let proofs = events::<ProofOfIntent>(&logs);
    assert_eq!(proofs.len(), 1);
    let proof = &proofs[0];

    let network_id = sha256(DEVNET.as_bytes());
    let preimage = settlement_preimage(&Settlement {
        request_digest: &terms.request_digest,
        recipient: &terms.recipient,
        asset: &env.mint,
        amount: terms.amount,
        network_id: &network_id,
        nonce: &terms.nonce,
        expiry: terms.expiry,
    });
    assert_eq!(proof.policy, env.policy);
    assert_eq!(proof.nonce, terms.nonce);
    assert_eq!(proof.challenge_hash, domain_separated_hash(CHALLENGE_DOMAIN, &preimage));
    assert_eq!(proof.intent_hash, domain_separated_hash(INTENT_DOMAIN, &preimage));
    assert_eq!(proof.merchant_pubkey, env.merchant.pubkey());
    assert_eq!(proof.recipient, env.recipient.pubkey());
    assert_eq!(proof.amount, 100_000);
    assert!(events::<PaymentsFrozen>(&logs).is_empty());
}

#[test]
fn the_proof_matches_what_the_account_recorded() {
    let mut env = Env::new();
    let terms = env.terms(250_000);
    let logs = pay_logs(&mut env, &terms);
    let proof = events::<ProofOfIntent>(&logs).remove(0);
    let state = env.state();
    let slot = state.slots.iter().find(|slot| slot.nonce == terms.nonce).unwrap();
    assert_eq!(slot.challenge_hash, proof.challenge_hash);
    assert_eq!(slot.intent_hash, proof.intent_hash);
    assert_eq!(slot.amount, proof.amount);
    assert_eq!(slot.merchant_pubkey, proof.merchant_pubkey);
}

#[test]
fn the_payment_that_fills_the_window_says_it_froze_the_account() {
    let mut env = Env::new();
    for _ in 0..4 {
        let terms = env.terms(100_000);
        pay_logs(&mut env, &terms);
    }
    let terms = env.terms(100_000);
    let logs = pay_logs(&mut env, &terms);
    assert_eq!(events::<ProofOfIntent>(&logs).len(), 1);
    let frozen = events::<PaymentsFrozen>(&logs);
    assert_eq!(frozen.len(), 1);
    assert_eq!(frozen[0].tx_count, 5);
    assert_eq!(frozen[0].total_amount, 500_000);
    assert_eq!(frozen[0].reason, beaver402_policy::state::FROZEN_VELOCITY);
}

#[test]
fn freezing_and_restoring_are_announced_with_the_window() {
    let mut env = Env::new();
    for _ in 0..2 {
        let terms = env.terms(300_000);
        pay_logs(&mut env, &terms);
    }
    let frozen = events::<PaymentsFrozen>(&owner_logs(&mut env, "freeze_payments"));
    assert_eq!(frozen.len(), 1);
    assert_eq!(frozen[0].reason, beaver402_policy::state::FROZEN_MANUAL);
    assert_eq!(frozen[0].tx_count, 2);
    assert_eq!(frozen[0].total_amount, 600_000);

    let restored = events::<PaymentsRestored>(&owner_logs(&mut env, "restore_payments"));
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].tx_count, 2);
    assert_eq!(restored[0].total_amount, 600_000);
}

#[test]
fn owner_actions_name_what_they_changed() {
    let mut env = Env::new();
    let revoked = events::<SignerRevoked>(&owner_logs(&mut env, "revoke_agent_signer"));
    assert_eq!(revoked[0].pubkey, env.agent.pubkey());

    let merchant = solana_keypair::Keypair::new().pubkey();
    let (precompile, proof) = env.owner_assertion(&env.owner, "add_merchant", Some(merchant), None, &Assertion::default());
    let ix = env.owner_instruction("add_merchant", Some(merchant), None, proof);
    let added = events::<MerchantAdded>(&env.send_logs(&[precompile, ix], &[]).unwrap());
    assert_eq!(added[0].pubkey, merchant);

    let mut lower = pilot_limits();
    lower.max_tx_count = 2;
    let (precompile, proof) = env.owner_assertion(&env.owner, "reduce_limits", None, Some(lower), &Assertion::default());
    let ix = env.owner_instruction("reduce_limits", None, Some(lower), proof);
    let reduced = events::<LimitsReduced>(&env.send_logs(&[precompile, ix], &[]).unwrap());
    assert_eq!(reduced[0].max_tx_count, 2);
    assert_eq!(reduced[0].policy, env.policy);
}

#[test]
fn a_recovery_records_where_the_money_went() {
    let mut env = Env::new();
    owner_logs(&mut env, "freeze_payments");
    let recovered = events::<FundsRecovered>(&owner_logs(&mut env, "recover_funds"));
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].recovery, env.recovery.pubkey());
    assert_eq!(recovered[0].amount, 10_000_000);
}

#[test]
fn creating_the_account_announces_its_fixed_parameters() {
    let mut env = Env::bare();
    let args = env.initialize_args(pilot_limits());
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: program_id(),
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &beaver402_policy::accounts::Initialize {
                payer: env.payer.pubkey(),
                policy: env.policy,
                mint: env.mint,
                vault: env.vault,
                token_program: spl_token_interface::ID,
                associated_token_program: spl_associated_token_account_interface::program::ID,
                system_program: anchor_lang::solana_program::system_program::ID,
            },
            None,
        ),
        data: anchor_lang::InstructionData::data(&beaver402_policy::instruction::Initialize { args }),
    };
    let created = events::<PolicyCreated>(&env.send_logs(&[ix], &[]).unwrap());
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].policy, env.policy);
    assert_eq!(created[0].agent_signer, env.agent.pubkey());
    assert_eq!(created[0].asset, env.mint);
    assert_eq!(created[0].recovery, env.recovery.pubkey());
}
