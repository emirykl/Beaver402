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
| Tagged release candidate | done 2026-11-27; installs from the release URL into an empty project | [merchant-v0.1.0-rc.1](https://github.com/emirykl/Beaver402/releases/tag/merchant-v0.1.0-rc.1), tarball sha256 `6963e8b7f1b60e3cbb31d37e3d91a6511cbff35badbe9b61b8511ff7fa3a9fbf` |
| Testnet payment through the kit, with linked Proof of Intent | done 2026-11-27, `npm run kit:e2e` against the kit's example | GET with a query: [settlement](https://stellar.expert/explorer/testnet/tx/c1096a70b267b65d426a50c3fa105fcd788c5971e822bb7ef3a8edba35484e48), [PoI](https://stellar.expert/explorer/testnet/tx/6c825a87d2b2f59e32e706c7e9fe37e0c7d706d4a9b7bc7866940ecb17dd4f3d). POST with a body: [settlement](https://stellar.expert/explorer/testnet/tx/59a2ae9d63134b8ce54230574d56a38417062d14efd8c18316abbd8798fd3f39), [PoI](https://stellar.expert/explorer/testnet/tx/2f01157599c7616959589f9b8818507465a83aebe97d195e97e201e56012e83a). Refused, nothing settled: a request changed after signing, requirements pointing at another recipient, an unapproved merchant key |
| Builder's newcomer review of the guide, and the changes it led to | done 2026-11-27, `merchant-v0.1.0-rc.3` | [guide review](guide-review.md), [rc.3](https://github.com/emirykl/Beaver402/releases/tag/merchant-v0.1.0-rc.3) |
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
| Mainnet checks: network, account, trustline, facilitator, keys, store, limits | done 2026-11-27 | the merchant's own preflight passed before its first challenge (RPC on mainnet, recipient USDC trustline, signer funded, OpenZeppelin facilitator, Supabase store); limits read back unchanged |
| Owner approval on mainnet | done, passkey | [`6512938a`](https://stellar.expert/explorer/public/tx/6512938a70160da4b2868f31ba0d31bf480e1764a8fdff62e30cd2cf185964b0) (`merchant/added`); account resumed in [`a5ec57d3`](https://stellar.expert/explorer/public/tx/a5ec57d3975c66a206792b85a6592a0218a55ad5beebfd9b04df39ef180fcef6) |
| 0.1 USDC mainnet settlement and Proof of Intent | done 2026-11-27 16:45 UTC, agent to `https://beaver402-merchant-2.vercel.app/forecast?city=Ankara` | settlement [`23812035`](https://stellar.expert/explorer/public/tx/238120350b217d6c5e018b04f7dfdc1348b4f236663a191a1164ffa3c49d87da), PoI [`a900dfc4`](https://stellar.expert/explorer/public/tx/a900dfc4bcbb497bdd307ebbc01ae35898137025103b39350732badbacb030a6) |
| Policy screenshot: 1 USDC per payment, 5 payments and 5 USDC per day, 10 USDC balance cap | pending | |
| Collector record matches the settlement | done | `chain_events` ledger 65702372: `transfer` from the account to `GCJT…JS2G`, 1000000 units, tx `23812035`; ledger 65702374: `poi/verified`, amount 1000000, tx `a900dfc4` |
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

### Second merchant on mainnet

Hosted from the kit's release (`packages/merchant/deploy-vercel`, `merchant-v0.1.0-rc.2`) at `https://beaver402-merchant-2.vercel.app`. Signing key `GA5ZPOPQMGMKW4UVB2KCVEMSHW75BRM7XWAJAPVON7QSDAOHMWQYKNSC`, held only by that deployment; payments land in a wallet of the builder's, `GCJT4JWWRGHJDBH6WEKTWNQFOXELHKMCSZ7PDREFWE547RIX7A4KJS2G`. The builder operated this merchant; the independent developer's setup is recorded separately. The refusal of an unapproved merchant is shown on testnet, as the scope places it.

| Time (UTC) | Step | Fee | Link |
|---|---|---|---|
| 15:04 | 0.3 USDC from the recovery wallet to the account | | [`4f0b4ea4`](https://stellar.expert/explorer/public/tx/4f0b4ea4b0a17974d985a9a6d2607542a50e03d3aa4c04b9dccbd75547cd9f72) |
| 16:44 | Merchant 2 approved, passkey; also extended the account and its code to 150 days | 12.05 XLM, almost all of it rent ([I21](../security/findings.md)) | [`6512938a`](https://stellar.expert/explorer/public/tx/6512938a70160da4b2868f31ba0d31bf480e1764a8fdff62e30cd2cf185964b0) |
| 16:45 | Payments resumed, passkey | 0.001 XLM | [`a5ec57d3`](https://stellar.expert/explorer/public/tx/a5ec57d3975c66a206792b85a6592a0218a55ad5beebfd9b04df39ef180fcef6) |
| 16:45 | 0.1 USDC paid by the agent, settled by the facilitator, content released | 0.0015 XLM, paid by the facilitator | [`23812035`](https://stellar.expert/explorer/public/tx/238120350b217d6c5e018b04f7dfdc1348b4f236663a191a1164ffa3c49d87da) |
| 16:45 | Proof of Intent published by Merchant 2 | 0.0005 XLM | [`a900dfc4`](https://stellar.expert/explorer/public/tx/a900dfc4bcbb497bdd307ebbc01ae35898137025103b39350732badbacb030a6) |

### Independent developer run on testnet, 27 November 2026

A developer who has not contributed to Beaver402 set the merchant up from the
published guide, through its "Open in GitHub Codespaces" route, on a computer
other than the builder's. The codespace ran under the builder's GitHub account, which was
signed in on that computer; the developer followed the guide without help and
made port 4021 public by hand, as the guide's terminal message asks. Their
merchant key is `GBWVX6KX46J2TCQJ6FF373B4ZSYYDMO7HFNN4WVB4Y3QQASJRWF2M7BS`.
The signing key stayed in the codespace and was not shared.

| Step (UTC) | Result | Link |
|---|---|---|
| Developer's checks against their own server | `/merchant` 200, `/forecast` and `/summarize` 402; a changed request, another recipient and an unapproved merchant key were all refused | developer's terminal |
| 21:50 payment before the owner approved the key | refused by the policy, nothing settled | owner panel, settlements |
| 21:53 owner approval with the passkey | `Developer merchant` approved | owner panel, log |
| 21:54 payment of 0.1 test USDC to `GET /forecast?city=Ankara` | settled, content released | [settlement](https://stellar.expert/explorer/testnet/tx/7f6cb9c23e737cb659c13807cfd6cebe051577744fc3717fe8461efce71e41e7), [PoI](https://stellar.expert/explorer/testnet/tx/05df29b3e2c4f8e0f24b14625786f18c80d96c271cee74e6e83e4f25d3a719a0) |

## D3: Developer validation and public communication

| Evidence | Status | Link |
|---|---|---|
| Three anonymized conversation summaries | pending | |
| Independent developer setup, observed | done 2026-11-27 (UTC), payment settled; observation notes pending | [Independent developer run](#independent-developer-run-on-testnet-27-november-2026) |
| Improvement made from the feedback | pending | |
| Consented follow-up video with a second-period participant | pending | |
| X account and pilot contact route on the landing page | done | landing footer and closing section |
| Six X posts with dates, views and engagement | pending | |
| Inquiry summary | pending | |
| Final report: five hypotheses and the strongest adoption barrier | pending | |

## Operations this month

| Date | What | Link |
|---|---|---|
| 2026-11-27 | First manual mainnet collector run failed and raised the `collector_failed` alert by email; cause was the RPC provider's per-call limit, fixed in `dd608c3`, pilot events backfilled | [finding I20](../security/findings.md) |
| 2026-11-27 | Month 3 code deployed to the hosted mainnet services from `main` (`8180a74`) | `beaver402-api`, `beaver402-merchant`, `beaver402` |
| 2026-11-27 | Stellar owner actions ask for the owner's own passkey; a second passkey for the same domain had signed and was refused | `f166987` |
| 2026-11-27 | Protocol 30 SDK update of the hosted mainnet services | [deployment record](../mainnet/deployment-record.md#hosted-service-updates), [finding I17](../security/findings.md) |
