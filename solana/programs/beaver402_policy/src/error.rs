use anchor_lang::prelude::*;

/// The names match the Soroban contract's PolicyError, so the backend turns a
/// refusal into the same sentence on either chain. Anchor reports the name
/// in the transaction logs, which is what the backend reads.
#[error_code]
pub enum PolicyError {
    #[msg("the transaction is not signed by the agent signer")]
    InvalidBuyerSigner,
    #[msg("the merchant is not approved by the owner")]
    UnauthorizedMerchant,
    #[msg("the merchant signature does not cover this payment")]
    InvalidMerchantSignature,
    #[msg("the passkey assertion is for another action")]
    ChallengeMismatch,
    #[msg("this challenge has already been paid")]
    NonceReused,
    #[msg("the challenge has expired")]
    ChallengeExpired,
    #[msg("the payment would exceed the velocity limit")]
    VelocityExceeded,
    #[msg("payments are frozen")]
    AccountFrozen,
    #[msg("the agent signer has been revoked")]
    SignerRevoked,
    #[msg("the action is not authorized by the owner passkey")]
    UnauthorizedOwnerAction,
    #[msg("the signature data is malformed")]
    InvalidSignatureFormat,
    #[msg("the amount is not a valid payment")]
    InvalidAmount,
    #[msg("the transfer is not the one that was agreed")]
    SettlementMismatch,
    #[msg("the payment is above the per payment limit")]
    PaymentLimitExceeded,
    #[msg("the account does not pay in this token")]
    AssetNotAllowed,
    #[msg("the challenge stays valid for longer than the account allows")]
    ExpiryTooFar,
    #[msg("limits can only be lowered")]
    LimitIncrease,
    #[msg("funds can only be recovered from a frozen account")]
    NotFrozen,
    #[msg("there is nothing to recover")]
    NothingToRecover,
    #[msg("the configuration is invalid")]
    InvalidConfig,
    #[msg("the passkey assertion was made for another domain")]
    WrongRelyingParty,
    #[msg("the passkey assertion lacks user verification")]
    UserNotVerified,
    #[msg("the transaction carries an instruction the account does not accept")]
    UnexpectedInstruction,
    #[msg("the merchant list is full")]
    MerchantListFull,
}
