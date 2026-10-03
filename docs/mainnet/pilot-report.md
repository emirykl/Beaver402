# Beaver402 — second-month pilot report

**Status:** draft, not submitted · **Updated:** 4 October 2026 · **Scope:**
Instawards D1–D3 and the Customer Development Plan. This report counts an
outcome only when a dated source, network and result are linked. The
[execution plan](month-2-execution-plan.md) contains the full acceptance gates;
the [public evidence index](../evidence.md) separates first-month and
second-month claims.

## Executive record

| Delivery | Verified so far | Required before submission |
|---|---|---|
| D1 — secure, mainnet-compatible x402 release | Hosted OpenZeppelin facilitator settled an MCP-initiated testnet payment and a linked PoI was published; local contract/backend tests, strict Clippy, builds and dependency audits passed; reproducible local WASM hash recorded. | Final release CI and tag; artifact comparison; independent Rust/Stellar peer review; I15 closure; signed readiness decision. |
| D2 — bounded Stellar mainnet pilot | Deploy/preflight procedure and testnet rehearsal exist. | Dated go decision, identities and trustlines, actual mainnet deploy/funding, hosted USDC settlement and PoI, owner controls, recovery and 1/5/5/10 limit audit. |
| D3 — landing, operations and user learning | Three testnet Vercel roles returned HTTP 200 in the 2 October smoke; landing/status/collector code and scripted incident/migration rehearsal exist. | Final hosted passkey and collector run/export; public landing QA; two target-user evaluations, consented video, H1–H5 decisions, applied change, traffic summary and final demo. |

No mainnet payment, contract deployment or customer interview is claimed in
this draft. The [readiness checklist](readiness-checklist.md) still blocks the
mainnet decision.

## D1 — release and security evidence

- Hosted testnet [rehearsal](../operations/rehearsals/2026-10-02-testnet-hosted.md): MCP [USDC settlement](https://stellar.expert/explorer/testnet/tx/ed40457717d25214420c04a28bb16a14f53b7bfc5e39f0a3cc334ffe1bbefd6e) and linked [PoI](https://stellar.expert/explorer/testnet/tx/37c6b23123a6c11064b2a30cc73f511f919a245d5c4ff053cc11a87fe6d94782).
- [Compatibility report](x402-compat.md): 38,411 stroop measured fee under the facilitator's 50,000-stroop ceiling, with only the token transfer during payment authorization.
- [Independent local verification](verification-2026-10-02.md): 75 contract tests; 233 backend tests after `bc3fcb8`; strict Clippy; backend build; optimized 28,488-byte WASM SHA-256 `963c55c19644bddb55ad0c78ba75572cc7bb4289cde517520f820f060e76d42f`; zero production dependency vulnerabilities in the local audits. Final CI/RC comparison is pending.
- [Findings](../security/findings.md): I14 and I16 fixed and independently checked; I15 remains a release blocker. The [peer-review record](../security/peer-review.md) awaits a reviewer who did not implement the code.

## D2 — bounded mainnet pilot

**Pilot policy:** one reference merchant, one official USDC SAC, builder-funded
account; per payment at most 1 USDC, rolling 24-hour limit at most five
payments and 5 USDC; operational account balance cap 10 USDC with a 5 USDC
starting target. The contract enforces the payment/window limits. The balance
cap is measured and controlled operationally.

| Control or event | Public evidence | Status |
|---|---|---|
| Go/no-go, artifact and live RPC identity | [readiness checklist](readiness-checklist.md), [deployment record](deployment-record.md) | pending |
| Production accounts, trustlines and deployed contract | deployment record and explorer links | pending |
| Hosted facilitator mainnet settlement and protected response | transaction and request result, with secrets removed | pending |
| Linked PoI event and replay/refusal checks | transaction/event links | pending |
| Freeze, restore, signer revoke, merchant removal and recovery | owner transaction links | pending |
| Payment count, spend and account balance reconciliation | collector export checked against ledger | pending |

Do not add a real mainnet transaction link to this report until the gate
records its source commit, artifact hash, operator, network and financial
limit. Testnet transactions above do not satisfy these D2 rows.

## D3 — operations, users and learning

The hosted [testnet rehearsal](../operations/rehearsals/2026-10-02-testnet-hosted.md)
covers incident and migration actions. The 2 October [HTTP smoke](verification-2026-10-02.md)
proves that the public frontend and the separate agent/merchant services
responded, but did not prove a real passkey on the final origin or a running
collector. A later status request timed out; recheck the hosted environment
when deployment stabilizes and record that result separately.

| Evidence | Result |
|---|---|
| Live landing, mobile/desktop QA and valid links | pending |
| Collector continuity, public status and anonymized event export | pending |
| Cookie-free daily page/link counts and aggregate pilot use | pending |
| Evaluation A, target role and anonymous notes | pending; [schedule](../customer/schedule.md) has no date |
| Evaluation B and explicit recording consent | pending; [consent form](../customer/consent.md) prepared |
| H1–H5 decisions and one applied product change | pending; [results table](../customer/hypothesis-results.md) prepared |
| Third-month recommendation based on the two evaluations | pending |

## Known limitations and next decision

1. The mainnet Supabase project has nine expected tables readable by the
   service role, but its RLS/policy/function permissions still require the
   [SQL Editor read-only check](supabase-verification.sql). The two migration
   paths are explained in the [reconciliation](migration-reconciliation.md).
2. [I15](../security/findings.md) remains open: historical raw collector
   errors could appear on the public status route, and raw provider errors
   could appear in hosted logs. The release decision stays blocked until the
   read, logging and canary-route checks pass.
3. The live mainnet RPC protocol, final WebAuthn origin, production identities,
   external reviewer, release CI/tag and user session dates are unverified.

The next report update should replace each `pending` cell with a dated link
or a clear failed result. Once D1–D3 evidence is complete, attach the final
demo, source commit, CI run, artifact/code hash and `v0.2.0` tag to the
[evidence index](../evidence.md) and record the reviewer and Emir's decision.
