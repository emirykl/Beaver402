# Changelog

## 0.1.0-rc.3

- `beaver402-merchant init`: one command from an empty folder to a testnet
  merchant: key, friendbot funding, USDC trustline, an optional free
  facilitator key, `.env` and a `server.ts` with a paid GET and POST
- The guide starts with a five command quick start that installs from the
  release, and explains how to take the first payment: tunnel, `PUBLIC_URL`,
  what to send the account owner and what success looks like.
  See `docs/month-3/guide-review.md` in the repository for why

## 0.1.0-rc.2

- `supabaseStore()`: the settlement store through a supabase-js client, for
  merchants without a lasting disk, such as Vercel functions
- `deploy-vercel/`: the example as a Vercel function, installed from the
  release like any other project

## 0.1.0-rc.1

First release.

- `createMerchant()` with `protect()` Express middleware: x402 v2 `exact`
  USDC payments on Stellar with a Beaver402 challenge bound to method, URL,
  query, body, price and recipient
- Checks before anything settles: requirements, challenge binding, the
  merchant's own signature, expiry, payment reuse, and the paying account's
  merchant approval (`is_merchant`)
- Ledger confirmation of the settlement, independently of the facilitator
- Settlement stores: `memoryStore`, `fileStore`, `postgresStore`. Mainnet
  needs a persistent one
- Proof of Intent publication with retry from the CLI when the first attempt fails
- Network checks before the first challenge: RPC network, recipient account
  and USDC trustline, signer balance, facilitator support
- CLI `beaver402-merchant`: `keygen`, `setup-testnet`, `usdc`, `check`, `info`,
  `publish-proof`, `pending-proofs`
- Express example with a paid GET and a paid POST
