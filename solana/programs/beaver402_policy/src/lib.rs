//! Beaver402 payment policy account for Solana.
//!
//! The Solana counterpart of contracts/payment_policy. The account answers to
//! two parties. The agent key may spend, and only a payment both the merchant
//! and the agent describe identically, within the owner's limits. The owner
//! passkey may administer the account, and nothing else may.
//!
//! On Stellar the policy runs inside a standard token transfer, through the
//! smart account's __check_auth. Solana has no such hook, so the money moves
//! by this program's `pay` instruction, which the merchant settles. See
//! docs/solana/design.md.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

pub mod constants;
pub mod encoding;
pub mod error;
pub mod introspection;
pub mod owner;
pub mod state;
pub mod velocity;

use constants::*;
use encoding::{domain_separated_hash, settlement_preimage, Settlement};
use error::PolicyError;
use introspection::verified_by_precompile;
use owner::OwnerProof;
use state::*;

declare_id!("6PLoS71vwBV76RnRWuT3yoPHqzXrBdkW53Dn3BL9Uhx5");

/// What the agent presents with a payment: the fields both sides claim to
/// have agreed on. The challenge and intent hashes are deliberately absent;
/// the program derives them, which is what makes the merchant signature a
/// statement about this exact recipient, mint and amount.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PayArgs {
    pub merchant_pubkey: Pubkey,
    /// Hash of the HTTP side of the paid request. The endpoint and the body
    /// stay off the ledger.
    pub request_digest: [u8; 32],
    pub amount: u64,
    pub nonce: [u8; 32],
    pub expiry: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitializeArgs {
    pub policy_id: [u8; 32],
    pub owner: [u8; 33],
    pub rp_id_hash: [u8; 32],
    pub network_id: [u8; 32],
    pub agent_signer: Pubkey,
    pub recovery: Pubkey,
    pub velocity: VelocityConfig,
}

/// How an owner action's arguments enter its passkey challenge. Fixed width
/// and big endian, like the settlement preimage.
pub fn limits_bytes(config: &VelocityConfig) -> [u8; 28] {
    let mut out = [0u8; 28];
    out[0..8].copy_from_slice(&config.max_payment_amount.to_be_bytes());
    out[8..12].copy_from_slice(&config.max_tx_count.to_be_bytes());
    out[12..20].copy_from_slice(&config.max_total_amount.to_be_bytes());
    out[20..28].copy_from_slice(&config.window_size.to_be_bytes());
    out
}

fn now() -> Result<u64> {
    Ok(Clock::get()?.unix_timestamp.max(0) as u64)
}

#[program]
pub mod beaver402_policy {
    use super::*;

    /// Create the account.
    ///
    /// Everything that decides where money can go is fixed here: the owner
    /// passkey and its domain, the cluster, the mint and the recovery
    /// address. The limits can only be lowered afterwards.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        if !velocity::is_valid(&args.velocity) {
            return err!(PolicyError::InvalidConfig);
        }
        if args.owner[0] != 0x02 && args.owner[0] != 0x03 {
            return err!(PolicyError::InvalidConfig);
        }
        let policy_key = ctx.accounts.policy.key();
        if args.agent_signer == Pubkey::default()
            || args.recovery == Pubkey::default()
            || args.recovery == policy_key
        {
            return err!(PolicyError::InvalidConfig);
        }

        // The merchant list and the payment slots start out zeroed, which is
        // empty for both.
        let mut policy = ctx.accounts.policy.load_init()?;
        policy.policy_id = args.policy_id;
        policy.owner_prefix = args.owner[0];
        policy.owner_x.copy_from_slice(&args.owner[1..]);
        policy.rp_id_hash = args.rp_id_hash;
        policy.network_id = args.network_id;
        policy.agent_signer = args.agent_signer;
        policy.asset = ctx.accounts.mint.key();
        policy.recovery = args.recovery;
        policy.limits = args.velocity.into();
        policy.bump = ctx.bumps.policy;

        emit!(PolicyCreated {
            policy: policy_key,
            agent_signer: args.agent_signer,
            asset: policy.asset,
            recovery: args.recovery,
        });
        Ok(())
    }

    /// Pay a merchant, if the payment is the one both sides agreed on.
    ///
    /// The checks run in the order of the Soroban contract's
    /// check_payment_authorization, so a refusal names the same reason.
    pub fn pay(ctx: Context<Pay>, args: PayArgs) -> Result<()> {
        let policy_key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;

        // 1. Refuse everything while the account is frozen
        if policy.is_frozen() {
            return err!(PolicyError::AccountFrozen);
        }

        // 2. The delegated signer has to exist and have signed
        if policy.agent_revoked() {
            return err!(PolicyError::SignerRevoked);
        }
        if ctx.accounts.agent.key() != policy.agent_signer {
            return err!(PolicyError::InvalidBuyerSigner);
        }

        // 3. The merchant has to be on the allowlist
        if !policy.is_merchant(&args.merchant_pubkey) {
            return err!(PolicyError::UnauthorizedMerchant);
        }

        // 4. The account pays in one mint only. The vault and the
        //    destination are pinned to it by the account constraints.
        if ctx.accounts.mint.key() != policy.asset {
            return err!(PolicyError::AssetNotAllowed);
        }

        // 5. A real payment within the per payment limit
        if args.amount == 0 {
            return err!(PolicyError::InvalidAmount);
        }
        if args.amount > policy.limits.max_payment_amount {
            return err!(PolicyError::PaymentLimitExceeded);
        }

        // 6. Expiry. Unset is invalid rather than eternal, and a challenge
        //    may not outlive the replay record below.
        let now = now()?;
        if args.expiry == 0 || now > args.expiry {
            return err!(PolicyError::ChallengeExpired);
        }
        if args.expiry - now > MAX_CHALLENGE_LIFETIME {
            return err!(PolicyError::ExpiryTooFar);
        }

        // 7. Rebuild both hashes from the fields. The cluster comes from the
        //    account, the recipient and mint from the accounts the transfer
        //    actually uses.
        let recipient = ctx.accounts.recipient.key();
        let asset = ctx.accounts.mint.key();
        let preimage = settlement_preimage(&Settlement {
            request_digest: &args.request_digest,
            recipient: &recipient,
            asset: &asset,
            amount: args.amount,
            network_id: &policy.network_id,
            nonce: &args.nonce,
            expiry: args.expiry,
        });
        let challenge_hash = domain_separated_hash(CHALLENGE_DOMAIN, &preimage);
        let intent_hash = domain_separated_hash(INTENT_DOMAIN, &preimage);

        // 8. The merchant signature, verified by the ed25519 precompile in
        //    this transaction, has to be over the challenge hash derived here.
        //    The layout check also refuses any instruction besides compute
        //    budget, that precompile and this payment, so an agreed payment
        //    cannot carry another one along.
        let verified = verified_by_precompile(
            &ctx.accounts.instructions,
            &solana_sdk_ids::ed25519_program::ID,
            32,
            64,
        )?;
        if verified.public_key.as_slice() != args.merchant_pubkey.as_ref()
            || verified.message.as_slice() != challenge_hash.as_slice()
        {
            return err!(PolicyError::InvalidMerchantSignature);
        }

        // 9. Record it: a spent nonce, the count and the total are refused
        let froze = velocity::record(
            &mut policy,
            PaymentRecord {
                timestamp: 0,
                amount: args.amount,
                nonce: args.nonce,
                challenge_hash,
                intent_hash,
                merchant_pubkey: args.merchant_pubkey,
                froze_account: 0,
                _padding: [0; 7],
            },
            now,
        )?;
        let state = velocity::summarize(&policy, now);
        let policy_id = policy.policy_id;
        let bump = policy.bump;
        drop(policy);

        // 10. Move exactly the agreed amount to the agreed recipient
        let seeds: &[&[u8]] = &[POLICY_SEED, &policy_id, &[bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_token.to_account_info(),
                    authority: ctx.accounts.policy.to_account_info(),
                },
                &[seeds],
            ),
            args.amount,
            ctx.accounts.mint.decimals,
        )?;

        // 11. The proof of intent
        emit!(ProofOfIntent {
            policy: policy_key,
            nonce: args.nonce,
            challenge_hash,
            intent_hash,
            merchant_pubkey: args.merchant_pubkey,
            recipient,
            amount: args.amount,
        });
        if froze {
            emit!(PaymentsFrozen {
                policy: policy_key,
                reason: FROZEN_VELOCITY,
                tx_count: state.tx_count,
                total_amount: state.total_amount,
            });
        }
        Ok(())
    }

    // ── Owner actions ─────────────────────────────────────────────
    //
    // Each one is authorized by the owner passkey and nothing else. The
    // owner path ignores the frozen flag: a frozen account still has to
    // accept the call that thaws it.

    pub fn freeze_payments(ctx: Context<OwnerAction>, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "freeze_payments", &[], &proof)?;

        policy.frozen = 1;
        let state = velocity::summarize(&policy, now()?);
        emit!(PaymentsFrozen {
            policy: key,
            reason: FROZEN_MANUAL,
            tx_count: state.tx_count,
            total_amount: state.total_amount,
        });
        Ok(())
    }

    /// Let payments through again. The velocity window is left as it is, so
    /// freezing and restoring cannot reset the budget.
    pub fn restore_payments(ctx: Context<OwnerAction>, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "restore_payments", &[], &proof)?;

        policy.frozen = 0;
        let state = velocity::summarize(&policy, now()?);
        emit!(PaymentsRestored {
            policy: key,
            tx_count: state.tx_count,
            total_amount: state.total_amount,
        });
        Ok(())
    }

    pub fn revoke_agent_signer(ctx: Context<OwnerAction>, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "revoke_agent_signer", &[], &proof)?;

        if policy.agent_revoked() {
            return err!(PolicyError::SignerRevoked);
        }
        let old = policy.agent_signer;
        policy.agent_signer = Pubkey::default();
        emit!(SignerRevoked { policy: key, pubkey: old });
        Ok(())
    }

    pub fn set_agent_signer(ctx: Context<OwnerAction>, pubkey: Pubkey, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "set_agent_signer", pubkey.as_ref(), &proof)?;

        if pubkey == Pubkey::default() {
            return err!(PolicyError::InvalidConfig);
        }
        policy.agent_signer = pubkey;
        emit!(SignerSet { policy: key, pubkey });
        Ok(())
    }

    pub fn add_merchant(ctx: Context<OwnerAction>, pubkey: Pubkey, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "add_merchant", pubkey.as_ref(), &proof)?;

        if !policy.is_merchant(&pubkey) {
            let count = policy.merchant_count as usize;
            if count >= MAX_MERCHANTS {
                return err!(PolicyError::MerchantListFull);
            }
            policy.merchants[count] = pubkey;
            policy.merchant_count += 1;
        }
        emit!(MerchantAdded { policy: key, pubkey });
        Ok(())
    }

    pub fn remove_merchant(ctx: Context<OwnerAction>, pubkey: Pubkey, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "remove_merchant", pubkey.as_ref(), &proof)?;

        let count = policy.merchant_count as usize;
        if let Some(index) = policy.merchants[..count].iter().position(|m| *m == pubkey) {
            policy.merchants[index] = policy.merchants[count - 1];
            policy.merchants[count - 1] = Pubkey::default();
            policy.merchant_count -= 1;
        }
        emit!(MerchantRemoved { policy: key, pubkey });
        Ok(())
    }

    /// Replace the limits with tighter ones. Loosening even one is refused.
    pub fn reduce_limits(ctx: Context<OwnerAction>, config: VelocityConfig, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "reduce_limits", &limits_bytes(&config), &proof)?;

        if !velocity::is_valid(&config) {
            return err!(PolicyError::InvalidConfig);
        }
        if !velocity::only_reduces(&policy.velocity(), &config) {
            return err!(PolicyError::LimitIncrease);
        }
        policy.limits = config.into();
        emit!(LimitsReduced {
            policy: key,
            max_payment_amount: config.max_payment_amount,
            max_tx_count: config.max_tx_count,
            max_total_amount: config.max_total_amount,
            window_size: config.window_size,
        });
        Ok(())
    }

    /// Move the whole balance to the recovery address. Only on a frozen
    /// account, so it is always the second deliberate step, and only to the
    /// address fixed at creation.
    pub fn recover_funds(ctx: Context<RecoverFunds>, proof: OwnerProof) -> Result<()> {
        let key = ctx.accounts.policy.key();
        let mut policy = ctx.accounts.policy.load_mut()?;
        owner::authorize(&mut policy, &key, &ctx.accounts.instructions, "recover_funds", &[], &proof)?;

        if !policy.is_frozen() {
            return err!(PolicyError::NotFrozen);
        }
        let amount = ctx.accounts.vault.amount;
        if amount == 0 {
            return err!(PolicyError::NothingToRecover);
        }
        let policy_id = policy.policy_id;
        let bump = policy.bump;
        let recovery = policy.recovery;
        drop(policy);

        let seeds: &[&[u8]] = &[POLICY_SEED, &policy_id, &[bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recovery_token.to_account_info(),
                    authority: ctx.accounts.policy.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(FundsRecovered { policy: key, recovery, amount });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(args: InitializeArgs)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + core::mem::size_of::<Policy>(),
        seeds = [POLICY_SEED, args.policy_id.as_ref()],
        bump,
    )]
    pub policy: AccountLoader<'info, Policy>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = policy,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pay<'info> {
    /// The delegated agent. Compared with the policy's signer in the handler,
    /// so a revoked or wrong key is refused with its own reason.
    pub agent: Signer<'info>,
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.load()?.policy_id.as_ref()],
        bump = policy.load()?.bump,
    )]
    pub policy: AccountLoader<'info, Policy>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = policy,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: only its key is used. It is the payment's recipient, covered by
    /// the merchant signature, and it owns the destination below.
    pub recipient: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerAction<'info> {
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.load()?.policy_id.as_ref()],
        bump = policy.load()?.bump,
    )]
    pub policy: AccountLoader<'info, Policy>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RecoverFunds<'info> {
    #[account(
        mut,
        seeds = [POLICY_SEED, policy.load()?.policy_id.as_ref()],
        bump = policy.load()?.bump,
    )]
    pub policy: AccountLoader<'info, Policy>,
    #[account(address = policy.load()?.asset)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = policy,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: pinned to the recovery address fixed at creation.
    #[account(address = policy.load()?.recovery)]
    pub recovery: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recovery,
        associated_token::token_program = token_program,
    )]
    pub recovery_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    /// CHECK: the instructions sysvar, pinned by address.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}
