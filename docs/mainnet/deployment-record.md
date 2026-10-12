# Deployment record

Everything needed to check the mainnet pilot account independently: what
was deployed, from which source, with which parameters, and every
transaction that set it up. No secret appears here; every key is named by
its public half.

_Filled in at the mainnet deployment._

## The account

| | |
|---|---|
| Network | Stellar mainnet, `Public Global Stellar Network ; September 2015` |
| Contract | [`CBSMQ7LUZYAAN5P2JAAR74AFNKRZYF32JA4VTX3BFBFDCY4JXF5SFVXL`](https://stellar.expert/explorer/public/contract/CBSMQ7LUZYAAN5P2JAAR74AFNKRZYF32JA4VTX3BFBFDCY4JXF5SFVXL) |
| Deployed | 8 October 2026, ledger 64831361 |
| Source commit | `e495ae8` on `contract-hardening`; contract source identical to `v0.2.0-rc.1` |
| Release tag | `v0.2.0` (commit `ad7054e`, CI [37742442224](https://github.com/emirykl/Beaver402/actions/runs/37742442224)) |
| Artifact sha256 | `b94e7a951332b9192696a2f6778a8e3833398172162b305271598285e19ae73f`, the reviewed release candidate |
| Code hash on chain | `b94e7a951332b9192696a2f6778a8e3833398172162b305271598285e19ae73f` |

## Parameters fixed at creation

| | |
|---|---|
| Owner passkey | `048453002ab0ec37…`, on `beaver402.vercel.app` |
| Relying party hash | `bc08731c40fd1ebaa981da6e2c9a372fc5c1ae5d611b38bb7439c64c184e1b0c` |
| Agent signer | `GCYXQGDJRIWLXOQNKGCJFBA7K6POKF2I47OWBCNH3YJDIH55CQMTKJ6B` |
| Asset | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`, Circle USDC |
| Recovery address | `GA23GAV6HBRDAL3A5HP7X2M7LD2NFGINPKNZTJU5J54SLSLOEIMRTEWG` |
| Limits | 1 USDC per payment, 5 payments and 5 USDC in any 24 hours |

## Roles

| Role | Public key | Where its secret lives |
|---|---|---|
| Deployer and fee account | `GBPIAV3AHJ6VPJVYFSLOSXCDA324EXX473OA4G7K5EHK445DODFY2AVG` | the operator's machine, the agent deployment |
| Agent | `GCYXQGDJRIWLXOQNKGCJFBA7K6POKF2I47OWBCNH3YJDIH55CQMTKJ6B` | the agent deployment |
| Merchant | `GCN3SBGN2EH3TDDIOVAIYJUPU6DMJDOUOZLM4SIA77YPUEEX4QEXWCV6` | the merchant deployment |
| Recipient | `GCN3SBGN2EH3TDDIOVAIYJUPU6DMJDOUOZLM4SIA77YPUEEX4QEXWCV6`, the merchant itself | the merchant's treasury |
| Recovery | `GA23GAV6HBRDAL3A5HP7X2M7LD2NFGINPKNZTJU5J54SLSLOEIMRTEWG` | not held by any service |
| Facilitator | `GA5SXMFJTUPTZRIEKM6XZLCYOZRMUEE6KGAHL3GXDBG64DYOUIWYIF3M` | OpenZeppelin Channels, mainnet |

## Setup transactions

| Step | Transaction |
|---|---|
| Code uploaded | [`f8637d1d`](https://stellar.expert/explorer/public/tx/f8637d1d2e3e49d96d5085716040f22273986f307e06e34924c64b3d558c7044), 8 October 2026, ledger 64827466, fee 28.2011 XLM |
| Account created | [`f48eeaa4`](https://stellar.expert/explorer/public/tx/f48eeaa4aaf6619d1caa0f467b56284eb5d47f0a335c1d90579af9858a77d077), fee 7.6607 XLM |
| Merchant approved with the passkey | [`75e6ba9a`](https://stellar.expert/explorer/public/tx/75e6ba9ae2113ddb01cef0bf37fc099e5236006c411ea38f70cde9556fc273f4) |
| Account funded | 5.5 USDC from the recovery wallet, 8 October 2026 |

## Pilot transactions

| Step | Transaction | Notes |
|---|---|---|
| Payment from the MCP tool, settled by the facilitator | [`035fdb6d`](https://stellar.expert/explorer/public/tx/035fdb6d1e816eb832168510aac99397e743448302c3e86274479840ee5568c4) | 0.1 USDC, fee paid by the facilitator |
| Its proof of intent | [`cb59a5ed`](https://stellar.expert/explorer/public/tx/cb59a5ed1335446f3506e40721cde7116a6831be112cbcbb4d56f0151a3c784a) | |
| Request changed after signing, refused | none, refused before submission | reproducible log |
| Halt | [`119d9dbf`](https://stellar.expert/explorer/public/tx/119d9dbf8e6676a056c91218e6dab121f0217e4dbef12486a1c07576656a3f2f); first halt from the panel [`99c5d648`](https://stellar.expert/explorer/public/tx/99c5d648de39acd0c173ac551b4516724da8c92ca899a46976d758a8cb6fe3d0) | |
| Payment while halted, refused | none | `AccountFrozen` |
| Resume | [`5db6b018`](https://stellar.expert/explorer/public/tx/5db6b0185416b5f2156d9991dc70b98f51bec324f088126030bbf1b601d03c50) | |
| Second payment | [`98d4a50a`](https://stellar.expert/explorer/public/tx/98d4a50aff86e6ccca03e2ec51bef337f4425c6ea465c3c8598208325d1db9b9) | proof [`7bf2bc08`](https://stellar.expert/explorer/public/tx/7bf2bc08d6504b48e054fc25919acd8d042d94c41580f5085b68052d2321106a) |
| Agent key revoked | [`7a539f58`](https://stellar.expert/explorer/public/tx/7a539f5810ad70e8d61672fe05352a2455d0d0370cbbf021b45d32133422aeb3) | |
| Payment after revocation, refused | none | `SignerRevoked` |
| Agent key reinstated | [`4e4bed49`](https://stellar.expert/explorer/public/tx/4e4bed49dce390f5e29385ac4ff5b5ead2e40914f9e10233b2bf09e2bc793767) | |
| Merchant removed | | incident drill |
| Limits lowered | | incident drill |
| Funds recovered | [`05b67079`](https://stellar.expert/explorer/public/tx/05b6707900f9d2b2dbd6098960b7ae0fc82c00b661d07d08bcadab0851512f66) | 5.1 USDC to the recovery address, after halt [`6ef53d84`](https://stellar.expert/explorer/public/tx/6ef53d84cc9ca167af86ddd365f8b0b56e1d6b496c7f2773e6fc3785ccb346ab) |

## Checked after deployment

| Check | Result |
|---|---|
| `get_asset` is Circle USDC | yes, checked by deploy.sh |
| `get_recovery` is the recovery address | yes, checked by deploy.sh |
| `get_agent_signer` is the agent | yes, checked by deploy.sh |
| `get_velocity_config` is the pilot limits | yes: 1 USDC, 5 payments, 5 USDC, 86,400 s |
| The account's lifetime is the full 150 days | |
| The status page shows the account | |
| The event collector has its first run | |
