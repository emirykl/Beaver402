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

## External review

_Waiting for the review._

| # | Severity | Where | Finding | Resolution |
|---|---|---|---|---|
