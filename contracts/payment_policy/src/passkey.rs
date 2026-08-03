use soroban_sdk::{crypto::Hash, Bytes, BytesN, Env};

use crate::errors::PolicyError;
use crate::types::PasskeySignature;

/// Key that precedes the base64url encoded challenge inside clientDataJSON.
const CHALLENGE_KEY: &[u8; 13] = b"\"challenge\":\"";

/// A 32 byte challenge encodes to 43 base64url characters with no padding.
const ENCODED_CHALLENGE_LEN: u32 = 43;

/// authenticatorData layout: 32 byte rpIdHash, 1 flags byte, 4 byte counter.
const FLAGS_OFFSET: u32 = 32;
const MIN_AUTHENTICATOR_DATA_LEN: u32 = 37;

/// User presence bit of the authenticatorData flags byte. The authenticator
/// sets it only when a human interacted with the device, so requiring it is
/// what stops a stolen assertion from being replayed by software alone.
const USER_PRESENT: u8 = 0x01;

const ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Encode a 32 byte value the way WebAuthn encodes the challenge it echoes
/// back in clientDataJSON: base64url, no padding.
pub fn base64url_encode(input: &[u8; 32]) -> [u8; 43] {
    let mut out = [0u8; 43];

    // Ten full groups of three input bytes produce forty characters.
    let mut i = 0usize;
    let mut o = 0usize;
    while i + 3 <= 30 {
        let chunk =
            ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out[o] = ALPHABET[((chunk >> 18) & 63) as usize];
        out[o + 1] = ALPHABET[((chunk >> 12) & 63) as usize];
        out[o + 2] = ALPHABET[((chunk >> 6) & 63) as usize];
        out[o + 3] = ALPHABET[(chunk & 63) as usize];
        i += 3;
        o += 4;
    }

    // The two trailing bytes produce three more characters.
    let tail = ((input[30] as u32) << 16) | ((input[31] as u32) << 8);
    out[40] = ALPHABET[((tail >> 18) & 63) as usize];
    out[41] = ALPHABET[((tail >> 12) & 63) as usize];
    out[42] = ALPHABET[((tail >> 6) & 63) as usize];

    out
}

/// Look for the challenge field inside clientDataJSON and confirm it carries
/// exactly the value we expect. Scanning is bounded by the size of the JSON,
/// which authenticators keep small.
fn challenge_matches(env: &Env, client_data: &Bytes, expected: &[u8; 43]) -> bool {
    let key = Bytes::from_slice(env, CHALLENGE_KEY);
    let expected_bytes = Bytes::from_slice(env, expected);

    let key_len = CHALLENGE_KEY.len() as u32;
    let total = key_len + ENCODED_CHALLENGE_LEN;
    let len = client_data.len();

    if len < total {
        return false;
    }

    let mut start = 0u32;
    while start + total <= len {
        if client_data.slice(start..start + key_len) == key {
            // Only one challenge field exists, so a mismatch here is final.
            return client_data.slice(start + key_len..start + total) == expected_bytes;
        }
        start += 1;
    }

    false
}

/// Verify a WebAuthn assertion produced by the owner's passkey.
///
/// Three things have to hold. The authenticator must report user presence,
/// the challenge echoed in clientDataJSON must be the Soroban signature
/// payload, and the secp256r1 signature must cover
/// sha256(authenticatorData || sha256(clientDataJSON)).
///
/// The challenge check is what binds the assertion to this specific
/// authorization. Without it any past assertion would authorize any action.
pub fn verify_passkey(
    env: &Env,
    owner_pubkey: &BytesN<65>,
    signature_payload: &Hash<32>,
    sig: &PasskeySignature,
) -> Result<(), PolicyError> {
    if sig.authenticator_data.len() < MIN_AUTHENTICATOR_DATA_LEN {
        return Err(PolicyError::InvalidSignatureFormat);
    }

    let flags = sig
        .authenticator_data
        .get(FLAGS_OFFSET)
        .ok_or(PolicyError::InvalidSignatureFormat)?;
    if flags & USER_PRESENT != USER_PRESENT {
        return Err(PolicyError::InvalidSignatureFormat);
    }

    let expected = base64url_encode(&signature_payload.to_array());
    if !challenge_matches(env, &sig.client_data_json, &expected) {
        return Err(PolicyError::ChallengeMismatch);
    }

    let client_data_hash = env.crypto().sha256(&sig.client_data_json);

    let mut preimage = sig.authenticator_data.clone();
    preimage.append(&client_data_hash.to_bytes().into());
    let digest = env.crypto().sha256(&preimage);

    // Traps when the signature does not verify. See the note in crypto.rs on
    // why this cannot be turned into a typed error.
    env.crypto()
        .secp256r1_verify(owner_pubkey, &digest, &sig.signature);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::base64url_encode;

    #[test]
    fn encodes_all_zero_challenge() {
        let encoded = base64url_encode(&[0u8; 32]);
        assert_eq!(&encoded, b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }

    #[test]
    fn encodes_counting_challenge() {
        let mut input = [0u8; 32];
        for (i, byte) in input.iter_mut().enumerate() {
            *byte = i as u8;
        }
        // Matches Buffer.from(input).toString("base64url") in Node.
        let encoded = base64url_encode(&input);
        assert_eq!(&encoded, b"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    }

    #[test]
    fn uses_the_url_safe_alphabet() {
        // 0xfb 0xff selects index 62 and 63, the two characters that differ
        // between standard base64 and base64url.
        let mut input = [0u8; 32];
        input[0] = 0xfb;
        input[1] = 0xf0;
        let encoded = base64url_encode(&input);
        assert_eq!(encoded[0], b'-');
        assert_eq!(encoded[1], b'_');
    }
}
