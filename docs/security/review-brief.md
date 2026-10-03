# Review brief

For the external peer reviewer. Thank you for doing this.

## What Beaver402 is

A Stellar smart account for an AI agent that pays for APIs over x402. The
merchant signs a challenge over the exact request, the agent rebuilds the
request on its own, and the account only authorizes the USDC transfer when
the two agree and the owner's limits allow it. The owner holds a passkey that
can halt everything, revoke the agent, change the merchant, lower limits and
recover the funds. Payments settle through a standard x402 facilitator.

It is about to hold real money on mainnet, deliberately little: at most
1 USDC per payment, 5 payments and 5 USDC in any 24 hours, 10 USDC funded.

## What to review

In order of importance.

1. **`contracts/payment_policy/src/lib.rs`**, `__check_auth` and
   `check_payment_authorization`. Can a payment be authorized that the
   merchant did not sign, that differs from what was signed, that goes to
   another recipient or token, or that breaks a limit? Can an owner action be
   authorized without the passkey, or hidden in a payment?
2. **`velocity.rs`**. The window is a fixed set of slots that also refuses
   replays. A slot is reused once its payment leaves the window; the window
   can never be shorter than a challenge's maximum life. Is there a way to
   replay a challenge, to exceed a limit, or to reset the window?
3. **`recover_funds` and `reduce_limits`**. Recovery only while frozen, only
   to the address fixed at creation. Limits only down. Can either be
   bypassed or redirected?
4. **`passkey.rs`**. The assertion has to be for this payload, this domain,
   with user verification. Anything accepted that should not be?
5. **`backend/src/merchant/payment-binding.ts` and `x402-merchant.ts`**. The
   merchant releases content only for a payment bound to the very request it
   is answering, settled by the facilitator and confirmed on the ledger. Can
   a payment for one request unlock another, or one payment unlock twice?
6. **`backend/src/adapter/x402-client.ts`**. What the agent agrees to sign.
7. **`backend/src/config`, `agent-guard.ts`**. Can the backend be pointed at
   the wrong network, or the agent made to pay by someone else?
8. **`backend/src/app.ts`, `ops/collector.ts`, `ops/ops-routes.ts` and
   Supabase SQL.** Inspect the public API surface and every path that can
   return a raw database row or exception. [I14 and I16](findings.md) were
   closed internally; I15 remains open. Confirm the fixes prevent unauthenticated access to
   private attempts, secret-bearing diagnostics and a mainnet database
   accidentally paired with testnet.

## What changed since the first month

The contract was reworked for mainnet: the facilitator's rules forced the
account to emit nothing while authorizing and never to grow its storage
inside a payment, the window became sliding, and limits, recovery, the
passkey domain and the lifetime were added. See
[x402 compatibility](../mainnet/x402-compat.md) for why, with measurements.

## Context

- [Threat model](../threat-model.md): what is and is not defended against.
- [Known limitations](../known-limitations.md).
- [Canonical encoding](../canonical-encoding.md): exactly what is signed.
- `npm test` in `backend/` and `cargo test` at the root run everything.
- [2 October independent verification](../mainnet/verification-2026-10-02.md)
  records the current local tests, artifact hash, dependency audit and open
  Supabase permission check. The branch's release CI run and review artifact
  should be attached when ready.

## What to send back

For each finding: where, what can happen, how likely, and a severity of
critical, high, medium, low or informational. Findings go into
[`findings.md`](findings.md) with their resolution. The mainnet deployment
does not happen while a critical or high finding is open.

Anything you think is out of scope but worrying is welcome too.
