use soroban_sdk::{crypto::Hash, Address, Bytes, BytesN, Env};

use crate::errors::PolicyError;

/// The merchant challenge and the buyer intent cover the same fields but are
/// hashed under different domains, so a signature over one can never be
/// replayed as a signature over the other.
pub const CHALLENGE_DOMAIN: &str = "beaver402:challenge:v1";
pub const INTENT_DOMAIN: &str = "beaver402:intent:v1";

/// Stellar strkey addresses are always 56 characters, for both account and
/// contract addresses.
const STRKEY_LEN: u32 = 56;

/// Hash data under a named domain. The domain length is written first so that
/// no domain can be confused with the start of the payload it protects.
pub fn domain_separated_hash(env: &Env, domain: &str, data: &Bytes) -> Hash<32> {
    let mut preimage = Bytes::new(env);

    let domain_bytes = Bytes::from_slice(env, domain.as_bytes());
    let domain_len = domain_bytes.len() as u8;
    preimage.append(&Bytes::from_slice(env, &[domain_len]));
    preimage.append(&domain_bytes);
    preimage.append(data);

    env.crypto().sha256(&preimage)
}

fn append_address(env: &Env, out: &mut Bytes, address: &Address) -> Result<(), PolicyError> {
    let text = address.to_string();
    if text.len() != STRKEY_LEN {
        return Err(PolicyError::InvalidSignatureFormat);
    }

    let mut buf = [0u8; STRKEY_LEN as usize];
    text.copy_into_slice(&mut buf);
    out.append(&Bytes::from_slice(env, &buf));

    Ok(())
}

/// Build the byte string that both the challenge hash and the intent hash are
/// computed over.
///
/// The HTTP side of the request arrives already hashed, so the endpoint and
/// the request body never reach the ledger. The settlement terms travel in
/// the clear because the contract has to compare them against the transfer it
/// is being asked to authorize.
///
/// Numbers are encoded big endian rather than as decimal text, which keeps the
/// encoding cheap to reproduce on chain and unambiguous off chain.
#[allow(clippy::too_many_arguments)]
pub fn settlement_preimage(
    env: &Env,
    request_digest: &BytesN<32>,
    recipient: &Address,
    asset: &Address,
    amount: i128,
    network_id: &BytesN<32>,
    nonce: &BytesN<32>,
    expiry: u64,
) -> Result<Bytes, PolicyError> {
    let mut out = Bytes::new(env);

    out.append(&request_digest.clone().into());
    append_address(env, &mut out, recipient)?;
    append_address(env, &mut out, asset)?;
    out.append(&Bytes::from_slice(env, &amount.to_be_bytes()));
    out.append(&network_id.clone().into());
    out.append(&nonce.clone().into());
    out.append(&Bytes::from_slice(env, &expiry.to_be_bytes()));

    Ok(out)
}

/// Verify an ed25519 signature.
///
/// The host function traps when a signature does not verify, and a trap
/// cannot be caught from inside the contract, so this cannot hand back a
/// typed error the way the policy checks do. A bad signature therefore aborts
/// the invocation instead of returning InvalidBuyerSigner or
/// InvalidMerchantSignature. Every check the contract can decide for itself
/// still reports an explicit error code.
pub fn verify_ed25519(
    env: &Env,
    public_key: &BytesN<32>,
    payload: &BytesN<32>,
    signature: &BytesN<64>,
) {
    env.crypto()
        .ed25519_verify(public_key, &payload.clone().into(), signature);
}
