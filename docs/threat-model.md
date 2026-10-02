# Threat model

Beaver402 protects one thing: an agent paying for something the account owner
did not approve. This describes who is trusted with what, what the system
defends against, and what it deliberately does not.

It covers the limited mainnet pilot: one account, one merchant, real USDC in
small amounts, settled through a hosted x402 facilitator.

## The parties

| Party | Holds | Can |
|---|---|---|
| Owner | a passkey, in device hardware, bound to the panel's domain | halt, resume, revoke and set the agent key, approve and remove merchants, lower limits, recover funds |
| Agent | an ed25519 key, in the agent backend | authorize payments from the account, within the policy |
| Merchant | an ed25519 key, in a separate merchant deployment | quote a price and sign a challenge over one request |
| Facilitator | its own Stellar accounts | verify a payment, pay its network fee, submit it |
| Policy account | the funds | nothing on its own, it only answers yes or no |
| Fee account | a little XLM | pay for deployment and owner actions, approve nothing |
| Recovery address | nothing the system holds a key for | receive the balance when the owner recovers it |

The agent key and the merchant key live in separate deployments, each with
only its own secret. The owner passkey is the only key that can stop the
others, and it never leaves the device.

## What is assumed

The owner controls their own device and passkey. The Stellar network behaves
as specified. The hosted facilitator does what the x402 exact scheme says:
it can refuse or delay a payment, but it cannot change what the account
authorized, because the account signed the exact transfer. The merchant's
signing key is not stolen.

## What is defended against

### A compromised or confused agent

The threat the project exists for. An agent whose prompt was manipulated, or
whose tooling misbehaves, tries to pay the wrong party, the wrong amount, or
pays repeatedly.

The contract will not authorize a transfer unless a merchant the owner
approved signed for that exact recipient, token and amount. The agent cannot
invent a payee. It cannot change the amount after the merchant quoted it,
because the merchant signature covers the amount and the contract compares
the signed amount with the transfer it is being asked to authorize.

Repetition is bounded by the limits: at most a set amount per payment, and a
set number of payments and total in any window. The window slides, so no
boundary between two windows allows a burst, and the total is checked
including the payment being made, so it is never exceeded. Reaching a limit
freezes the account until the owner resumes it, and resuming does not reset
what the window has already used.

### A request changed on the way

The merchant signs a digest of the request: the method, the endpoint with its
query and the case of its path, and the hash of the body. The agent rebuilds
the same digest from what it actually sent and refuses to sign when the two
differ. The merchant, when the payment comes back, rebuilds it once more from
the request in front of it and checks its own signature over the result, so a
payment authorized for one request cannot be presented for another.

### A compromised buyer adapter

Soroban cannot read an HTTP request, so it cannot know whether the adapter
described honestly what the merchant asked for. The defence is that it does
not have to. The contract rebuilds the challenge from the fields the agent
supplied. If the agent misrepresents any of them, the merchant signature stops
verifying.

### A dishonest merchant

An approved merchant can quote whatever price it likes, and the owner is
trusting it that far by approving it. It cannot charge more than the per
payment limit, it cannot exceed the window, it cannot be paid twice for one
challenge, it cannot ask for a token other than the account's own, and the
owner can remove it. A merchant the owner never approved is refused with
`UnauthorizedMerchant`.

### A dishonest or broken facilitator

The facilitator submits a transaction the account already authorized. It
cannot change the recipient, the amount, the token or the scope of the
authorization without the account's signature failing. It could refuse,
delay or claim a settlement that did not happen. The merchant does not
release anything on the facilitator's word: it checks the ledger itself for a
successful transaction with exactly one transfer of the agreed token from
the account to its recipient, and records every settlement so one cannot
unlock two resources.

### Replay

Every challenge carries a 32 byte nonce. The account remembers the nonce of
every payment still inside the velocity window and refuses a second use with
`NonceReused`. A challenge may live for at most fifteen minutes and the
window can never be configured shorter than that, so a challenge has always
expired by the time the account forgets its nonce.

An authorization is also bound to a ledger range and to the network id the
contract reads from its own ledger, so a challenge signed for another network
is refused.

### A stolen, replayed or phished passkey assertion

The WebAuthn challenge is the Soroban authorization payload itself, and the
contract checks that the challenge echoed in `clientDataJSON` matches the
payload it was handed, so an assertion captured from one action cannot
authorize another. The contract also checks the relying party hash the
authenticator signed, so an assertion obtained on a look-alike site is
refused with `WrongRelyingParty`, and it requires user verification, so a
touch alone is not enough.

### The owner losing control

Freezing does not lock the owner out: the owner path ignores the frozen flag,
so the call that resumes payments is always accepted. Revoking the agent does
not brick the account: owner actions never depend on the agent key.

### Funds stuck in a broken account

The owner can send the whole balance of any token to the recovery address
with `recover_funds`. It only works while the account is frozen, so it is
always a second deliberate step, and the address was fixed when the account
was created, so nothing can redirect it. The agent cannot reach it.

### Loosening the policy

Limits can only be lowered. The contract has no upgrade entry point, which CI
checks on every change, so nobody, including whoever deployed it, can replace
the rules. A different policy is a different account, created through the
migration procedure.

### Privilege confusion

What is being authorized decides which key must approve it, not which
signature the caller offers. An agent signature presented for an owner
action is refused, an owner assertion presented for a payment is refused,
and a batch mixing the two is refused outright.

### The account being archived

Persistent ledger entries expire if nobody extends them, and an archived
account would make every payment pay to restore it first, which no
facilitator accepts. Owner actions, publishing a proof and a function anyone
may call keep the account and its code 150 days ahead. The status page shows
how long is left.

## What is not defended against

**A stolen owner device.** Whoever holds the passkey is the owner. There is
no device recovery, no social recovery and no second factor in this pilot.

**A compromised agent backend.** The agent key sits there. An attacker can
spend up to the limits with the approved merchant. They cannot halt, revoke,
approve, lower limits or recover anything, and the owner can cut them off.
The agent route itself needs a token and only fetches from listed merchants.

**Merchant key theft.** A stolen merchant key lets the thief sign challenges
for any request at the merchant's price. The limits and the owner's ability
to remove the merchant are the bounds.

**Price fairness.** Nothing judges whether a quoted price is reasonable. That
is the owner's decision when approving a merchant, bounded by the per
payment limit.

**Denial of service.** A misbehaving agent can use up the window and freeze
the account, which stops legitimate payments too. Recovery needs the owner.
The facilitator can refuse to settle, which also stops payments.

**More than ten USDC.** The contract cannot stop anyone sending it tokens, so
the ten USDC ceiling on the balance is kept by funding it with less, not by
the contract.

**The token balance entry expiring.** The account's balance lives in the USDC
contract's storage, which the account cannot extend. It is created with at
least 120 days on mainnet, longer than the pilot.

**Anything outside the scope of the pilot.** No custody of anyone else's
funds, no formal audit, no hardware security modules, no production service
levels, one merchant.

## Where the trust boundaries are

```
device hardware          the owner passkey, never leaves it
        │
        │ WebAuthn assertion, bound to the panel's domain
        ▼
agent backend            the agent key and the fee account
        │
        │ signed authorization entry, inside an x402 payment
        ▼
merchant                 the merchant key; checks the binding, then
        │                asks the facilitator and confirms on the ledger
        │ x402 verify and settle
        ▼
facilitator              pays the fee, submits the transaction
        │
        ▼
policy contract          the funds, and the rules
        │
        │ transfer
        ▼
token contract
```

## What enforces each claim

| Claim | Enforced by |
|---|---|
| Only an approved merchant can be paid | `UnauthorizedMerchant`, allowlist in instance storage |
| The payment is the one that was quoted | challenge rebuilt from the fields, `SettlementMismatch` |
| The account pays in its own token only | `AssetNotAllowed` |
| No single payment is too large | `PaymentLimitExceeded` |
| A challenge is used once | `NonceReused`, nonces kept in the payment slots |
| A challenge goes stale | `ChallengeExpired`, `ExpiryTooFar` |
| Bursts are bounded | `VelocityExceeded`, sliding window, automatic freeze |
| Limits only go down | `LimitIncrease` |
| The owner can stop everything | passkey path, ignores the frozen flag |
| The passkey answers only for its own site | `WrongRelyingParty`, `UserNotVerified` |
| Funds can always be recovered, only to one place | `recover_funds`, `NotFrozen` |
| The agent cannot administer the account | `UnauthorizedOwnerAction` |
| The request is the one the merchant signed | request digest, checked by the agent and again by the merchant |
| The settlement really happened | the merchant's own ledger check |

Each contract row has tests in `contracts/payment_policy/src/test.rs`. The
request and settlement rows have tests in `backend/tests`, and the ones that
can be reached through a real client run against the deployed contract with
`npm run scenarios`.
