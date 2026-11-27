# Changelog

## 0.1.0

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
