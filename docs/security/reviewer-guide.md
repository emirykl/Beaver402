# Reviewer guide

The practical side of the [review brief](review-brief.md): what to install,
what to run, what to try to break, and how to hand the result back. The
brief says what matters and why; this page says how to go through it.

Plan on four to six hours: about one for setup and the automated checks,
the rest reading and trying things against the contract and the merchant.

## 1. Get the exact candidate

Review a tag, not a branch. The tag is what gets deployed, and the deploy
script refuses any WASM whose hash differs from the reviewed one.

```bash
git clone https://github.com/emirykl/Beaver402.git
cd Beaver402
git checkout v0.2.0-rc.1        # the tag you were sent
```

You need Rust through rustup (`rust-toolchain.toml` picks 1.96.0 and the
`wasm32v1-none` target), Node.js 22 or newer, [Stellar CLI 27.0.0](https://github.com/stellar/stellar-cli/releases/tag/v27.0.0)
and, optionally, `cargo install cargo-audit` and the GitHub CLI `gh` so the
script can fetch the hash CI built.

## 2. Run the automated checks

```bash
./scripts/review-check.sh
```

It runs the contract tests, strict Clippy, `cargo audit`, the WASM build,
the backend tests, both builds and both production `npm audit`s, then
downloads the WASM hash CI built for the same commit and compares it with
yours. Nothing secret is read and no `.env` file is needed. Paste the block
it prints into the "Method and test results" section of
[peer-review.md](peer-review.md).

If `hashes match` says `NO`, stop and tell us before reading further: the
code you would review is not provably the code that would be deployed.

## 3. Read in this order

Follow the numbered list in the [review brief](review-brief.md). The contract
is under 1,500 lines; the backend paths that matter are named there too.
[Canonical encoding](../canonical-encoding.md) defines exactly which bytes
the merchant signs; keep it open while reading `crypto.rs` and
`payment-binding.ts`.

## 4. Try to break it

These are the attacks the design claims to stop. For each, either find a
way through or note why it fails. `contracts/payment_policy/src/test.rs`
has helpers for building an account, a merchant challenge and an agent
signature, so a new attempt is usually a ten-line test. Add it, run
`cargo test`, and keep it if it shows something.

**The contract**

1. Pay with a challenge the merchant never signed, or one signed by a key
   that is not the approved merchant.
2. Take a valid challenge and change one field: amount, recipient, token,
   request hash, expiry. Any change must be refused.
3. Replay a settled challenge, inside and after the sliding window.
4. Make the sixth payment in 24 hours, or push the 24-hour total above
   5 USDC with payments under 1 USDC each. Then try at the window edge,
   one second before and after a slot frees.
5. Pay while frozen, after the agent is revoked, or after the merchant is
   removed.
6. Authorize an owner action (`freeze_payments`, `restore_payments`,
   `revoke_agent_signer`, `set_agent_signer`, `add_merchant`,
   `remove_merchant`, `reduce_limits`, `recover_funds`) with the agent key, or
   bundle one into a payment's authorization.
7. Raise a limit through `reduce_limits`, or recover funds while not
   frozen or to any address other than the one fixed at creation.
8. Feed `passkey.rs` an assertion for another payload, another domain
   (`rpIdHash`), without the user-verified flag, or with a malleable
   (high-S) signature.

**The merchant and the agent**

9. Pay for `GET /resource?a=1` and use the proof on `GET /resource?a=2`,
   on another path, another method or another body.
10. Use one settled payment twice, including two requests at the same
    moment.
11. Get content released before the facilitator settles, or for a
    settlement that is not on the ledger.
12. Make the agent sign a payment to a recipient, token or network other
    than the one it was configured for, or above its own limit.

**The hosted surface**

13. From outside, without an owner session, read anything private: the
    payment log, passkeys, sessions, raw errors, stack traces, the RPC URL.
    `backend/tests/status-privacy.test.ts` shows the canary approach.
14. Run the Supabase permission query in
    [`supabase-verification.sql`](../mainnet/supabase-verification.sql)
    with us, or read its saved output: nothing should be readable or
    writable by `anon` or `authenticated`.

Items you do not get to are fine. Say which ones in the record.

## 5. Write it down

For each finding, add a row to [peer-review.md](peer-review.md) with where
it is, what can happen, how to reproduce it, and a severity:

| Severity | Meaning here |
|---|---|
| critical | funds can leave the account in a way the owner did not allow |
| high | a limit, freeze, revocation or request binding can be bypassed; a secret can reach the public |
| medium | a protection weakens under realistic conditions, or private data can leak |
| low | defence in depth, unclear behaviour, hard to exploit |
| informational | no risk, worth knowing |

We fix each one, link the commit next to it and ask you to recheck it.
Mainnet does not start while a critical or high finding is open.

Then fill the "Reviewer conclusion" table: whether the reviewed source and
artifact are suitable for the bounded pilot (one merchant, at most 1 USDC a
payment, 5 payments and 5 USDC a day, 10 USDC funded), with the date. If
security-relevant code changes after your review, only the diff comes back
to you for a recheck.

## What you are not asked for

This is a peer review, not a formal audit, and the record says so. You are
not asked to review the frontend styling, the landing page copy or the
customer documents, and nothing you write is published under your name
without your agreement.
