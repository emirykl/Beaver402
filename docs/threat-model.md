# Threat model

Beaver402 protects one thing: an agent paying for something the account owner
did not approve. This describes who is trusted with what, what the system
defends against, and what it deliberately does not.

## The parties

| Party | Holds | Can |
|---|---|---|
| Owner | a passkey, in device hardware | freeze, restore, revoke the agent, allowlist merchants |
| Agent | an ed25519 key, in the backend | spend from the account, within the policy |
| Merchant | an ed25519 key | quote a price and sign a challenge |
| Policy account | the funds | nothing on its own, it only answers yes or no |

The agent key and the merchant key live in the same backend in this
reference implementation. That is a demonstration convenience, not a
recommendation. The owner passkey is the one key that is genuinely separate,
and it is the only one that can stop the others.

## What is assumed

The account owner controls their own device and passkey. The Stellar network
behaves as specified. The merchant's signing key is not stolen. Testnet USDC
has no value, so nothing here is defending real money.

## What is defended against

### A compromised or confused agent

The threat the project exists for. An agent whose prompt was manipulated, or
whose tooling misbehaves, tries to pay the wrong party, the wrong amount, or
pays repeatedly.

The contract will not authorize a transfer unless a merchant the owner
allowlisted signed for that exact recipient, asset and amount. The agent
cannot invent a payee. It cannot change the amount after the merchant quoted
it, because the merchant signature covers the amount and the contract
compares the signed amount against the transfer it is being asked to
authorize.

Repetition is bounded by the velocity limits, and crossing them freezes the
account rather than merely refusing one payment.

### A compromised buyer adapter

Soroban cannot read an HTTP request, so it cannot know whether the adapter
described honestly what the merchant asked for. The defence is that it does
not have to. The merchant signs a challenge covering the request digest and
the settlement terms, and the contract rebuilds that challenge from the
fields the agent supplied. If the agent misrepresents any of them, the
merchant signature stops verifying.

### A dishonest merchant

An allowlisted merchant can quote whatever price it likes, and the owner is
trusting it that far by allowlisting it. It cannot exceed the velocity
budget, it cannot be paid twice for one challenge, and the owner can remove
it. A merchant the owner never approved is refused outright with
`UnauthorizedMerchant`.

### Replay

Every challenge carries a 32 byte nonce which the contract records on first
use. A second attempt is refused with `NonceReused`. Nonces live in
temporary storage so they expire on their own rather than growing the
account forever.

An authorization is also bound to a specific ledger range and to the
network id the contract reads from its own ledger, so a challenge signed for
another network cannot be replayed here.

### A stolen or replayed passkey assertion

The WebAuthn challenge is the Soroban authorization payload itself, and the
contract checks that the challenge echoed in `clientDataJSON` matches the
payload it was handed. An assertion captured from one action cannot
authorize another. The contract also requires the user presence flag, so an
assertion cannot be produced by software alone.

### The owner losing control

Two failure modes were closed deliberately, both of which the earlier design
had.

Freezing used to make restoring impossible, because the check that refused
payments on a frozen account also refused the call that unfroze it. The owner
path now ignores the frozen flag.

Revoking the agent used to brick the account, because setting a new signer
went through the path that required the old one. Owner actions no longer
depend on the agent signer existing.

### Privilege confusion

What is being authorized decides which key must approve it, not which
signature the caller offers. An agent signature presented for an owner
action is refused, an owner assertion presented for a payment is refused,
and a batch mixing the two is refused outright so an approved payment cannot
carry an unapproved administrative call alongside it.

## What is not defended against

**A stolen owner device.** Whoever holds the passkey is the owner. There is
no recovery path, no social recovery, no second factor.

**A compromised backend.** The agent key sits there. A backend attacker can
spend up to the velocity budget with a cooperating merchant. They cannot
freeze, revoke, or allowlist anything, and the owner can cut them off. This
is the boundary the design accepts.

**Merchant key theft.** A stolen merchant key lets the thief sign challenges.
The velocity budget and the owner's ability to remove the merchant are the
only limits.

**Price fairness.** Nothing judges whether a quoted price is reasonable. That
is the owner's decision when allowlisting.

**Denial of service.** A misbehaving agent can exhaust the velocity budget
and freeze the account, which stops legitimate payments too. Recovery needs
the owner.

**Anything outside the scope of the engagement.** No mainnet, no custody, no
third party audit, no production key management. Testnet only, with testnet
USDC.

## Where the trust boundaries are

```
device hardware          the owner passkey, never leaves it
        │
        │ WebAuthn assertion
        ▼
backend                  the agent key and the merchant key
        │
        │ authorization entry
        ▼
policy contract          the funds, and the rules
        │
        │ transfer
        ▼
token contract
```

The backend never holds anything that can override the contract. It prepares
what needs signing and passes assertions along, and it pays transaction fees
from an account that has no authority of its own.

## What enforces each claim

| Claim | Enforced by |
|---|---|
| Only an approved merchant can be paid | `UnauthorizedMerchant`, allowlist in instance storage |
| The payment is the one that was quoted | challenge hash rebuilt from the fields, `SettlementMismatch` |
| A challenge is used once | `NonceReused`, temporary storage |
| A challenge goes stale | `ChallengeExpired` |
| Bursts are bounded | `VelocityExceeded`, automatic freeze |
| The owner can stop everything | passkey path, ignores the frozen flag |
| The agent cannot administer the account | `UnauthorizedOwnerAction` |

Each row has tests in `contracts/payment_policy/src/test.rs`, and the ones
reachable through a real client are exercised against the deployed contract
by `npm run scenarios`.
