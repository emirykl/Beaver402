# Configuration reference

`createMerchant(options)` checks every option before anything is signed and
throws `MerchantConfigError` naming the one that is wrong. The CLI and the
example read the same options from environment variables.

| Option | Variable | Required | Meaning |
| --- | --- | --- | --- |
| `network` | `BEAVER402_NETWORK` | always | `testnet` or `mainnet`. No default |
| `usdcContract` | `USDC_CONTRACT` | always | Circle's USDC Stellar Asset Contract on that network. Anything else is refused. `usdcContract("testnet")` or `beaver402-merchant usdc testnet` prints it |
| `rpcUrl` | `SOROBAN_RPC_URL` | mainnet | Soroban RPC. Testnet defaults to `https://soroban-testnet.stellar.org`. On mainnet: https, not a test network |
| `facilitatorUrl` | `FACILITATOR_URL` | no | x402 facilitator. Defaults to OpenZeppelin Channels: `https://channels.openzeppelin.com/x402/testnet` or `https://channels.openzeppelin.com/x402`. The other network's is refused |
| `facilitatorApiKey` | `FACILITATOR_API_KEY` | always | Its API key. Free from `https://channels.openzeppelin.com/testnet/gen` (testnet) or `/gen` (mainnet) |
| `merchantSecret` | `MERCHANT_SECRET` | always | The merchant's S secret. Signs challenges; its account pays the Proof of Intent fee |
| `recipient` | `RECIPIENT_ADDRESS` | always | Where USDC lands: a classic G account with an authorized USDC trustline. C and M addresses are refused |
| `price` | `PRICE_USDC` | always | Default price in integer units of 10⁻⁷ USDC. `usdc("0.1")` gives `1000000`. The variable takes decimal USDC, `0.1` unless set |
| `publicUrl` | `PUBLIC_URL` | mainnet | The https origin agents call, without a path. The challenge signs `publicUrl + path + query`. Without it the request's protocol and Host header are used, which is wrong behind a proxy |
| `store` | `SETTLEMENT_STORE` | always | Where completed payments are recorded. The variable names a file for `fileStore()`; unset means `memoryStore()`, which mainnet refuses |
| `challengeSeconds` | | no | How long a challenge stays payable. 300 unless set, 30 to 900 |
| `description` | | no | Shown to the payer in the 402 answer |
| `logger` | | no | `{ info, warn, error }`. `console` unless set. Secrets are never logged |

Per route, `protect({ price, description })` overrides the price and the
description.

## Stores

| Store | Persistent | Use |
| --- | --- | --- |
| `memoryStore()` | no | Tests and testnet. Forgets every payment on restart, so mainnet refuses it |
| `fileStore(path)` | yes | One process on one machine. Append-only JSON lines, flushed to disk before a payment counts as recorded. A lock file stops a second process from opening the same file |
| `postgresStore(client)` | yes | Several instances. Takes a node-postgres `Pool` or anything with the same `query(sql, params)`. Create the table with `POSTGRES_SCHEMA` first. Unique constraints on the transaction hash and the nonce do the duplicate check |

Your own store implements `SettlementStore`: `hasNonce`, `record` (false
when the hash or the nonce is already there; enforce it atomically),
`markProof`, `pendingProofs`, and `persistent`.

## What the network checks look at

`merchant.check()` and `beaver402-merchant check` report each of these. The
merchant runs them before its first challenge and answers `503` while an
error stands.

| Check | Fails when |
| --- | --- |
| network | The RPC serves another network than the one named |
| recipient account | The recipient does not exist |
| recipient trustline | It has no USDC trustline, or the issuer has not authorized it |
| signer balance (warning) | The signing account is missing or holds under 2 XLM, so proofs may not publish |
| facilitator | It cannot be reached, refuses the key, or does not settle exact payments on this network |
| settlement store | Mainnet with a store that is not persistent |

## The 402 answer

```json
{
  "x402Version": 2,
  "error": "Payment Required",
  "resource": { "url": "https://api.example.com/forecast?city=Ankara", "description": "...", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact", "network": "stellar:testnet",
    "asset": "C...USDC", "amount": "1000000", "payTo": "G...recipient",
    "maxTimeoutSeconds": 60, "extra": { "areFeesSponsored": true }
  }],
  "extensions": { "beaver402": { "challenge": { "fields": { "...": "..." }, "hash": "...", "merchantSignature": "...", "merchantPubkey": "G..." } } }
}
```

The same object travels base64 encoded in the `PAYMENT-REQUIRED` header.
The settlement response comes back in `PAYMENT-RESPONSE`, with
`extensions.beaver402 = { challengeHash, nonce, proofTransaction }`.
Inside the route, `res.locals.beaver402` holds `{ payment, receipt }`.
