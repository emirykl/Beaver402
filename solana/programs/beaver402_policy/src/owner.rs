//! The owner path: a WebAuthn assertion from the owner's passkey, verified by
//! the secp256r1 precompile in the same transaction.
//!
//! The checks are the Soroban contract's passkey.rs. What differs is where the
//! signed payload comes from: Soroban hands the account a payload the host
//! derived, while here the program derives it from the instruction itself and
//! a counter, so an assertion authorizes exactly one call.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hash;

use crate::constants::{MAX_OWNER_VALIDITY, OWNER_DOMAIN};
use crate::encoding::domain_separated_hash;
use crate::error::PolicyError;
use crate::introspection::verified_by_precompile;
use crate::state::Policy;

const COMPRESSED_KEY_LEN: usize = 33;
const SIGNATURE_LEN: usize = 64;

/// authenticatorData: 32 byte rpIdHash, 1 flags byte, 4 byte counter.
const FLAGS_OFFSET: usize = 32;
const MIN_AUTHENTICATOR_DATA_LEN: usize = 37;
const USER_PRESENT: u8 = 0x01;
const USER_VERIFIED: u8 = 0x04;

const ASSERTION_TYPE: &[u8] = b"\"type\":\"webauthn.get\"";
const CHALLENGE_KEY: &[u8] = b"\"challenge\":\"";

/// What the owner sends along with an action.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OwnerProof {
    /// Raw clientDataJSON. The authenticator data comes from the precompile
    /// instruction, which is where the signature covers it.
    pub client_data_json: Vec<u8>,
    /// Unix seconds after which the assertion no longer counts.
    pub valid_until: u64,
}

/// The value the passkey signs for an action:
///
/// `domain_hash(OWNER_DOMAIN, program ‖ policy ‖ len(action) ‖ action ‖ args ‖ owner_nonce ‖ valid_until)`
///
/// with the counter and the deadline big endian. backend/src/chains/solana
/// builds the same bytes.
pub fn challenge(
    policy: &Pubkey,
    action: &str,
    args: &[u8],
    owner_nonce: u64,
    valid_until: u64,
) -> [u8; 32] {
    let mut data = Vec::with_capacity(32 + 32 + 1 + action.len() + args.len() + 16);
    data.extend_from_slice(crate::ID.as_ref());
    data.extend_from_slice(policy.as_ref());
    data.push(action.len() as u8);
    data.extend_from_slice(action.as_bytes());
    data.extend_from_slice(args);
    data.extend_from_slice(&owner_nonce.to_be_bytes());
    data.extend_from_slice(&valid_until.to_be_bytes());
    domain_separated_hash(OWNER_DOMAIN, &data)
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url without padding, the way WebAuthn echoes a challenge.
pub fn base64url_encode(input: &[u8; 32]) -> [u8; 43] {
    let mut out = [0u8; 43];
    let mut i = 0usize;
    let mut o = 0usize;
    while i + 3 <= 30 {
        let chunk = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out[o] = ALPHABET[((chunk >> 18) & 63) as usize];
        out[o + 1] = ALPHABET[((chunk >> 12) & 63) as usize];
        out[o + 2] = ALPHABET[((chunk >> 6) & 63) as usize];
        out[o + 3] = ALPHABET[(chunk & 63) as usize];
        i += 3;
        o += 4;
    }
    let tail = ((input[30] as u32) << 16) | ((input[31] as u32) << 8);
    out[40] = ALPHABET[((tail >> 18) & 63) as usize];
    out[41] = ALPHABET[((tail >> 12) & 63) as usize];
    out[42] = ALPHABET[((tail >> 6) & 63) as usize];
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Authorize an owner action, or refuse it. On success the counter moves, so
/// the same assertion never authorizes anything again.
///
/// Everything below has to hold.
///
/// - The transaction is the secp256r1 precompile plus this one instruction.
/// - The precompile verified the owner's key over
///   `authenticatorData ‖ sha256(clientDataJSON)`.
/// - The assertion was made for the account's domain, with a human present
///   and verified.
/// - clientDataJSON describes an assertion and carries this action's
///   challenge.
/// - The deadline has not passed and is not too far ahead.
pub fn authorize(
    policy: &mut Policy,
    policy_key: &Pubkey,
    instructions: &AccountInfo,
    action: &str,
    args: &[u8],
    proof: &OwnerProof,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp.max(0) as u64;
    if now > proof.valid_until {
        return err!(PolicyError::ChallengeExpired);
    }
    if proof.valid_until - now > MAX_OWNER_VALIDITY {
        return err!(PolicyError::ExpiryTooFar);
    }

    let verified = verified_by_precompile(
        instructions,
        &solana_sdk_ids::secp256r1_program::ID,
        COMPRESSED_KEY_LEN,
        SIGNATURE_LEN,
    )?;
    if verified.public_key.as_slice() != policy.owner_key().as_slice() {
        return err!(PolicyError::UnauthorizedOwnerAction);
    }

    let message = verified.message;
    if message.len() < MIN_AUTHENTICATOR_DATA_LEN + 32 {
        return err!(PolicyError::InvalidSignatureFormat);
    }
    let (authenticator_data, client_data_hash) = message.split_at(message.len() - 32);
    if client_data_hash != hash(&proof.client_data_json).as_ref() {
        return err!(PolicyError::InvalidSignatureFormat);
    }

    if authenticator_data[..32] != policy.rp_id_hash {
        return err!(PolicyError::WrongRelyingParty);
    }
    let flags = authenticator_data[FLAGS_OFFSET];
    if flags & USER_PRESENT != USER_PRESENT {
        return err!(PolicyError::InvalidSignatureFormat);
    }
    if flags & USER_VERIFIED != USER_VERIFIED {
        return err!(PolicyError::UserNotVerified);
    }

    let client_data = proof.client_data_json.as_slice();
    if find(client_data, ASSERTION_TYPE).is_none() {
        return err!(PolicyError::InvalidSignatureFormat);
    }
    let expected = base64url_encode(&challenge(
        policy_key,
        action,
        args,
        policy.owner_nonce,
        proof.valid_until,
    ));
    let start = find(client_data, CHALLENGE_KEY)
        .ok_or(error!(PolicyError::ChallengeMismatch))?
        + CHALLENGE_KEY.len();
    // The challenge has to be the whole value: exactly 43 characters, then
    // the closing quote.
    if client_data.get(start..start + 43) != Some(&expected[..])
        || client_data.get(start + 43) != Some(&b'"')
    {
        return err!(PolicyError::ChallengeMismatch);
    }

    policy.owner_nonce = policy
        .owner_nonce
        .checked_add(1)
        .ok_or(error!(PolicyError::InvalidConfig))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::base64url_encode;

    #[test]
    fn encodes_counting_challenge() {
        let mut input = [0u8; 32];
        for (i, byte) in input.iter_mut().enumerate() {
            *byte = i as u8;
        }
        assert_eq!(
            &base64url_encode(&input),
            b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        );
    }
}
