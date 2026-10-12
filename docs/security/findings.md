# Findings

Every finding from review, internal or external, and what was done about it.
The mainnet deployment needs every critical and high finding resolved.

## Found while preparing the release

These came up during the second month's own work, before the external
review. Resolved items changed the code; none remain open.

| # | Severity | Where | Finding | Resolution |
|---|---|---|---|---|
| I1 | high | `velocity.rs` | The total was checked before adding the payment, so the payment that reached the limit could exceed it. | Checked including the payment. Contract test. |
| I2 | high | `velocity.rs` | A fixed window let a burst straddle two windows. | Sliding window. Contract test. |
| I3 | high | `lib.rs` | Resuming after a freeze reset the window. | The window is kept. Contract test. |
| I4 | high | `demo-endpoint.ts` | The merchant released content on the mere presence of a payment header. | The merchant binds, has settled and confirms on the ledger. Tests. |
| I5 | high | `agent-routes.ts` | The agent route paid for anyone who could reach it. | Token and merchant allowlist, required on mainnet. Tests. |
| I6 | medium | `hashing.ts` | The request digest ignored the query and the path's case. | Encoding version 2. Tests and vectors. |
| I7 | medium | `lib.rs` | A challenge could stay valid longer than the record refusing its replay. | At most fifteen minutes; the window is never shorter. Contract test. |
| I8 | medium | `passkey.rs` | The passkey's domain and user verification were not checked. | Both checked on chain. Contract tests. |
| I9 | medium | `lib.rs` | No per payment limit, and any token the merchant named could be paid. | Per payment limit, account fixed to one token. Contract tests. |
| I10 | medium | `lib.rs` | The account emitted events while authorizing, which the facilitator refuses. | Proof published afterwards. Contract test, testnet measurement. |
| I11 | medium | `lib.rs`, `velocity.rs` | A payment grew storage and created an entry, putting its fee far over the facilitator's ceiling. | Fixed slots, no entry, no extension. Contract test, testnet measurement. |
| I12 | low | `collector.ts` | Event collection stopped at the first empty page and would have missed events. | Pages until the cursor reaches the latest ledger. Test. |
| I13 | low | `package.json` | Production dependency advisories through axios. | Overridden to 1.20.0, audit in CI. |
| I14 | medium | `backend/src/app.ts`, `GET /api/transactions` | The original route had no authentication and returned raw payment attempts publicly. | **Closed in `bc3fcb8`.** The route requires an owner session and selects a limited projection. `backend/tests/public-error.test.ts` passed; the deployed testnet agent returned HTTP 401 to an unauthenticated `HEAD` request on 2 October. Mainnet redeployment still needs the usual hosted checks. |
| I15 | medium, release blocker | `backend/src/ops/collector.ts`, `backend/src/ops/ops-routes.ts`, `backend/src/lib/public-error.ts` | The original collector persisted `err.message`, and public status returned the complete state row. Provider errors may contain an RPC URL with a credential. | **Closed.** `bc3fcb8` made new writes a fixed summary and projected three collector fields. The follow-up passes a stored `last_error` to `/api/status` only when it is one of the summaries the collector writes, and shows any other value as `the collection failed`. Every `console.error` now logs `forLog(err)`, which redacts URLs, Stellar secrets, Supabase keys and bearer tokens in the message, stack and cause chain. `backend/tests/status-privacy.test.ts` plants a canary provider URL in an old collector row and in a failing RPC call (with a cause), then checks the real `/api/status` response and the captured server log; the first case fails without the fix. |
| I16 | medium | `backend/package.json`, `dev:mainnet` | The original script loaded `.env.mainnet` without selecting mainnet, so it could use a testnet backend against the mainnet database. | **Closed in `bc3fcb8`.** The script now forces `BEAVER_NETWORK=mainnet`; its test passed and an actual launch with the current incomplete `.env.mainnet` stopped at `SOROBAN_RPC_URL is required on mainnet` before listening. |

## Review of the release candidate, 8 October 2026

Done by Claude (Anthropic's AI model), at the Instawards program lead's
suggestion, against the [review brief](review-brief.md). It is not a human
review and is not presented as one; the method and its limits are in
[peer-review.md](peer-review.md). No critical or high finding.

| # | Severity | Where | Finding | Resolution |
|---|---|---|---|---|
| R1 | low | `backend/src/agent/agent-routes.ts` | The agent's fetch followed redirects, so an approved origin could send the agent, and the payment it retries with, to an origin nobody approved. The request binding and the contract's merchant allowlist would still refuse to settle, but the agent should not talk to that origin at all. | **Fixed.** Redirects are returned, not followed. `agent-guard.test.ts` redirects to a second server and fails without the fix. |
| R2 | informational | `velocity.rs`, `is_valid` | With a window of exactly 900 seconds, the slot holding a challenge's nonce frees at the second its expiry still allows (`now > expiry` refuses only after it), so a replay in that one ledger could find the nonce overwritten. | **Accepted.** The pilot window is 86,400 seconds, 96 times the longest challenge. Requiring `window_size > MAX_CHALLENGE_LIFETIME` changes the WASM hash and is left for the next contract release. |
| R3 | informational | `lib.rs`, `add_merchant` | Approved merchants live in instance storage, which every payment reads and writes, so each one added raises the payment's fee towards the facilitator's 50,000 stroop ceiling. | **Accepted.** The pilot approves one merchant, and the fee was measured with it at 38,411. Recorded in [known limitations](../known-limitations.md). |
| R4 | informational | `x402-merchant.ts`, `observed` | The URL the merchant signs is built from the `Host` header. Behind Vercel the platform sets it; on a host that passes a client's header through, a challenge could name another host. A payment still only unlocks the request it was signed for. | **Accepted** for the Vercel deployment. |
| R5 | informational | `x402-merchant.ts`, `proofPublisher` | The merchant pays the proof's fee, about 20,000 stroops, with a 0.1 XLM cap. A merchant account without XLM settles the payment but publishes no proof. | **Operational.** The merchant account is funded at deployment and its balance is in the deployment checks. |

Checked and found sound: the owner and agent paths cannot be mixed or
swapped in `__check_auth`; the settlement check refuses any batch other than
one transfer of the account's token from itself, to the signed recipient, of
the signed amount; both hashes are rebuilt on chain with the ledger's own
network id; expiry, per payment, count and total limits and replay; recovery
only while frozen and only to the fixed address; limits only downwards,
including the window; the passkey's domain, presence and verification flags,
assertion type and payload binding; the merchant's binding, ledger
confirmation and single use of a settlement; the agent token and origin
allowlist; I14 to I16; and the mainnet Supabase permissions.

## External review

| # | Severity | Where | Finding | Resolution |
|---|---|---|---|---|
