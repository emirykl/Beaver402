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
| Contract | |
| Deployed | date, ledger |
| Source commit | |
| Release tag | |
| Artifact sha256 | must equal the reviewed hash in [release.md](release.md) |
| Code hash on chain | |

## Parameters fixed at creation

| | |
|---|---|
| Owner passkey | public key, and the domain it belongs to |
| Relying party hash | sha256 of the domain |
| Agent signer | public key |
| Asset | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`, Circle USDC |
| Recovery address | |
| Limits | 1 USDC per payment, 5 payments and 5 USDC in any 24 hours |

## Roles

| Role | Public key | Where its secret lives |
|---|---|---|
| Deployer and fee account | | the operator's machine, the agent deployment |
| Agent | | the agent deployment |
| Merchant | | the merchant deployment |
| Recipient | | the merchant's treasury |
| Recovery | | not held by any service |
| Facilitator | | OpenZeppelin Channels, mainnet |

## Setup transactions

| Step | Transaction |
|---|---|
| Code uploaded | |
| Account created | |
| Merchant approved with the passkey | |
| Account funded | |

## Pilot transactions

| Step | Transaction | Notes |
|---|---|---|
| Payment from the MCP tool, settled by the facilitator | | |
| Its proof of intent | | |
| Request changed after signing, refused | none, refused before submission | reproducible log |
| Halt | | |
| Payment while halted, refused | none | `AccountFrozen` |
| Resume | | |
| Second payment | | |
| Agent key revoked | | |
| Payment after revocation, refused | none | `SignerRevoked` |
| Agent key reinstated | | |
| Merchant removed | | incident drill |
| Limits lowered | | incident drill |
| Funds recovered | | incident drill |

## Checked after deployment

| Check | Result |
|---|---|
| `get_asset` is Circle USDC | |
| `get_recovery` is the recovery address | |
| `get_agent_signer` is the agent | |
| `get_velocity_config` is the pilot limits | |
| The account's lifetime is the full 150 days | |
| The status page shows the account | |
| The event collector has its first run | |
