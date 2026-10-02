# Mainnet readiness checklist

The mainnet deployment happens only when every line below says **yes**, with
its evidence linked, and the decision at the bottom is filled in. A line
that says **no** blocks the deployment; it is never waived.

Release candidate: _not tagged yet_
Artifact sha256: _from the release_

## The release

| # | Control | Yes | Evidence |
|---|---|---|---|
| 1 | Contract tests pass | yes | 75 tests, CI |
| 2 | Backend tests pass | yes | CI |
| 3 | Strict Clippy is clean | yes | CI |
| 4 | Rust, backend and frontend dependency audits are clean | yes | CI |
| 5 | The contract has no upgrade path | yes | CI check, `lib.rs` |
| 6 | The artifact is built reproducibly and its hash recorded | | `release.md` |
| 7 | The release is tagged | | GitHub release |

## The x402 path

| # | Control | Yes | Evidence |
|---|---|---|---|
| 8 | A payment emits only the token transfer | yes | contract test, testnet measurement |
| 9 | The payment's fee is under the facilitator's ceiling | yes, 38,411 of 50,000 | `x402-compat.md` |
| 10 | The reference facilitator verifies a real payment | yes | `x402-compat.md` |
| 11 | The hosted facilitator settled a testnet payment started from the MCP tool | | with the reference facilitator: yes, [rehearsal](../operations/rehearsals/2026-10-02-testnet.md); hosted: not yet |
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
| 23 | Agent and merchant run as separate deployments with only their own secret | | deployment |
| 24 | The agent route needs a token and only fetches listed merchants | yes | `agent-guard.test.ts` |
| 25 | Production identities created: owner passkey, agent, merchant, fee account | | deployment record |
| 26 | Recovery address chosen, holds a USDC trustline | | deployment record |
| 27 | Recipient account holds a USDC trustline | | deployment record |
| 28 | No secret in the repository, the browser, logs or the model's context | | review |

## Review and rehearsal

| # | Control | Yes | Evidence |
|---|---|---|---|
| 29 | External peer review done, findings recorded | | `docs/security/peer-review.md` |
| 30 | No open critical or high finding | | `docs/security/findings.md` |
| 31 | Full testnet rehearsal on the hosted setup: deploy, approve, fund, pay, every scenario | | scripted locally: yes; on Vercel with the real passkey: not yet |
| 32 | Incident procedure rehearsed on testnet | yes | [rehearsal](../operations/rehearsals/2026-10-02-testnet.md) |
| 33 | Migration procedure rehearsed on testnet | yes | [rehearsal](../operations/rehearsals/2026-10-02-testnet.md) |
| 34 | Event collector and status page running against testnet | | `rehearsal-testnet.md` |

## Decision

| | |
|---|---|
| Decision | |
| Date | |
| Artifact sha256 | |
| Decided by | |
