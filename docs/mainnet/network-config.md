# Network configuration

Everything that differs between testnet and mainnet, in one place. The
backend derives all of it from `BEAVER_NETWORK` in `backend/src/config/network.ts`
and refuses to start when anything given explicitly disagrees.

Confirmed on 2026-10-02.

| | Testnet | Mainnet |
|---|---|---|
| `BEAVER_NETWORK` | `testnet` (the default) | `mainnet` |
| Passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| CAIP-2, as x402 names it | `stellar:testnet` | `stellar:pubnet` |
| Protocol | 29 | 29 (moved from 28 on 2026-10-01) |
| Soroban RPC | `https://soroban-testnet.stellar.org` | a provider's endpoint, required, https only |
| USDC issuer (Circle) | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| USDC contract, derived from the issuer | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| Facilitator | `https://channels.openzeppelin.com/x402/testnet` | `https://channels.openzeppelin.com/x402` |
| Explorer | `https://stellar.expert/explorer/testnet` | `https://stellar.expert/explorer/public` |
| Passkey relying party | `localhost` locally | the panel's domain, https only |
| Minimum lifetime of a new persistent entry | 120,960 ledgers, 7 days | 2,073,600 ledgers, 120 days |
| Minimum lifetime of a new temporary entry | 720 ledgers | 17,280 ledgers, 1 day |
| Maximum lifetime | 3,110,400 ledgers | 3,110,400 ledgers |

The mainnet USDC contract is the one the `@x402/stellar` package names, and
the one Horizon lists for USDC issued by Circle's mainnet account, whose
`stellar.toml` is served from `circle.com`. The backend test suite derives it
from the issuer and checks both.

The mainnet lifetimes are why a payment may never create a storage entry or
grow one: either would be paid for months ahead inside the payment, and the
facilitator refuses any payment whose fee is over its ceiling. See
[x402 compatibility](x402-compat.md).

## Versions

| | Version |
|---|---|
| `soroban-sdk` | 28.0.0 |
| Rust | 1.96.0, pinned in `rust-toolchain.toml` |
| Stellar CLI | 27.0.0, pinned in CI with its checksum |
| `@stellar/stellar-sdk` | 16.3.1, axios overridden to 1.20.0 |
| `@x402/core`, `@x402/stellar` | 2.28.0, exact |

## Checked at runtime

Before the first thing it signs, the backend asks the RPC endpoint which
network it serves and refuses to go on if the answer is not the configured
passphrase. The deploy script runs the same check. The merchant asks the
facilitator, through `/supported`, whether it settles the exact scheme on the
configured network before its first payment.
