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
| Testnet payment through the kit, with linked Proof of Intent | done 2026-11-27, `npm run kit:e2e` against the kit's example | GET with a query: [settlement](https://stellar.expert/explorer/testnet/tx/c1096a70b267b65d426a50c3fa105fcd788c5971e822bb7ef3a8edba35484e48), [PoI](https://stellar.expert/explorer/testnet/tx/6c825a87d2b2f59e32e706c7e9fe37e0c7d706d4a9b7bc7866940ecb17dd4f3d). POST with a body: [settlement](https://stellar.expert/explorer/testnet/tx/59a2ae9d63134b8ce54230574d56a38417062d14efd8c18316abbd8798fd3f39), [PoI](https://stellar.expert/explorer/testnet/tx/2f01157599c7616959589f9b8818507465a83aebe97d195e97e201e56012e83a). Refused, nothing settled: a request changed after signing, requirements pointing at another recipient, an unapproved merchant key |
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

### Builder rehearsal on testnet, 27 November 2026

Run by the builder with a second merchant account of its own
(`GAPE262SQ4HX6WAB4PMTSKXP5A4XA5UUEUCGUZAA7L7XUZ2CYFABSXWA`), set up from the
kit's guide with `beaver402-merchant setup-testnet`. It proves the flow before
the independent developer runs it with their own account; it does not replace
that run.

| Step | Result | Link |
|---|---|---|
| Payment to the second merchant before approval | refused by the policy, nothing settled | agent answer |
| Owner approval of the second merchant, passkey | confirmed in the panel | panel log |
| GET with a query to the second merchant | settled | [settlement](https://stellar.expert/explorer/testnet/tx/de41b6e0e3ff32ec282e2c3b0318cb19f1211db3c9728e7924c69c7806d1ca46), [PoI](https://stellar.expert/explorer/testnet/tx/d01780d2f0f02abe399afdc06520932b93b836cd16abf2dd9ce288269f780d14) |
| POST with a body to the second merchant | settled | [settlement](https://stellar.expert/explorer/testnet/tx/c553d42ee2d261c45d13434aee358e1838fec29e20813ebcbe71eec4973b67e9), [PoI](https://stellar.expert/explorer/testnet/tx/ef76293db6bceed5fe810d2fd2473bded20cdbce87a2e6e79ea07d1f243c6ed7) |
| Request changed after signing, after approval | refused | agent answer |
| Requirements pointing at another recipient, after approval | refused | agent answer |
| Shared limits | unchanged: 1 USDC per payment, 5 payments and 5 USDC per 24 hours; both merchants counted in one window (4 of 5, 0.6 USDC) | `get_velocity_config`, `get_velocity_state` |

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
| 2026-11-27 | Stellar owner actions ask for the owner's own passkey; a second passkey for the same domain had signed and was refused | `f166987` |
| 2026-11-27 | Protocol 30 SDK update of the hosted mainnet services | [deployment record](../mainnet/deployment-record.md#hosted-service-updates), [finding I17](../security/findings.md) |
