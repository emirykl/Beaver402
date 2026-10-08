# Release candidate review

The Instawards program lead suggested having the checks done by an AI model.
This review was done by Claude (Anthropic) on 8 October 2026, working from
the [review brief](review-brief.md) as a reviewer would. It is recorded as
what it is: an AI review of code the same model helped write, not a review
by an independent person. A human reviewer can still add to it below.

| Field | Value |
|---|---|
| Reviewer and public attribution | Claude (Anthropic AI model), at the program lead's suggestion |
| Independence from implementation | not independent: the same model contributed to the code |
| Review dates | 8 October 2026 |
| Source commit and release tag | `36fc236`, `v0.2.0-rc.1` |
| Optimized WASM SHA-256 | `b94e7a951332b9192696a2f6778a8e3833398172162b305271598285e19ae73f` (pinned Linux build) |
| CI run reviewed | [37185797472](https://github.com/emirykl/Beaver402/actions/runs/37185797472) |
| Review brief | [scope and questions](review-brief.md), [how to run it](reviewer-guide.md) |

## Scope actually reviewed

List files, functions and deployed configuration inspected. Include
`__check_auth`, velocity/replay, passkey, recovery, x402 merchant/agent paths,
network separation, Supabase permissions and public API privacy. Record any
part of the [review brief](review-brief.md) that was not reviewed.

Everything in the brief: `lib.rs` (`__check_auth`, `check_payment_authorization`,
`check_settlement`, every owner action), `velocity.rs`, `passkey.rs`,
`crypto.rs`, `lifetime.rs`; `payment-binding.ts`, `x402-merchant.ts`,
`settlement.ts`, `x402-client.ts`, `agent-guard.ts`, `agent-routes.ts`,
`app.ts`; the mainnet Supabase permissions; the mainnet RPC and facilitator.
The contract source is identical to `v0.2.0-rc.1`; the backend reviewed is
`contract-hardening` on 8 October.

## Method and test results

Record source inspection, test commands and results, simulation or testnet
transactions, and any assumptions. Link the exact CI run and artifact rather
than pasting a green screenshot without a commit.

Source read against each question in the brief. 75 contract tests and 237
backend tests pass; the frontend builds. The new redirect test was run
without its fix and failed. The mainnet RPC answered `getNetwork` with the
public passphrase and protocol 29; the OpenZeppelin mainnet facilitator
listed x402 v2 `exact` on `stellar:pubnet` with sponsored fees and refused a
wrong key with 401. The mainnet Supabase permission query showed RLS on all
nine tables, no `anon` or `authenticated` access and no policies.

Not done: fuzzing beyond the existing tests, and anything a mainnet
deployment has to show for itself (fees, settlement, the live passkey).

## Findings and resolution

| ID | Severity | Location | Impact / reproduction | Resolution commit or accepted reason | Reviewer recheck |
|---|---|---|---|---|---|
| R1 | low | `agent-routes.ts` | Agent fetch followed redirects off the approved origin | fixed, redirect test | yes |
| R2 | informational | `velocity.rs` | Slot frees at the expiry second when the window is exactly 900 s | accepted, pilot window 86,400 s | — |
| R3 | informational | `lib.rs` | Each approved merchant raises every payment's fee | accepted, one merchant | — |
| R4 | informational | `x402-merchant.ts` | Signed URL comes from the `Host` header | accepted on Vercel | — |
| R5 | informational | `x402-merchant.ts` | Proof needs the merchant to hold XLM | funded at deployment | — |

Transfer each finding to [findings.md](findings.md). The existing internal
findings I14–I16 were closed internally and must be rechecked.
Critical and high findings cannot remain open at the Kapı 2 decision.

## Reviewer conclusion

| Decision | Date | Reviewer confirmation |
|---|---|---|
| suitable for the bounded pilot | 8 October 2026 | Claude, AI review; no critical or high finding open |

State whether the reviewed source and artifact are suitable for the bounded
pilot described in the SOW, subject to the recorded assumptions and findings.
If the artifact or security-critical source changes after this review,
identify the changed diff and obtain a recheck before mainnet.
