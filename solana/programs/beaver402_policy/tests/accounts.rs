//! Account substitution. On Solana every account a program touches is named
//! by the caller, so each one the policy relies on has to be pinned: its own
//! policy account, its vault, the destination, the mint, the token program
//! and the instructions sysvar. Each test swaps one of them.

mod common;

use anchor_lang::prelude::Pubkey;
use common::*;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Positions in the pay instruction's account list.
const POLICY: usize = 1;
const MINT: usize = 2;
const VAULT: usize = 3;
const RECIPIENT_TOKEN: usize = 5;
const TOKEN_PROGRAM: usize = 6;
const INSTRUCTIONS: usize = 7;

fn assert_refused(result: Result<(), String>, reason: &str) {
    match result {
        Ok(()) => panic!("expected {reason}, but it went through"),
        Err(got) => assert_eq!(got, reason, "refused for the wrong reason"),
    }
}

/// Send a correctly signed payment after `tamper` has changed its accounts.
fn pay_with(env: &mut Env, tamper: impl FnOnce(&mut Vec<anchor_lang::solana_program::instruction::AccountMeta>)) -> Result<(), String> {
    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let mut pay = env.pay_instruction(&env.agent.pubkey(), &terms, &terms, env.recipient_token());
    tamper(&mut pay.accounts);
    let agent = env.agent.insecure_clone();
    env.send(&[signature, pay], &[&agent])
}

/// A second account of the same owner with the same agent, funded and with
/// the merchant approved. Returns its policy and vault and leaves the
/// helpers pointed at the first account again.
fn second_account(env: &mut Env) -> (Pubkey, Pubkey) {
    let first = env.policy_id;
    env.use_policy(sha256(b"beaver402 second policy"));
    env.initialize(pilot_limits()).unwrap();
    env.fund_vault(10_000_000);
    let merchant = env.merchant.pubkey();
    env.owner_action("add_merchant", Some(merchant), None, Assertion::default())
        .unwrap();
    let accounts = (env.policy, env.vault);
    env.use_policy(first);
    accounts
}

#[test]
fn refuses_to_pay_out_of_another_accounts_vault() {
    let mut env = Env::new();
    let (_, other_vault) = second_account(&mut env);
    let result = pay_with(&mut env, |accounts| accounts[VAULT].pubkey = other_vault);
    assert_refused(result, "ConstraintTokenOwner");
    assert_eq!(env.balance(&other_vault), 10_000_000);
    assert_eq!(env.balance(&env.recipient_token()), 0);
}

#[test]
fn refuses_another_account_paired_with_this_vault() {
    let mut env = Env::new();
    let (other_policy, _) = second_account(&mut env);
    let result = pay_with(&mut env, |accounts| accounts[POLICY].pubkey = other_policy);
    assert_refused(result, "ConstraintTokenOwner");
    assert_eq!(env.balance(&env.vault), 10_000_000);
}

#[test]
fn a_payment_spends_only_the_account_it_names() {
    let mut env = Env::new();
    let (other_policy, other_vault) = second_account(&mut env);
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
    assert_eq!(env.balance(&env.vault), 9_900_000);
    assert_eq!(env.balance(&other_vault), 10_000_000);

    // The nonce is spent on this account only, the other one never saw it.
    env.use_policy(sha256(b"beaver402 second policy"));
    assert_eq!(env.policy, other_policy);
    assert!(env.state().slots.iter().all(|slot| slot.amount == 0));
}

#[test]
fn refuses_a_forged_copy_of_the_policy_account() {
    let mut env = Env::new();
    // Copy the real account's bytes to an address the program owns but did
    // not derive, with the attacker as the agent.
    let attacker = Keypair::new();
    let real = env.svm.get_account(&env.policy).unwrap();
    let mut data = real.data.clone();
    let agent_at = 8 + 2824;
    data[agent_at..agent_at + 32].copy_from_slice(attacker.pubkey().as_ref());
    let forged = Pubkey::new_unique();
    env.svm
        .set_account(forged, Account { data, ..real })
        .unwrap();

    let terms = env.terms(100_000);
    let hash = env.challenge_hash(&terms);
    let signature = env.merchant_signature(&env.merchant, &hash);
    let mut pay = env.pay_instruction(&attacker.pubkey(), &terms, &terms, env.recipient_token());
    pay.accounts[POLICY].pubkey = forged;
    assert_refused(env.send(&[signature, pay], &[&attacker]), "ConstraintSeeds");
    assert_eq!(env.balance(&env.vault), 10_000_000);
}

#[test]
fn refuses_a_policy_account_owned_by_another_program() {
    let mut env = Env::new();
    let real = env.svm.get_account(&env.policy).unwrap();
    let foreign = Pubkey::new_unique();
    env.svm
        .set_account(
            foreign,
            Account {
                owner: anchor_lang::solana_program::system_program::ID,
                ..real
            },
        )
        .unwrap();
    let result = pay_with(&mut env, |accounts| accounts[POLICY].pubkey = foreign);
    assert_refused(result, "AccountOwnedByWrongProgram");
}

#[test]
fn refuses_a_token_account_of_another_mint_as_the_destination() {
    let mut env = Env::new();
    let other_mint = env.other_mint();
    let recipient = env.recipient.pubkey();
    let wrong = env.token_account_of(recipient, other_mint, 0);
    let result = pay_with(&mut env, |accounts| accounts[RECIPIENT_TOKEN].pubkey = wrong);
    assert_refused(result, "ConstraintAssociated");
}

#[test]
fn refuses_another_mint_even_with_a_matching_vault() {
    let mut env = Env::new();
    // The attacker gives the account a vault in a mint of their own, so the
    // vault constraint holds. The policy still pays in its own mint only.
    let other_mint = env.other_mint();
    let policy = env.policy;
    let recipient = env.recipient.pubkey();
    let other_vault = env.token_account_of(policy, other_mint, 5_000_000);
    let other_destination = env.token_account_of(recipient, other_mint, 0);
    let result = pay_with(&mut env, |accounts| {
        accounts[MINT].pubkey = other_mint;
        accounts[VAULT].pubkey = other_vault;
        accounts[RECIPIENT_TOKEN].pubkey = other_destination;
    });
    assert_refused(result, "AssetNotAllowed");
    assert_eq!(env.balance(&other_vault), 5_000_000);
}

#[test]
fn refuses_a_program_posing_as_the_token_program() {
    let mut env = Env::new();
    let result = pay_with(&mut env, |accounts| {
        accounts[TOKEN_PROGRAM].pubkey = anchor_lang::solana_program::system_program::ID;
    });
    assert_refused(result, "InvalidProgramId");
}

#[test]
fn refuses_a_forged_instructions_sysvar() {
    let mut env = Env::new();
    // An account that claims to list the transaction's instructions. The
    // program would read the merchant signature out of it if the address
    // were not pinned.
    let fake = Pubkey::new_unique();
    env.svm
        .set_account(
            fake,
            Account {
                lamports: 1_000_000,
                data: vec![0u8; 256],
                owner: Pubkey::new_unique(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let result = pay_with(&mut env, |accounts| accounts[INSTRUCTIONS].pubkey = fake);
    assert_refused(result, "ConstraintAddress");
}

#[test]
fn refuses_an_owner_action_with_a_forged_instructions_sysvar() {
    let mut env = Env::new();
    let (precompile, proof) = env.owner_assertion(&env.owner, "freeze_payments", None, None, &Assertion::default());
    let mut ix = env.owner_instruction("freeze_payments", None, None, proof);
    ix.accounts[1].pubkey = Pubkey::new_unique();
    assert_refused(env.send(&[precompile, ix], &[]), "ConstraintAddress");
    assert!(!env.state().is_frozen());
}

#[test]
fn recovery_refuses_a_vault_in_another_mint() {
    let mut env = Env::new();
    env.owner("freeze_payments").unwrap();
    let other_mint = env.other_mint();
    let policy = env.policy;
    let recovery = env.recovery.pubkey();
    let other_vault = env.token_account_of(policy, other_mint, 1_000_000);
    let other_destination = env.token_account_of(recovery, other_mint, 0);
    let (precompile, proof) = env.owner_assertion(&env.owner, "recover_funds", None, None, &Assertion::default());
    let mut ix = env.owner_instruction("recover_funds", None, None, proof);
    ix.accounts[1].pubkey = other_mint;
    ix.accounts[2].pubkey = other_vault;
    ix.accounts[4].pubkey = other_destination;
    assert_refused(env.send(&[precompile, ix], &[]), "ConstraintAddress");
    assert_eq!(env.balance(&env.vault), 10_000_000);
}

// ── Creating the account ──────────────────────────────────────────

#[test]
fn an_account_cannot_be_created_twice() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();

    // Someone tries to recreate it with their own agent and recovery address.
    let mut args = env.initialize_args(pilot_limits());
    args.agent_signer = Keypair::new().pubkey();
    args.recovery = Keypair::new().pubkey();
    assert!(env.initialize_with(args).is_err());

    let state = env.state();
    assert_eq!(state.agent_signer, env.agent.pubkey());
    assert_eq!(state.recovery, env.recovery.pubkey());
    assert!(state.slots.iter().any(|slot| slot.nonce == terms.nonce));
}

#[test]
fn refuses_an_account_without_an_agent() {
    let mut env = Env::bare();
    let mut args = env.initialize_args(pilot_limits());
    args.agent_signer = Pubkey::default();
    assert_refused(env.initialize_with(args), "InvalidConfig");
}

#[test]
fn refuses_an_account_without_a_recovery_address() {
    let mut env = Env::bare();
    let mut args = env.initialize_args(pilot_limits());
    args.recovery = Pubkey::default();
    assert_refused(env.initialize_with(args), "InvalidConfig");
}

#[test]
fn refuses_an_account_at_an_address_not_derived_from_its_id() {
    let mut env = Env::bare();
    let mut args = env.initialize_args(pilot_limits());
    args.policy_id = sha256(b"some other id");
    assert_refused(env.initialize_with(args), "ConstraintSeeds");
}

#[test]
fn a_new_account_starts_empty() {
    let mut env = Env::bare();
    env.initialize(pilot_limits()).unwrap();
    let state = env.state();
    assert_eq!(state.owner_nonce, 0);
    assert_eq!(state.merchant_count, 0);
    assert!(state.slots.iter().all(|slot| slot.amount == 0));
    assert_eq!(state.network_id, sha256(DEVNET.as_bytes()));
    assert_eq!(state.rp_id_hash, sha256(RP_ID.as_bytes()));
}
