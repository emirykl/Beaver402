#![cfg(test)]
//! Cross language encoding checks.
//!
//! The vectors in test-vectors/vectors.json are generated from the TypeScript
//! implementation. Reproducing them here from the contract's own code is what
//! shows the two sides agree byte for byte, which is the whole point of the
//! merchant signing off chain and the contract verifying on chain.
extern crate std;

use std::string::String as StdString;
use std::vec::Vec as StdVec;

use soroban_sdk::{Address, Bytes, BytesN, Env, String};

use crate::crypto::{domain_separated_hash, settlement_preimage, CHALLENGE_DOMAIN, INTENT_DOMAIN};

const VECTORS: &str = include_str!("../../../test-vectors/vectors.json");

/// A minimal reader for the flat vector entries. Pulling in a JSON crate just
/// for a test fixture is not worth it, and the shapes here are fixed.
fn field<'a>(object: &'a str, key: &str) -> &'a str {
    let needle = std::format!("\"{}\"", key);
    let start = object
        .find(&needle)
        .unwrap_or_else(|| panic!("key {} missing from vector", key));
    let after = &object[start + needle.len()..];
    let colon = after.find(':').expect("malformed vector");
    let rest = &after[colon + 1..];
    let open = rest.find('"').expect("expected a string value");
    let tail = &rest[open + 1..];
    let close = tail.find('"').expect("unterminated string value");
    &tail[..close]
}

/// Split the vectors array into one slice per entry. Splitting on the name
/// key consumes it, so the entry's name is the first quoted value in the
/// chunk rather than something `field` can look up.
fn encoding_vectors() -> StdVec<&'static str> {
    let start = VECTORS.find("\"vectors\"").expect("no vectors array");
    let end = VECTORS.find("\"matchVectors\"").unwrap_or(VECTORS.len());
    let section = &VECTORS[start..end];

    section.split("\"name\":").skip(1).collect()
}

fn vector_name(vector: &str) -> &str {
    let open = vector.find('"').expect("vector has no name");
    let tail = &vector[open + 1..];
    let close = tail.find('"').expect("unterminated name");
    &tail[..close]
}

fn decode_hex(text: &str) -> StdVec<u8> {
    assert!(text.len() % 2 == 0, "hex must have an even length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("bad hex"))
        .collect()
}

fn to_hex(bytes: &[u8]) -> StdString {
    let mut out = StdString::new();
    for byte in bytes {
        out.push_str(&std::format!("{:02x}", byte));
    }
    out
}

fn bytes_to_vec(bytes: &Bytes) -> StdVec<u8> {
    let mut out = StdVec::new();
    for byte in bytes.iter() {
        out.push(byte);
    }
    out
}

#[test]
fn reproduces_the_typescript_settlement_preimage() {
    let env = Env::default();
    let mut checked = 0;

    for vector in encoding_vectors() {
        let name = field(vector, "note");
        let expected = field(vector, "settlementPreimage");

        let preimage = build_preimage(&env, vector);
        assert_eq!(
            to_hex(&bytes_to_vec(&preimage)),
            expected,
            "settlement preimage differs for vector: {}",
            name
        );

        checked += 1;
    }

    assert!(checked > 0, "no vectors were read");
}

#[test]
fn reproduces_the_typescript_challenge_and_intent_hashes() {
    let env = Env::default();

    for vector in encoding_vectors() {
        let note = field(vector, "note");
        let preimage = build_preimage(&env, vector);

        let challenge = domain_separated_hash(&env, CHALLENGE_DOMAIN, &preimage);
        let intent = domain_separated_hash(&env, INTENT_DOMAIN, &preimage);

        assert_eq!(
            to_hex(&challenge.to_array()),
            field(vector, "challengeHash"),
            "challenge hash differs for vector: {}",
            note
        );
        assert_eq!(
            to_hex(&intent.to_array()),
            field(vector, "intentHash"),
            "intent hash differs for vector: {}",
            note
        );

        // Separate domains have to give separate hashes.
        assert_ne!(challenge.to_array(), intent.to_array());
    }
}

#[test]
fn normalized_fields_hash_the_same_as_plain_ones() {
    let env = Env::default();
    let vectors = encoding_vectors();

    let basic = vectors
        .iter()
        .find(|v| vector_name(v) == "basic_payment")
        .expect("basic_payment vector missing");
    let normalized = vectors
        .iter()
        .find(|v| vector_name(v) == "case_normalization")
        .expect("case_normalization vector missing");

    let basic_hash = domain_separated_hash(&env, CHALLENGE_DOMAIN, &build_preimage(&env, basic));
    let normalized_hash =
        domain_separated_hash(&env, CHALLENGE_DOMAIN, &build_preimage(&env, normalized));

    assert_eq!(basic_hash.to_array(), normalized_hash.to_array());
}

/// Rebuild the preimage using the contract's own encoder. The request digest
/// comes from the vector because it is computed off chain by design: the
/// endpoint and the body never reach the ledger.
fn build_preimage(env: &Env, vector: &str) -> Bytes {
    let request_digest = decode_hex(field(vector, "requestDigest"));
    let digest: [u8; 32] = request_digest.try_into().expect("digest must be 32 bytes");

    let recipient = Address::from_string(&String::from_str(env, field(vector, "recipient")));
    let asset = Address::from_string(&String::from_str(env, field(vector, "asset")));

    let amount: i128 = field(vector, "amount").parse().expect("amount must be i128");
    let expiry: u64 = field(vector, "expiry").parse().expect("expiry must be u64");

    let network = decode_hex(&sha256_hex(field(vector, "network")));
    let network_id: [u8; 32] = network.try_into().expect("network id must be 32 bytes");

    let nonce = decode_hex(field(vector, "nonce"));
    let nonce: [u8; 32] = nonce.try_into().expect("nonce must be 32 bytes");

    settlement_preimage(
        env,
        &BytesN::from_array(env, &digest),
        &recipient,
        &asset,
        amount,
        &BytesN::from_array(env, &network_id),
        &BytesN::from_array(env, &nonce),
        expiry,
    )
    .expect("preimage")
}

/// Stellar derives a network id by hashing the passphrase, which is what the
/// ledger reports to the contract at runtime.
fn sha256_hex(text: &str) -> StdString {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    to_hex(&hasher.finalize())
}
