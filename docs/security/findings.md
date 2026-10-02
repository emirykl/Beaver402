# Findings

Every finding from review, internal or external, and what was done about it.
The mainnet deployment needs every critical and high finding resolved.

## Found while preparing the release

These came up during the second month's own work, before the external
review, and are recorded here because they changed the code.

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

## External review

_Waiting for the review._

| # | Severity | Where | Finding | Resolution |
|---|---|---|---|---|
