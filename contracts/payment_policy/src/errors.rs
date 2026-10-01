use soroban_sdk::contracterror;

/// The codes are part of the interface. The backend turns them back into
/// names, so a code is never reused for a different meaning.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PolicyError {
    InvalidBuyerSigner = 1,
    UnauthorizedMerchant = 2,
    InvalidMerchantSignature = 3,
    ChallengeMismatch = 4,
    NonceReused = 7,
    ChallengeExpired = 8,
    VelocityExceeded = 10,
    AccountFrozen = 11,
    SignerRevoked = 12,
    UnauthorizedOwnerAction = 13,
    InvalidSignatureFormat = 14,
    NotInitialized = 15,
    AlreadyInitialized = 16,
    InvalidAmount = 17,
    SettlementMismatch = 18,
    /// A single payment above the per payment limit.
    PaymentLimitExceeded = 19,
    /// A payment in a token other than the one the account was created for.
    AssetNotAllowed = 20,
    /// A challenge that stays valid for longer than the contract allows.
    ExpiryTooFar = 21,
    /// An attempt to raise a limit. Limits only go down.
    LimitIncrease = 22,
    /// Funds can only be recovered from a frozen account.
    NotFrozen = 23,
    NothingToRecover = 24,
    ProofNotFound = 25,
    ProofAlreadyPublished = 26,
    InvalidConfig = 27,
    /// A passkey assertion made for a different domain.
    WrongRelyingParty = 28,
    /// A passkey assertion without user verification.
    UserNotVerified = 29,
}
