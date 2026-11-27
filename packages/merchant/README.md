# @beaver402/merchant

Put an API route behind an x402 USDC payment on Stellar, protected by
Beaver402's Proof of Intent.

An AI agent paying through a Beaver402 policy account only pays when two
things agree: a challenge this merchant signs over the exact request (method,
URL with query, body, price, recipient), and the agent's own reconstruction
of that request. The payment is a standard x402 v2 `exact` payment, settled
by an x402 facilitator. This package is the merchant's half:

- answers an unpaid request with `402` and a signed challenge
- checks a payment answers that challenge for this very request, before
  anything settles
- checks the paying account's owner has approved this merchant
- has the facilitator verify and settle it
- confirms on the ledger itself that the agreed USDC moved to the recipient
- records the payment, so it unlocks one response only, also across restarts
- publishes the Proof of Intent and returns it in the receipt

The protected route runs only after all of that has passed.

- [Setup guide](#setup-on-testnet) (this page)
- [Configuration reference](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)

## Install

Node 20.12 or later. From a release tarball:

```sh
npm install https://github.com/emirykl/Beaver402/releases/download/merchant-v0.1.0-rc.2/beaver402-merchant-0.1.0-rc.2.tgz express
```

## Use

```ts
import express from "express";
import { captureRawBody, createMerchant, fileStore, usdc, usdcContract } from "@beaver402/merchant";

const merchant = createMerchant({
  network: "testnet",
  usdcContract: usdcContract("testnet"),
  facilitatorApiKey: process.env.FACILITATOR_API_KEY!,
  merchantSecret: process.env.MERCHANT_SECRET!,
  recipient: process.env.RECIPIENT_ADDRESS!,
  price: usdc("0.1"),
  store: fileStore("./data/payments.jsonl"),
});

const app = express();
app.use(express.json({ verify: captureRawBody })); // the challenge signs the raw body

app.get("/forecast", merchant.protect(), (req, res) => {
  res.json({ forecast: "sunny", paidWith: res.locals.beaver402.payment.txHash });
});
app.post("/summarize", merchant.protect({ price: usdc("0.2") }), (req, res) => {
  res.json({ summary: "..." });
});

app.listen(4021);
```

Every option is checked when `createMerchant` runs, and the network side
(RPC, recipient trustline, facilitator, signer balance) before the first
challenge goes out. A merchant that is set up wrong answers `503` and
logs why. It never hands out a challenge that cannot be paid.

## Setup on testnet

This walks through running the example as a new, separate merchant and
taking one protected testnet payment. Plan on about half an hour.

### 1. Get the example

```sh
git clone https://github.com/emirykl/Beaver402.git
cd Beaver402/packages/merchant
npm install && npm run build
cd example && npm install
cp .env.example .env
```

### 2. Make the merchant account

The merchant has one Stellar account that signs challenges, receives the
USDC and pays the small fee for publishing each Proof of Intent.

```sh
npx beaver402-merchant keygen
```

Put the secret in `.env` as `MERCHANT_SECRET` and keep it to yourself. Then
fund the account with test XLM and add the USDC trustline it needs to receive
payments:

```sh
npx beaver402-merchant setup-testnet
```

Put the printed public key in `.env` as `RECIPIENT_ADDRESS`.

### 3. Get a facilitator key

The facilitator submits the payment and pays its network fee. Get a free
testnet key from OpenZeppelin Channels at
<https://channels.openzeppelin.com/testnet/gen> and put it in `.env` as
`FACILITATOR_API_KEY`.

### 4. Check the setup

```sh
npx beaver402-merchant check
```

Every line should say `ok`. A `FAIL` line says what to fix; see
[troubleshooting](docs/troubleshooting.md).

### 5. Start the merchant

```sh
npm start
```

`GET /forecast` now answers `402 Payment Required` with a challenge.
`GET /merchant` prints the merchant's public key.

### 6. Get the merchant approved

A Beaver402 account pays only merchants its owner approved, one by one,
with their passkey. Send the account owner the `merchantPubkey` from
`GET /merchant`. They add it to their panel's merchant list and press
**APPROVE**. Until then every payment to you is refused with
`the paying account's owner has not approved this merchant`. That refusal
is the protection working.

Approving another merchant does not raise the account's limits: every
merchant shares the same per payment, daily and balance caps.

### 7. Take a payment

The account owner's agent calls your URL. On success the response carries a
`PAYMENT-RESPONSE` header with the settlement transaction and, under
`extensions.beaver402.proofTransaction`, the Proof of Intent. Both open on
<https://stellar.expert/explorer/testnet>.

If the merchant is reachable only on your machine, expose it with a tunnel
(for example `cloudflared tunnel --url http://localhost:4021`) and set
`PUBLIC_URL` to the tunnel's https origin, so the URL the challenge signs is
the one the agent calls.

## Going to mainnet

The same code, with stricter configuration. The merchant refuses to start
unless all of these are set:

- `network: "mainnet"` and the mainnet USDC contract
  (`npx beaver402-merchant usdc mainnet`)
- `rpcUrl`, an https mainnet Soroban RPC from a provider. There is no public one
- a mainnet facilitator key from <https://channels.openzeppelin.com/gen>
- `publicUrl`, the https origin agents call
- a persistent `store`: `fileStore()` for one process, `postgresStore()` for more

The merchant account needs real XLM (about 2 XLM keeps proofs publishing for
a long time) and a USDC trustline, which a wallet such as Freighter or
Lobstr adds. Run `beaver402-merchant check` against mainnet before you
announce the endpoint.

## When the Proof of Intent did not publish

The payment has settled either way and the response is served. If
publishing the proof fails (an RPC hiccup, an empty fee account), the
receipt has no `proofTransaction`, the server logs the exact command, and the
store keeps the payment as pending. Publish it later without paying again:

```sh
npx beaver402-merchant pending-proofs            # list them
npx beaver402-merchant pending-proofs --publish  # publish them all
npx beaver402-merchant publish-proof --account C... --nonce <hex>
```

Publishing never moves money. The account refuses to publish the same proof
twice, so retrying is safe.

## What a refusal means

| Answer | Meaning |
| --- | --- |
| `402` with a new challenge | Not paid yet, or the payment does not answer this merchant's challenge for this request. `error` says which: another request, recipient, amount or merchant, an expired challenge, an unapproved merchant, a facilitator refusal |
| `409` | This payment was already used |
| `502` | The facilitator or the ledger could not be reached, or the ledger does not show the agreed transfer. The resource stays locked |
| `503` | The merchant is set up wrong. The log says why |

## Tests

```sh
npm test
```

The encoding is checked against `test-vectors/vectors.json`, the same file
the Rust contract's tests read.
