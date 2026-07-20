use soroban_sdk::{crypto::Hash, Bytes, BytesN, Env};

pub const CHALLENGE_DOMAIN: &str = "beaver402:challenge:v1";
pub const INTENT_DOMAIN: &str = "beaver402:intent:v1";

pub fn domain_separated_hash(env: &Env, domain: &str, data: &Bytes) -> Hash<32> {
    let mut preimage = Bytes::new(env);

    let domain_bytes = Bytes::from_slice(env, domain.as_bytes());
    let domain_len = domain_bytes.len() as u8;
    preimage.append(&Bytes::from_slice(env, &[domain_len]));
    preimage.append(&domain_bytes);
    preimage.append(data);

    env.crypto().sha256(&preimage)
}

pub fn verify_ed25519(
    env: &Env,
    public_key: &BytesN<32>,
    payload: &BytesN<32>,
    signature: &BytesN<64>,
) {
    env.crypto()
        .ed25519_verify(public_key, &payload.clone().into(), signature);
}
