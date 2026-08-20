# Evidence

Everything below happened on Stellar testnet against the deployed contract.
Every link resolves on a public explorer.

Reproduce the adversarial results with `npm run scenarios` in `backend/`,
with the backend running.

## The recording

[Seven minutes](https://youtu.be/0vFrfGZc1x0), one take, against this contract.
The owner signs in with a passkey, an agent pays for a resource over MCP
without holding a key, the owner halts payments and the agent is refused with
`AccountFrozen`, the agent key is revoked and the refusal becomes
`SignerRevoked`, then the key goes back. It ends on the contract's own history,
where the whole run appears in order.

The frames that carry each claim are in [`screenshots`](screenshots), with a
table saying what each one shows and when it happens.

## The deployment

| | |
|---|---|
| Contract | [`CBPE37HQ6CHIKB7F3OFU2BIDAQOLB3QZD2DAO5Y6F6DKUSHLW2JZTX2S`](https://stellar.expert/explorer/testnet/contract/CBPE37HQ6CHIKB7F3OFU2BIDAQOLB3QZD2DAO5Y6F6DKUSHLW2JZTX2S) |
| Owner | a WebAuthn passkey, secp256r1, held in device hardware |
| Agent signer | ed25519, held by the backend |
| Asset | testnet USDC, [`CBIELTK6...IHMXQDAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| Velocity budget | 10 payments or 10,000 USDC per day |

| Step | Transaction |
|---|---|
| Contract code uploaded | [`ea9728fc`](https://stellar.expert/explorer/testnet/tx/ea9728fcdfe4c6bb7cc90f7a1e589e526bf5c34f441a2a33bc912897d02bc8fc) |
| Account created with the passkey as owner | [`037baccb`](https://stellar.expert/explorer/testnet/tx/037baccb4243281efdea65812307dc042b3d7def186e97b849cced2ea463c3d5) |
| Account funded with 20 USDC | [`ff0d3fa8`](https://stellar.expert/explorer/testnet/tx/ff0d3fa8de4076b6ea584109c530a3f6a1376847d9a52ac3ebf1f119fc8ec956) |

## The owner controls the account with a passkey

Both of these were authorized by a fingerprint. No secret key was involved:
the browser produced a WebAuthn assertion, and the contract verified it with
`secp256r1_verify` after rebuilding the digest from the authenticator fields
and checking that the challenge echoed in `clientDataJSON` was the Soroban
authorization payload.

| Action | Transaction |
|---|---|
| Approving the demo merchant | [`61e6485c`](https://stellar.expert/explorer/testnet/tx/61e6485c8ef7df96b92ada8c79687acc69d8ea1b5d307d952d9b9efcab259b48) |
| Thawing a frozen account | [`b2e858ba`](https://stellar.expert/explorer/testnet/tx/b2e858bad0f121e052bcd8047dfd9e35a814cd5230203d2d5da00900fc1cc8e1) |

The second one matters beyond showing that passkeys work. The owner path
deliberately ignores the frozen flag, because an account that refuses
everything while frozen would refuse the call that unfreezes it, and freezing
would lock the owner out permanently.

## A payment both parties agreed on

[`38fd3aab`](https://stellar.expert/explorer/testnet/tx/38fd3aabcd05604bbc4dce11e91bca15445a1528c40c9d7ebfdd54ecb50fbec7)

The merchant answered `402` with a signed challenge. The adapter rebuilt the
same description from what was actually sent. The transfer moved funds out of
the policy account, so the contract was asked before anything settled. It
rebuilt the challenge hash from the fields it was given, verified the
merchant signature against that hash, and confirmed the transfer had the
recipient, asset and amount that were agreed.

The resource came back: `premium content unlocked via x402 payment with
beaver402 protection`.

## What the policy refuses

Each row was attempted against the deployed contract. The named errors are
the contract's own codes, pulled out of the diagnostics, because the network
wraps a refusal from a custom account in a generic authorization failure that
looks identical whatever the reason.

| Attempt | Outcome | Refused by |
|---|---|---|
| The endpoint changed after the merchant signed | refused | field mismatch, `endpoint` |
| The method changed after the merchant signed | refused | field mismatch, `httpMethod` |
| A body was added after the merchant signed | refused | field mismatch, `bodyHash` |
| A merchant nobody approved | refused | `UnauthorizedMerchant` |
| A challenge that already expired | refused | expiry |
| The same challenge, used a second time | refused | `NonceReused` |
| A payment while the account is frozen | refused | `AccountFrozen` |

The first use of that challenge succeeded, so the refusal of the second is a
real replay refusal rather than a payment that simply failed:
[`5dc89031`](https://stellar.expert/explorer/testnet/tx/5dc8903116da8185c4a400850b3cbd22069145bf72064f3cbe56ae22c344caf3).

The first three are caught by the client before any money moves, which is the
point of the buyer rebuilding the description independently. The rest are the
contract refusing after the client was satisfied.

## The circuit breaker fired on its own

Ten payments in one window reached the configured limit, and the account
froze itself without anyone asking it to.

```
get_velocity_state -> {"total_amount":"10000000","tx_count":10,"window_start":1786357302}
get_velocity_config -> {"max_total_amount":"100000000000","max_tx_count":10,"window_size":86400}
is_frozen          -> true
```

Every payment attempted afterwards was refused with `AccountFrozen` until the
owner thawed the account with the passkey.

## Both languages agree on the encoding

`test-vectors/vectors.json` holds five encoding vectors and five agreement
vectors. The TypeScript adapter generates them and the Rust contract
reproduces them from its own encoder, so neither side can drift without the
other failing.

```
cd backend && npm run test     # 116 tests
cargo test                     # 35 tests
```

The Rust checks live in `contracts/payment_policy/src/vectors_test.rs` and
read the same file.

## Run again after the control panel work, 12 August 2026

Everything above was recorded on 10 August. The whole set was run again
against the same deployed contract once the backend and the control panel had
been reworked, to show that nothing in the payment path had moved.

```
8 scenarios, 0 unexpected
```

| Attempt | Outcome | Named by |
|---|---|---|
| A payment both parties agree on | settled, [`415ce53a`](https://stellar.expert/explorer/testnet/tx/415ce53acfe0c034d885b29e922b291f0952609361ed5223d1e7f1b15ecc704f) | |
| The endpoint changed after the merchant signed | refused | field mismatch, `endpoint` |
| The method changed after the merchant signed | refused | field mismatch, `httpMethod` |
| A body was added after the merchant signed | refused | field mismatch, `bodyHash` |
| A merchant nobody approved | refused | `UnauthorizedMerchant` |
| The same challenge, used once | settled, [`1acc2cc3`](https://stellar.expert/explorer/testnet/tx/1acc2cc3aa6d94c79f3ba6fab82728d5a406f30ca83616e6ed29f99a8ef00fa4) | |
| The same challenge, used twice | refused | the ledger, at submission |
| A challenge that already expired | refused | expiry |

The replay was refused on chain rather than at simulation this time, because
the node had not yet caught up with the payment that came a ledger earlier.
The refusal is the same one, but the reason arrives as a failed transaction
instead of a named code, so the report says where it was caught rather than
claiming to know more than it does.

### The velocity window rolled over on its own

The counters were sitting at three payments from a window that had closed
thirty five hours earlier. The first payment of this run reset them, so the
account finished at two rather than five:

```
before  {"tx_count":3,"total_amount":"3000000","window_start":1786473554}
after   {"tx_count":2,"total_amount":"2000000"}
```

A contract cannot wake up when a window ends, so the rollover happens on the
next payment that asks it to authorize something. That is what deterministic
means here, and it is why the control panel reports the budget the account
will apply rather than the number still written in its storage.

## Not shown here

**Settlement level tampering.** A transfer that disagrees with what was
signed is refused with `SettlementMismatch`, covered by four contract tests
for the recipient, the amount, the asset and the paying account. It does not
appear in the live runs because the real client cannot construct that
disagreement: it builds the transfer from the same fields it signs.

**Owner actions attempted by the agent.** Refused with
`UnauthorizedOwnerAction`, covered by contract tests. Reaching it live would
mean building a deliberately malformed authorization entry.

Both are in `contracts/payment_policy/src/test.rs`, which exercises
`__check_auth` directly with real signatures rather than through mocked
authorization.
