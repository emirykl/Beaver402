# Third month evidence

Instawards third month: the merchant integration kit, a second merchant on
mainnet under the same limits, collector alerts, developer validation and
public communication. Each row is filled when its evidence exists, with a
public link. A row without a link is not claimed.

## D1: Merchant integration kit and developer guide

| Evidence | Status | Link |
|---|---|---|
| Package source, tests, example | done | [`packages/merchant`](../../packages/merchant) |
| Setup guide, configuration reference, troubleshooting | done | [README](../../packages/merchant/README.md), [configuration](../../packages/merchant/docs/configuration.md), [troubleshooting](../../packages/merchant/docs/troubleshooting.md) |
| Automated test results | CI | the "Merchant kit" job |
| Tagged release candidate | pending | |
| Testnet payment through the kit, with linked Proof of Intent | pending: owner approval on testnet | |
| Independent developer setup notes | pending | |
| Final release with the feedback applied | pending | |

## D2: Second merchant and mainnet operations

| Evidence | Status | Link |
|---|---|---|
| Owner panel lists each merchant with its approval | done | `frontend/src/App.tsx`, `backend/src/policy/merchants.ts` |
| Second merchant refused before approval (testnet) | pending | |
| Owner approval of the second merchant (testnet) | pending | |
| One testnet payment to each merchant | pending | |
| Changed request and changed recipient refused after approval | pending | |
| Mainnet checks: network, account, trustline, facilitator, keys, store, limits | pending | |
| Owner approval on mainnet | pending | |
| 0.1 USDC mainnet settlement and Proof of Intent | pending | |
| Policy screenshot: 1 USDC per payment, 5 payments and 5 USDC per day, 10 USDC balance cap | pending | |
| Collector record matches the settlement | pending | |
| Collector alerts, both conditions | rehearsed 2026-11-27 | [alerts](../operations/alerts.md#rehearsal); the received emails are kept with the submission |

## D3: Developer validation and public communication

| Evidence | Status | Link |
|---|---|---|
| Three anonymized conversation summaries | pending | |
| Independent developer setup, observed | pending | |
| Improvement made from the feedback | pending | |
| Consented follow-up video with a second-period participant | pending | |
| X account and pilot contact route on the landing page | done | landing footer and closing section |
| Six X posts with dates, views and engagement | pending | |
| Inquiry summary | pending | |
| Final report: five hypotheses and the strongest adoption barrier | pending | |

## Operations this month

| Date | What | Link |
|---|---|---|
| 2026-11-27 | Protocol 30 SDK update of the hosted mainnet services | [deployment record](../mainnet/deployment-record.md#hosted-service-updates), [finding I17](../security/findings.md) |
