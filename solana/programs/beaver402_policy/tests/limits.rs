//! The limits at their edges, and a long run of random payments checked
//! against a model of what the owner configured.

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

fn paid_slots(env: &Env) -> usize {
    env.state().slots.iter().filter(|slot| slot.amount > 0).count()
}

// ── Edges ─────────────────────────────────────────────────────────

#[test]
fn a_payment_of_exactly_the_per_payment_limit_is_allowed() {
    let mut env = Env::new();
    let terms = env.terms(1_000_000);
    env.pay(&terms).unwrap();
    assert_eq!(env.balance(&env.recipient_token()), 1_000_000);
}

#[test]
fn a_challenge_valid_for_exactly_the_maximum_is_allowed() {
    let mut env = Env::new();
    let mut terms = env.terms(100_000);
    terms.expiry = env.now() + 900;
    env.pay(&terms).unwrap();
}

#[test]
fn a_challenge_is_still_good_in_its_last_second() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    env.advance(300);
    assert_eq!(env.now(), terms.expiry);
    env.pay(&terms).unwrap();
}

#[test]
fn a_replay_is_refused_for_as_long_as_the_challenge_is_valid() {
    let mut env = Env::new();
    let mut terms = env.terms(100_000);
    terms.expiry = env.now() + 900;
    env.pay(&terms).unwrap();
    for step in [1, 300, 599] {
        env.advance(step);
        assert_refused(env.pay(&terms), "NonceReused");
    }
    env.advance(1);
    assert_refused(env.pay(&terms), "ChallengeExpired");
    assert_eq!(env.balance(&env.recipient_token()), 100_000);
}

#[test]
fn a_nonce_is_remembered_across_freeze_and_restore() {
    let mut env = Env::new();
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
    env.owner("freeze_payments").unwrap();
    env.owner("restore_payments").unwrap();
    assert_refused(env.pay(&terms), "NonceReused");
}

#[test]
fn the_same_nonce_for_another_amount_is_still_a_replay() {
    // A merchant that signs two challenges with one nonce gets paid once.
    let mut env = Env::new();
    let first = env.terms(100_000);
    env.pay(&first).unwrap();
    let mut second = env.terms(200_000);
    second.nonce = first.nonce;
    assert_refused(env.pay(&second), "NonceReused");
}

#[test]
fn the_window_slides_rather_than_resetting_at_a_boundary() {
    // Two payments early in the window and three at its very end fill it.
    // A window that reset at a fixed time would allow five more at once.
    let mut env = Env::new();
    for _ in 0..2 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    env.advance(86_000);
    for _ in 0..3 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    assert!(env.state().is_frozen());
    env.owner("restore_payments").unwrap();

    // The first two leave the window; only two places open up.
    env.advance(400);
    for _ in 0..2 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    env.owner("restore_payments").unwrap();
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "VelocityExceeded");
}

#[test]
fn a_payment_counts_until_the_last_second_of_its_window() {
    let mut env = Env::new();
    for _ in 0..5 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    env.owner("restore_payments").unwrap();
    env.advance(86_399);
    let terms = env.terms(100_000);
    assert_refused(env.pay(&terms), "VelocityExceeded");
    env.advance(1);
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
}

#[test]
fn every_slot_is_used_and_then_reused() {
    let limits = VelocityConfig {
        max_payment_amount: 1_000_000,
        max_tx_count: 16,
        max_total_amount: 16_000_000,
        window_size: 900,
    };
    let mut env = Env::with_limits(limits);
    for round in 0..3 {
        for _ in 0..16 {
            let terms = env.terms(100_000);
            env.pay(&terms).unwrap();
        }
        assert_eq!(paid_slots(&env), 16);
        assert!(env.state().is_frozen(), "round {round} should end frozen");
        env.owner("restore_payments").unwrap();
        let terms = env.terms(100_000);
        assert_refused(env.pay(&terms), "VelocityExceeded");
        env.advance(900);
    }
    assert_eq!(env.balance(&env.recipient_token()), 48 * 100_000);
}

#[test]
fn a_total_that_would_overflow_is_refused() {
    let limits = VelocityConfig {
        max_payment_amount: u64::MAX,
        max_tx_count: 5,
        max_total_amount: u64::MAX,
        window_size: 86_400,
    };
    let mut env = Env::with_limits(limits);
    env.fund_vault(u64::MAX);
    let terms = env.terms(2);
    env.pay(&terms).unwrap();
    let terms = env.terms(u64::MAX - 1);
    assert_refused(env.pay(&terms), "VelocityExceeded");
}

// ── Nothing half done ─────────────────────────────────────────────

#[test]
fn a_payment_the_vault_cannot_cover_leaves_no_trace() {
    let mut env = Env::new();
    env.fund_vault(50_000);
    let terms = env.terms(100_000);
    assert!(env.pay(&terms).is_err());
    assert_eq!(paid_slots(&env), 0);
    assert_eq!(env.balance(&env.vault), 50_000);

    // The nonce was not spent, so the same challenge pays once funded.
    env.fund_vault(1_000_000);
    env.pay(&terms).unwrap();
    assert_eq!(env.balance(&env.recipient_token()), 100_000);
}

#[test]
fn a_refused_payment_does_not_count() {
    let mut env = Env::new();
    for _ in 0..4 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    let too_big = env.terms(1_000_001);
    assert_refused(env.pay(&too_big), "PaymentLimitExceeded");
    let terms = env.terms(100_000);
    assert_refused(env.pay_signed_for(&terms, &{
        let mut t = terms.clone();
        t.amount = 200_000;
        t
    }), "InvalidMerchantSignature");
    assert_eq!(paid_slots(&env), 4);
    assert!(!env.state().is_frozen());
    env.pay(&terms).unwrap();
    assert!(env.state().is_frozen());
}

#[test]
fn the_payment_that_freezes_the_account_is_paid_and_marked() {
    let mut env = Env::new();
    for _ in 0..4 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    let last = env.terms(100_000);
    env.pay(&last).unwrap();
    assert_eq!(env.balance(&env.recipient_token()), 500_000);
    let state = env.state();
    let slot = state.slots.iter().find(|slot| slot.nonce == last.nonce).unwrap();
    assert_eq!(slot.froze_account, 1);
    assert_eq!(
        state.slots.iter().filter(|slot| slot.froze_account == 1).count(),
        1
    );
}

// ── Against a model ──────────────────────────────────────────────

/// A small deterministic generator, so a failing run can be repeated.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// What the owner configured, written down independently of the program:
/// payments in the last window_size seconds, at most max_tx_count of them,
/// adding up to at most max_total_amount, each at most max_payment_amount,
/// and the one that reaches either limit freezes the account.
struct Model {
    limits: VelocityConfig,
    frozen: bool,
    paid: Vec<(u64, u64, [u8; 32])>,
}

impl Model {
    fn in_window(&self, now: u64) -> impl Iterator<Item = &(u64, u64, [u8; 32])> {
        let window = self.limits.window_size;
        self.paid.iter().filter(move |(at, _, _)| now - at < window)
    }

    fn decide(&self, amount: u64, nonce: &[u8; 32], now: u64) -> Result<bool, &'static str> {
        if self.frozen {
            return Err("AccountFrozen");
        }
        if amount == 0 {
            return Err("InvalidAmount");
        }
        if amount > self.limits.max_payment_amount {
            return Err("PaymentLimitExceeded");
        }
        if self.in_window(now).any(|(_, _, n)| n == nonce) {
            return Err("NonceReused");
        }
        let count = self.in_window(now).count() as u32;
        let total: u64 = self.in_window(now).map(|(_, a, _)| a).sum();
        if count >= self.limits.max_tx_count || total + amount > self.limits.max_total_amount {
            return Err("VelocityExceeded");
        }
        Ok(count + 1 >= self.limits.max_tx_count || total + amount >= self.limits.max_total_amount)
    }
}

fn run_against_model(seed: u64, steps: usize) {
    let limits = VelocityConfig {
        max_payment_amount: 1_000_000,
        max_tx_count: 6,
        max_total_amount: 3_000_000,
        window_size: 3_600,
    };
    let mut env = Env::with_limits(limits);
    env.fund_vault(1_000_000_000_000);
    let start = env.balance(&env.vault);
    let mut model = Model {
        limits,
        frozen: false,
        paid: Vec::new(),
    };
    let mut rng = Rng(seed);

    for step in 0..steps {
        match rng.below(10) {
            0..=5 => {
                // Mostly fair amounts, sometimes zero, over the limit, or
                // exactly at or one past what is left of the total.
                let now = env.now();
                let left = limits.max_total_amount - model.in_window(now).map(|(_, a, _)| a).sum::<u64>();
                let amount = match rng.below(10) {
                    0 => 0,
                    1 => 1_000_001 + rng.below(1_000),
                    2 => left,
                    3 => left + 1,
                    _ => 1 + rng.below(1_000_000),
                };
                let mut terms = env.terms(amount);
                // Now and then replay a nonce still inside its challenge
                // lifetime.
                if rng.below(6) == 0 {
                    let now = env.now();
                    if let Some((_, _, nonce)) = model.paid.iter().rev().find(|(at, _, _)| now - at < 600) {
                        terms.nonce = *nonce;
                    }
                }
                let now = env.now();
                let expected = model.decide(amount, &terms.nonce, now);
                let got = env.pay(&terms);
                match (&expected, &got) {
                    (Ok(froze), Ok(())) => {
                        model.paid.push((now, amount, terms.nonce));
                        if *froze {
                            model.frozen = true;
                        }
                        assert_eq!(env.state().is_frozen(), model.frozen, "seed {seed} step {step}");
                    }
                    (Err(want), Err(got)) => assert_eq!(got, want, "seed {seed} step {step}"),
                    _ => panic!("seed {seed} step {step}: model {expected:?}, program {got:?}"),
                }
            }
            6..=7 => env.advance(rng.below(1_500) as i64),
            8 => {
                if model.frozen {
                    env.owner("restore_payments").unwrap();
                    model.frozen = false;
                }
            }
            _ => {
                if !model.frozen && rng.below(3) == 0 {
                    env.owner("freeze_payments").unwrap();
                    model.frozen = true;
                }
            }
        }

        // What the owner was promised, checked directly every step.
        let now = env.now();
        let window: Vec<_> = model.in_window(now).collect();
        assert!(window.len() as u32 <= limits.max_tx_count);
        assert!(window.iter().map(|(_, a, _)| a).sum::<u64>() <= limits.max_total_amount);
    }

    let spent: u64 = model.paid.iter().map(|(_, a, _)| a).sum();
    assert_eq!(env.balance(&env.recipient_token()), spent, "seed {seed}");
    assert_eq!(env.balance(&env.vault), start - spent, "seed {seed}");
    assert!(model.paid.len() > 10, "seed {seed} should have paid something");
}

#[test]
fn random_payments_match_the_model_seed_1() {
    run_against_model(0x9E37_79B9_7F4A_7C15, 250);
}

#[test]
fn random_payments_match_the_model_seed_2() {
    run_against_model(0xD1B5_4A32_D192_ED03, 250);
}

#[test]
fn random_payments_match_the_model_seed_3() {
    run_against_model(0x94D0_49BB_1331_11EB, 250);
}

#[test]
fn random_payments_match_the_model_seed_4() {
    run_against_model(0xBF58_476D_1CE4_E5B9, 250);
}

#[test]
fn a_new_agent_spends_from_the_same_window() {
    // Replacing the agent does not hand out a fresh budget.
    let mut env = Env::new();
    for _ in 0..4 {
        let terms = env.terms(100_000);
        env.pay(&terms).unwrap();
    }
    let new_agent = Keypair::new();
    env.owner_action("set_agent_signer", Some(new_agent.pubkey()), None, Assertion::default())
        .unwrap();
    env.agent = new_agent;
    let terms = env.terms(100_000);
    env.pay(&terms).unwrap();
    assert!(env.state().is_frozen());
}
