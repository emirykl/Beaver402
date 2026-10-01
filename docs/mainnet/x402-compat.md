# x402 v2 compatibility

How the Beaver402 proof of intent sits around a standard x402 v2 settlement
on Stellar, and what had to change in the contract for a conformant
facilitator to accept it.

## What the facilitator checks

Read from `@x402/stellar` 2.28.0, `exact/facilitator`, which is the reference
implementation of the `exact` scheme on Stellar.

The payment payload is one transaction holding one `transfer` call on the
asset contract. The payer signs the authorization entry and nothing else. The
facilitator rebuilds the transaction with its own source account, pays the
fee and submits it. Before it does, it requires all of the following.

| Check | Consequence for Beaver402 |
|---|---|
| One operation, `transfer(from, to, amount)` on the required asset | already how a payment is shaped |
| `to` and `amount` equal the payment requirements | the merchant challenge has to carry the same recipient and amount |
| The simulation succeeds with the signed entry | `__check_auth` runs here, so a policy refusal surfaces as a failed simulation |
| Resource fee plus inclusion fee at most 50,000 stroops | the payment path has a budget, and an archived contract blows through it |
| Every contract event in the simulation is a `transfer` from the asset contract, and there is exactly one | `__check_auth` may not emit anything |
| Address credentials, expiry within `maxTimeoutSeconds`, no sub-invocations | expiry is derived from the requirements, not fixed at 60 ledgers |
| The payer has signed and nobody else is pending | the policy account is the only signer |

The client half of the package cannot be used as it is. It supports contract
accounts, but it builds the default signature shape, and the policy account
expects its own `PolicySignature`. Beaver402 therefore brings its own client
for the scheme, which produces the same payload and signs the entry the way
the contract requires.

## What the first month contract does against those checks

Measured on 2026-09-30 against the testnet contract
`CBPE37HQ…ZTX2S`, by building a payment payload the way the adapter does and
handing it to the reference facilitator's `verify`. Nothing was submitted.

The signed entry is accepted by the network: the enforcing simulation
succeeds, which means a custom account with a custom signature type is a
valid x402 payer at the protocol level.

The facilitator then refuses it, twice over.

```
invalid_exact_stellar_payload_fee_exceeds_maximum
simulation-derived fee 66111778 stroops exceeds ceiling 50000 stroops
```

The contract had been archived, and the restore is priced into the payment.
See [the baseline](baseline.md).

With the ceiling lifted to see what comes next:

```
invalid_exact_stellar_payload_event_not_transfer
```

The simulation carries two contract events, `poi/verified` from the policy
account and `transfer` from the asset contract. The first one is ours, and
the facilitator accepts no event that is not the transfer.

## What changed

**The account says nothing while it authorizes a payment.** `__check_auth`
emits no events. What it verified, both hashes, the merchant key and the
amount, is kept with the payment, and `publish_proof(nonce)`, which anyone
may call, announces it once. What it announces comes from what the account
stored while authorizing, never from the caller. The merchant calls it right
after confirming the settlement, so the evidence for a payment is two
transactions tied together by the nonce and the challenge hash.

**A payment never grows the account's storage or creates an entry.** This
is what the fee ceiling forced, and it is worth spelling out because the
first attempt missed it by a factor of seven. On mainnet a new persistent
entry lives at least 120 days and a new temporary one at least a day, and
both are paid for up front by whoever creates them. Rent is also charged on
every byte an entry grows by, for its whole remaining lifetime.

| Version of the payment path | Resource fee |
|---|---|
| Velocity window as a growing list, replay record as a new temporary entry, lifetime extended inside the payment | 378,228 stroops |
| Window as fixed slots, no extension inside the payment | 54,725 stroops |
| Replay protection and the proof kept in the same fixed slots, no new entry at all | **38,411 stroops** |
| A plain token transfer between two accounts, for comparison | 19,284 stroops |

The account keeps one slot per payment its velocity limit allows. A slot
holds the payment's amount and time for the window, its nonce to refuse a
replay, and its hashes for the proof. A slot is reused only once its payment
has left the window, and the window can never be configured shorter than
the longest a challenge may live, so the nonce it forgets always belongs to
a challenge that has already expired.

**Lifetime is extended by everything except payments.** Owner actions,
`publish_proof` and a function anyone may call, `extend_ttl`, keep the
account and its code at 150 days ahead, in steps of a week. Extending the
code inside a payment would be rent on its whole size, far over the ceiling.

## Measured

On 2026-10-02 against a throwaway testnet deployment of the reworked
contract, `CCYRWISLRHOL37FXT4FBOJBWTBIZCU2V3ST3TVNR25VQOFDZC7YE4Z2N`, built
from WASM `963c55c1…6e76d42f`. The owner was a software passkey and the
payments settled in a test token, so nothing here is evidence for the
deliverables, only for the design.

| Step | Transaction |
|---|---|
| Merchant approved by the passkey | [`fa56ece3`](https://stellar.expert/explorer/testnet/tx/fa56ece3479f951f8e9b4dc8edc3618d600840b3f4999617060b3f434240da2b) |
| A payment, settled | [`62d880e5`](https://stellar.expert/explorer/testnet/tx/62d880e54ce80efe3e762d08d024c950e53618804007d5eeb0dc391ac8c405df) |
| Its proof of intent, published | [`f190f2c2`](https://stellar.expert/explorer/testnet/tx/f190f2c2883d2c3439c816a710b20a8131310c75ff184637e0174751986a5268) |

The payment's simulation carries one contract event, the token transfer,
and the reference facilitator's `verify` returns `isValid: true`.

Publishing the proof cost 20,246 stroops in resources. It is paid by the
merchant, outside the facilitator's settlement.

One thing the account cannot extend on its own: its balance entry in the
token contract. It lives as long as mainnet gives a new persistent entry,
120 days, which outlasts the pilot. It goes on the list of known limitations
and into the operating guide.

## The testnet gate

Not passed yet. It is passed when a payment started from the MCP tool is
verified, fee sponsored and settled by the hosted facilitator on testnet,
followed by the proof event. The transactions go here.

Still open until then: whether the hosted facilitator applies the same fee
ceiling and event rule as the reference implementation, and whether it
accepts a contract account as the payer.
