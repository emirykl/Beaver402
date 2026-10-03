# Independent verification — 2 October 2026

Scope: Codex's read-only check of the `contract-hardening` branch for the
second-month mainnet readiness work. The local release checks used baseline
commit `895db7b`; hosted HTTP checks ran after `0a19872`. Claude's
uncommitted work was left untouched. This is an internal review, not the
external peer review required by the SOW.

## Supabase mainnet

The local `backend/.env.mainnet` supplied a project URL and a service key.
Neither value was printed, copied into this file, or added to Git. Read-only
PostgREST `HEAD` queries using the service role succeeded for all nine expected
tables:

| Baseline | Migration 002 | Migration 003 |
|---|---|---|
| `credentials` (0), `sessions` (0), `transactions` (0) | `webauthn_challenges` (0), `rate_limits` (0), `settled_payments` (0), `chain_events` (0), `collector_state` (0) | `page_metrics` (0) |

This verifies table presence and service-role read access. It does not prove
that RLS is enabled, that anonymous/authenticated roles are denied, or that
the functions and extra columns were installed. The SQL files enable RLS and
revoke public access in source, but the remote state needs a SQL Editor check.
Run [the read-only SQL](supabase-verification.sql) in the mainnet project and
attach its output here. Expected: nine tables exist with RLS on, service role
access true, all anonymous/authenticated privileges false; no policy granting
anonymous or authenticated access (old service-role policies may remain);
both functions exist with service role execute only; `facilitator` and
`proof_tx_hash` columns exist. Do not apply the old numbered migration set on
top of the already applied baseline without reconciling its history.

The checked-in versioned baseline creates only `credentials`, `sessions` and
`transactions`. The additional six tables, two transaction columns and two
functions come from `scripts/supabase-migration-002.sql` and `003.sql`. Their
presence on the remote project does not reveal which SQL files were executed:
SQL Editor runs are not tracked in CLI migration history. The legacy
`scripts/supabase-migration.sql` would conflict with the baseline and creates
a public `transactions_anon_select` policy until 002 removes it. See the
[migration reconciliation](migration-reconciliation.md) before any future
schema changes.

## Local release checks

| Check | Result | Limit |
|---|---|---|
| Contract tests | 75/75 passed | local machine |
| Backend tests | 227/227 passed | local machine |
| Strict Clippy | passed with `-D warnings` | local machine |
| Backend TypeScript build | passed | local machine |
| Frontend TypeScript/Vite build | passed; Vite native config warning | local machine |
| `stellar contract build` | 28,488-byte optimized WASM; SHA-256 `963c55c19644bddb55ad0c78ba75572cc7bb4289cde517520f820f060e76d42f` | locally reproduces the hash in [release.md](release.md); release tag and CI comparison still absent |
| Backend production `npm audit` | 0 vulnerabilities | current registry response |
| Frontend production `npm audit` | 0 vulnerabilities | current registry response |
| `cargo audit` | 0 vulnerabilities; one informational unmaintained `paste 1.0.15` warning (`RUSTSEC-2024-0436`) | advisory database updated 2 October 2026 |

After Claude's `bc3fcb8` privacy/network fix, backend tests were rerun:
**233/233 passed** and the TypeScript build passed. The table's 227/227 result
belongs to the earlier baseline. The release CI still needs to validate the
final candidate commit.

A filename-only scan of tracked files for Stellar secret-key shapes, Supabase
`sb_secret_` keys, long JWT-like tokens and private-key PEM headers returned
no matches; `.env` files, private keys, PDFs and TXT files are ignored by Git
except the placeholder `backend/.env.example`. This is a narrow static scan,
so readiness item 28 still needs review of the actual browser and hosted logs.

No GitHub Actions run was listed for `contract-hardening` as of this check;
the local branch has no upstream configured. The latest visible successful CI
runs are on `main` in August and do not validate this release candidate.
`v0.2.0-rc.N` is not tagged. Artifact reproducibility across the release CI
environment, external peer review, and all Kapı 2 evidence remain open.

## Hosted testnet smoke check

Read-only HTTP checks on 2 October 2026:

| URL | Result |
|---|---|
| `https://beaver402.vercel.app/` and `/status` | HTTP 200, frontend HTML served |
| `https://beaver402-api.vercel.app/health` | HTTP 200, `role=agent`, `network=testnet` |
| `https://beaver402-merchant.vercel.app/health` | HTTP 200, `role=merchant`, `network=testnet` |
| `https://beaver402.vercel.app/api/config` | HTTP 200 via frontend rewrite, testnet contract/asset/facilitator configuration |
| `https://beaver402.vercel.app/api/status` | HTTP 200, testnet account readable, 149 days of instance lifetime; `merchantApproved=false`, `collector=null` at this check |
| `https://beaver402.vercel.app/api/metrics/report` | HTTP 200, aggregate daily metric response |
| Agent `/api/merchant-info`; merchant `/api/config` | Both HTTP 404; role-specific routes are absent from the opposite service |
| Merchant `/api/merchant-info` | HTTP 200, public merchant configuration available |

The live testnet RPC `getVersionInfo` response on 2 October reported RPC
`29.0.0-b2b701…` and protocol version **29**. This establishes the testnet
protocol at the time of the check. It does not establish the mainnet protocol;
the mainnet RPC identity and protocol remain a separate preflight gate.

This proves basic routing and role separation at the HTTP surface. It does
not prove that each Vercel project holds only its intended secrets, that a
real device passkey works on the final origin, that the merchant is approved
on this particular account, or that event collection runs. Those remain
Faz 4 acceptance checks. No paid request or owner action was sent by this
verification.

## Security review notes

The reviewed paths were the contract's owner and agent authorization, sliding
window and proof slots, merchant request binding and ledger settlement check,
network configuration, rate limiting, and public operational routes. The
current code requires owner authorization for privileged contract actions,
refuses mixed owner/payment auth contexts, binds an agent payment to the fixed
asset and one transfer, checks the merchant's signature and request digest,
and confirms settlement from the ledger before releasing content. The hosted
testnet [rehearsal](../operations/rehearsals/2026-10-02-testnet-hosted.md)
supports those paths with public transaction references.

Two residual checks for the release review:

1. `recover_funds` accepts a token address from its caller. Owner passkey
   authorization and the fixed destination constrain it; the production panel
   should pass the configured asset, and the external reviewer should confirm
   that accepting other tokens is intentional.
2. The API rate limiter deliberately allows a request through if Supabase is
   unavailable. The agent token, merchant allowlist and on-chain payment limits
   remain in force. The hosted rehearsal should verify that database outages
   are visible in logs/status and do not become a silent production state.

**Closed finding I14:** Before `bc3fcb8`, `GET /api/transactions` in `backend/src/app.ts` had no
session check and selects every column of the 50 newest transaction rows.
The response includes failed attempts and may return an unrecognized raw
error string. The private Supabase table does not protect data after this API
serializes it publicly. [The finding](../security/findings.md) is medium
severity and a release blocker under the SOW privacy promise; close it with
an owner session or a deliberate public projection plus tests before mainnet.
An unauthenticated `HEAD https://beaver402-api.vercel.app/api/transactions`
initially returned HTTP 200 on the deployed testnet agent; no response body
was read. After `bc3fcb8` deployed, the same unauthenticated request returned
**HTTP 401**. The local 233-test run includes an unauthenticated route test.
I14 is closed for the current testnet deployment; mainnet still needs its
normal hosted smoke check.

**Open finding I15:** Before `bc3fcb8`, the collector stored raw exception text in
`collector_state.last_error`, and `/api/status` returns the complete row.
Some provider errors include the request URL; a credential-bearing RPC URL
could therefore be exposed. In `bc3fcb8`, new collector writes and public
errors now use fixed summaries, but `/api/status` does not normalize an old
raw `last_error` value read from the database. `console.error` receives the
raw provider exception, so hosted logs may retain its credential. I15 stays
open until the read/log paths and a canary route test are verified.

**Closed finding I16:** `bc3fcb8` makes `npm run dev:mainnet` set
`BEAVER_NETWORK=mainnet`. The new test passed. An actual launch with the
current local `.env.mainnet` stopped before listening with
`SOROBAN_RPC_URL is required on mainnet`; it did not start on testnet.

No new critical or high finding is asserted by this review. It is limited to
the paths and evidence above; the independent human review and hosted Vercel
test are still required before the mainnet decision.
