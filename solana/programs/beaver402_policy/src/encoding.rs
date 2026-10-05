//! The Solana family of the canonical encoding. See docs/canonical-encoding.md
//! and backend/src/chains/solana/encoding.ts, which has to agree byte for
//! byte; test-vectors/vectors-solana.json is the shared fixture.

use anchor_lang::prelude::Pubkey;
use solana_sha256_hasher::hashv;

use crate::constants::SETTLEMENT_PREIMAGE_LEN;

/// Hash data under a named domain. The domain length is written first so that
/// no domain can be confused with the start of the payload it protects.
pub fn domain_separated_hash(domain: &str, data: &[u8]) -> [u8; 32] {
    let domain = domain.as_bytes();
    hashv(&[&[domain.len() as u8], domain, data]).to_bytes()
}

/// The fields both the challenge hash and the intent hash cover.
pub struct Settlement<'a> {
    pub request_digest: &'a [u8; 32],
    pub recipient: &'a Pubkey,
    pub asset: &'a Pubkey,
    pub amount: u64,
    pub network_id: &'a [u8; 32],
    pub nonce: &'a [u8; 32],
    pub expiry: u64,
}

/// 176 bytes, concatenated with no separators:
///
/// | offset | length | contents |
/// |---|---|---|
/// | 0 | 32 | request digest |
/// | 32 | 32 | recipient, the owner of the destination token account |
/// | 64 | 32 | asset, the mint |
/// | 96 | 8 | amount, big endian |
/// | 104 | 32 | network id |
/// | 136 | 32 | nonce |
/// | 168 | 8 | expiry, big endian |
///
/// The paying account is not part of it: the merchant signs before it knows
/// who will pay, exactly as on Stellar. A challenge is still spent once per
/// account, by its nonce, and only with that account's agent signature.
pub fn settlement_preimage(s: &Settlement) -> [u8; SETTLEMENT_PREIMAGE_LEN] {
    let mut out = [0u8; SETTLEMENT_PREIMAGE_LEN];
    out[0..32].copy_from_slice(s.request_digest);
    out[32..64].copy_from_slice(s.recipient.as_ref());
    out[64..96].copy_from_slice(s.asset.as_ref());
    out[96..104].copy_from_slice(&s.amount.to_be_bytes());
    out[104..136].copy_from_slice(s.network_id);
    out[136..168].copy_from_slice(s.nonce);
    out[168..176].copy_from_slice(&s.expiry.to_be_bytes());
    out
}
