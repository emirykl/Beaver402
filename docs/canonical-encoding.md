# Canonical encoding

This is the reference specification for how a Beaver402 merchant challenge
and a buyer intent are turned into bytes and hashed. Both the TypeScript
adapter and the Soroban contract implement it, and
[`test-vectors/vectors.json`](../test-vectors/vectors.json) is the shared
fixture that proves they agree.

Regenerate the vectors with `npm run vectors` in `backend/`. The Rust side
reads the same file in `contracts/payment_policy/src/vectors_test.rs`.

## What is being agreed on

A payment is authorized only when the merchant and the buyer describe the
same thing. Eleven fields make up that description.

| Field | Form | Notes |
|---|---|---|
| `version` | decimal string | `"1"` today |
| `merchantPubkey` | Stellar `G` address | who signed the challenge |
| `httpMethod` | uppercase text | normalized before hashing |
| `normalizedEndpoint` | URL | scheme kept, host and path lowercased, query dropped |
| `bodyHash` | hex | sha256 of the request body, empty body included |
| `recipient` | Stellar address, 56 characters | where the payment lands |
| `asset` | Stellar contract address, 56 characters | the token contract |
| `amount` | decimal string | stroops |
| `network` | passphrase | hashed to the network id |
| `nonce` | 32 bytes, hex | single use |
| `expiry` | decimal string | unix seconds, zero is invalid |

## Two layers

The HTTP side of the request never reaches the ledger. It is collapsed into
one digest first, so an endpoint and a request body stay private while still
being covered by both signatures.

The settlement terms do travel in the clear, because the contract has to
compare them against the transfer it is being asked to authorize. A hash
alone would not let it check that the recipient and the amount are the ones
that were agreed.

### Request digest

```
request_preimage = version | merchantPubkey | HTTP_METHOD | endpoint | bodyHash
request_digest   = sha256( len("beaver402:request:v1") ‖ "beaver402:request:v1" ‖ request_preimage )
```

The five parts are joined with the `|` character. `endpoint` is the
normalized form, `HTTP_METHOD` is uppercase.

### Settlement preimage

232 bytes, concatenated with no separators:

| Offset | Length | Contents |
|---|---|---|
| 0 | 32 | `request_digest` |
| 32 | 56 | `recipient`, the strkey as ASCII |
| 88 | 56 | `asset`, the strkey as ASCII |
| 144 | 16 | `amount`, big endian two's complement `i128` |
| 160 | 32 | network id, `sha256(passphrase)` |
| 192 | 32 | `nonce` |
| 224 | 8 | `expiry`, big endian `u64` |

Numbers are big endian rather than decimal text. Formatting integers inside
a `no_std` contract is needless work, and a fixed width leaves no room for
disagreement about padding.

Addresses are their strkey text rather than their raw bytes, because that is
the form both sides already hold and it is unambiguous at a fixed 56
characters.

## Domain separation

```
challenge_hash = sha256( len(CHALLENGE_DOMAIN) ‖ CHALLENGE_DOMAIN ‖ settlement_preimage )
intent_hash    = sha256( len(INTENT_DOMAIN)    ‖ INTENT_DOMAIN    ‖ settlement_preimage )

CHALLENGE_DOMAIN = "beaver402:challenge:v1"
INTENT_DOMAIN    = "beaver402:intent:v1"
REQUEST_DOMAIN   = "beaver402:request:v1"
```

The domain length is written as a single byte before the domain itself, so no
domain can be mistaken for the start of the payload it protects.

The two hashes are deliberately different for the same fields. A merchant
signature can therefore never be replayed as a buyer intent, or the other way
round.

## What the contract checks

The contract is given the fields, not the hashes. It rebuilds both hashes
itself and verifies the merchant signature against the challenge hash it
derived. This is what turns the merchant signature into a statement about a
specific recipient, asset and amount rather than about an opaque digest.

The network id comes from the ledger the contract is running on, so a
challenge signed for another network cannot be replayed.

## Signatures

| Who | Curve | Over |
|---|---|---|
| Merchant | ed25519 | the challenge hash |
| Agent | ed25519 | the Soroban authorization payload |
| Owner | secp256r1 | a WebAuthn assertion, see below |

The agent signs the payload the host hands to the account, not the challenge
hash, so its signature is bound to one specific authorization rather than to
a description of one.

An owner assertion is a standard WebAuthn signature over
`sha256(authenticatorData ‖ sha256(clientDataJSON))`. The contract recomputes
that digest and checks that the challenge echoed inside `clientDataJSON`,
base64url encoded, is the authorization payload. Without that check any past
assertion would authorize any action.

## Reference implementations

| Side | File |
|---|---|
| TypeScript | `backend/src/shared/hashing.ts` |
| Rust | `contracts/payment_policy/src/crypto.rs` |
| WebAuthn verification | `contracts/payment_policy/src/passkey.rs` |
| Shared vectors | `test-vectors/vectors.json` |
