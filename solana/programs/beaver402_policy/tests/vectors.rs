//! Cross language encoding checks for the Solana family.
//!
//! test-vectors/vectors-solana.json is generated from the TypeScript encoder
//! (backend/scripts/generate-solana-vectors.ts). Reproducing every value here
//! from the program's own code is what shows the merchant's off chain
//! signature and the program's on chain check agree byte for byte.

use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use serde_json::Value;

use beaver402_policy::constants::{CHALLENGE_DOMAIN, INTENT_DOMAIN, OWNER_DOMAIN};
use beaver402_policy::encoding::{domain_separated_hash, settlement_preimage, Settlement};
use beaver402_policy::owner::challenge;

const VECTORS: &str = include_str!("../../../../test-vectors/vectors-solana.json");

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn bytes32(text: &str) -> [u8; 32] {
    hex(text).try_into().unwrap()
}

fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

#[test]
fn domains_match() {
    let v = vectors();
    assert_eq!(v["domains"]["challenge"], CHALLENGE_DOMAIN);
    assert_eq!(v["domains"]["intent"], INTENT_DOMAIN);
    assert_eq!(v["domains"]["owner"], OWNER_DOMAIN);
}

#[test]
fn settlement_vectors_reproduce() {
    let v = vectors();
    let list = v["vectors"].as_array().unwrap();
    assert!(!list.is_empty());
    for vector in list {
        let name = vector["name"].as_str().unwrap();
        let fields = &vector["fields"];
        let recipient = Pubkey::from_str(fields["recipient"].as_str().unwrap()).unwrap();
        let asset = Pubkey::from_str(fields["asset"].as_str().unwrap()).unwrap();
        let network_id = sha256(fields["network"].as_str().unwrap().as_bytes());
        let request_digest = bytes32(vector["requestDigest"].as_str().unwrap());
        let nonce = bytes32(fields["nonce"].as_str().unwrap());

        let preimage = settlement_preimage(&Settlement {
            request_digest: &request_digest,
            recipient: &recipient,
            asset: &asset,
            amount: fields["amount"].as_str().unwrap().parse().unwrap(),
            network_id: &network_id,
            nonce: &nonce,
            expiry: fields["expiry"].as_str().unwrap().parse().unwrap(),
        });

        assert_eq!(
            preimage.to_vec(),
            hex(vector["settlementPreimage"].as_str().unwrap()),
            "{name}: preimage"
        );
        assert_eq!(
            domain_separated_hash(CHALLENGE_DOMAIN, &preimage).to_vec(),
            hex(vector["challengeHash"].as_str().unwrap()),
            "{name}: challenge hash"
        );
        assert_eq!(
            domain_separated_hash(INTENT_DOMAIN, &preimage).to_vec(),
            hex(vector["intentHash"].as_str().unwrap()),
            "{name}: intent hash"
        );
    }
}

#[test]
fn owner_vectors_reproduce() {
    let v = vectors();
    for vector in v["ownerVectors"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        // The challenge commits to the program id; the vectors use the
        // deployed one, so this also catches a program id that drifted.
        assert_eq!(vector["programId"].as_str().unwrap(), beaver402_policy::ID.to_string());
        let policy = Pubkey::from_str(vector["policy"].as_str().unwrap()).unwrap();
        let got = challenge(
            &policy,
            vector["action"].as_str().unwrap(),
            &hex(vector["args"].as_str().unwrap()),
            vector["ownerNonce"].as_str().unwrap().parse().unwrap(),
            vector["validUntil"].as_str().unwrap().parse().unwrap(),
        );
        assert_eq!(got.to_vec(), hex(vector["challenge"].as_str().unwrap()), "{name}");
    }
}
