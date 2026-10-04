# Mainnet readiness checklist

The mainnet deployment happens only when every line below says **yes**, with
its evidence linked, and the decision at the bottom is filled in. A line
that says **no** blocks the deployment; it is never waived.

Release candidate: _not tagged yet_
Artifact sha256: _from the release_
Independent local check: [2 October verification](verification-2026-10-02.md).
The current branch still needs a release CI run and external peer review.

## The release

| # | Control | Yes | Evidence |
|---|---|---|---|
| 1 | Contract tests pass | yes, local | 75/75, [verification](verification-2026-10-02.md); release CI pending |
| 2 | Backend tests pass | yes, local | 233/233 after `bc3fcb8`, [verification](verification-2026-10-02.md); release CI pending |
| 3 | Strict Clippy is clean | yes, local | [verification](verification-2026-10-02.md); release CI pending |
| 4 | Rust, backend and frontend dependency audits are clean | yes, local | 0 vulnerabilities; Rust informational `paste` warning, [verification](verification-2026-10-02.md); release CI pending |
| 5 | The contract has no upgrade path | yes | CI check, `lib.rs` |
| 6 | The artifact is built reproducibly and its hash recorded | | 4 Oct: CI and a local container build agree on `b94e7a95…e19ae73f` ([release.md](release.md)); the earlier `963c55c1…` was a native macOS build, which differs by platform. The release build is now pinned to linux/amd64 in `scripts/build-release.sh`. Tag pending |
| 7 | The release is tagged | | GitHub release |

## The x402 path

| # | Control | Yes | Evidence |
|---|---|---|---|
| 8 | A payment emits only the token transfer | yes | contract test, testnet measurement |
| 9 | The payment's fee is under the facilitator's ceiling | yes, 38,411 of 50,000 | `x402-compat.md` |
| 10 | The reference facilitator verifies a real payment | yes | `x402-compat.md` |
| 11 | The hosted facilitator settled a testnet payment started from the MCP tool | yes | [hosted rehearsal](../operations/rehearsals/2026-10-02-testnet-hosted.md), [`ed404577`](https://stellar.expert/explorer/testnet/tx/ed40457717d25214420c04a28bb16a14f53b7bfc5e39f0a3cc334ffe1bbefd6e) |
| 12 | The merchant releases content only after confirming the settlement on the ledger | yes | `merchant-x402.test.ts`, `settlement.test.ts` |
| 13 | A payment is bound to the exact request, including its query and path case | yes | encoding v2, `merchant-x402.test.ts` |

## The account

| # | Control | Yes | Evidence |
|---|---|---|---|
| 14 | Per payment, count and total limits, sliding window, never exceeded | yes | contract tests |
| 15 | Limits can only be lowered | yes | contract tests |
| 16 | Funds can be recovered only while frozen, only to the fixed address | yes | contract tests |
| 17 | The passkey is bound to the panel's domain and needs user verification | yes | contract tests |
| 18 | Replay is refused for as long as a challenge can be valid | yes | contract tests |
| 19 | The account is kept alive by everything except payments | yes | contract tests |
| 20 | Every owner action emits an event | yes | contract tests |

## Configuration and keys

| # | Control | Yes | Evidence |
|---|---|---|---|
| 21 | Testnet and mainnet settings are separated and cross-checked | yes | `network-config.md`, tests |
| 22 | The backend refuses to sign for the wrong network | yes | `adapter-network.test.ts` |
| 23 | Agent and merchant run as separate deployments with only their own secret | | separate testnet roles respond, [verification](verification-2026-10-02.md); secret isolation still needs deployment settings review |
| 24 | The agent route needs a token and only fetches listed merchants | yes | `agent-guard.test.ts` |
| 25 | Production identities created: owner passkey, agent, merchant, fee account | | deployment record |
| 26 | Recovery address chosen, holds a USDC trustline | | deployment record |
| 27 | Recipient account holds a USDC trustline | | deployment record |
| 28 | No secret in the repository, the browser, logs or the model's context | | review |
| 35 | Mainnet Supabase schema and private table access are verified | | nine tables readable with service role, [verification](verification-2026-10-02.md); SQL Editor RLS/privilege results pending |
| 36 | Private payment attempts are not exposed by a public API route | yes, testnet | [I14](../security/findings.md) closed in `bc3fcb8`; unauthenticated deployed testnet request now returns 401 |
| 37 | Public status and error responses cannot reveal provider credentials | no | [I15](../security/findings.md) remains open for existing collector rows and raw hosted logs |
| 38 | Mainnet env file and commands cannot silently select testnet | yes, local | [I16](../security/findings.md) closed in `bc3fcb8`; `dev:mainnet` stopped on missing mainnet RPC |

## Review and rehearsal

| # | Control | Yes | Evidence |
|---|---|---|---|
| 29 | External peer review done, findings recorded | | `docs/security/peer-review.md` |
| 30 | No open critical or high finding | | `docs/security/findings.md` |
| 31 | Full testnet rehearsal on the hosted setup: deploy, approve, fund, pay, every scenario | | scripted locally: yes; on Vercel with the real passkey: not yet |
| 32 | Incident procedure rehearsed on testnet | yes | [hosted rehearsal](../operations/rehearsals/2026-10-02-testnet-hosted.md) |
| 33 | Migration procedure rehearsed on testnet | yes | [hosted rehearsal](../operations/rehearsals/2026-10-02-testnet-hosted.md) |
| 34 | Event collector and status page running against testnet | | `/api/status` responds, but `collector=null` at [verification](verification-2026-10-02.md); collector run/export pending |

## Decision

| | |
|---|---|
| Decision | |
| Date | |
| Artifact sha256 | |
| Decided by | |
