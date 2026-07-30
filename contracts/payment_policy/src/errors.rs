use soroban_sdk::contracterror;

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
}
