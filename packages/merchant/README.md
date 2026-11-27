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

- [Try it in your browser](#try-it-in-your-browser-nothing-to-install) (this page)
- [Quick start on your machine](#quick-start-five-minutes-on-testnet)
- [Configuration reference](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Changelog](CHANGELOG.md)

## Try it in your browser: nothing to install

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/emirykl/Beaver402?devcontainer_path=.devcontainer%2Fmerchant%2Fdevcontainer.json&quickstart=1)

Click the button and choose **Create codespace**. GitHub opens a ready
workspace in your browser and sets everything up on its own: your merchant
key, a free testnet account with its USDC trustline, a free facilitator key,
and a server with two paid routes, reachable from the internet. It needs
only a GitHub account; personal accounts include free Codespaces hours, and
this uses a few minutes of them. Plan on about ten minutes the first time:
GitHub builds the workspace and installs the kit before the setup runs. The
first time you use Codespaces, GitHub may also ask you to authorize it; that
screen is GitHub's own and not part of these ten minutes.

What happens, in order:

1. **Setup.** The terminal prints one `ok` line per check, then a box with
   your **key** and your **address**.
2. **Port.** If the terminal asks, open the PORTS tab, right click port
   4021 and choose Port Visibility > Public. Codespaces keeps ports private
   until you do.
3. **Your API is for sale.** `<address>/forecast` now answers
   `402 Payment Required`. That is success, not an error.
4. **Send the key and the address to the account owner.** Never send
   `MERCHANT_SECRET` from `.env`.
5. **The owner approves your key with their passkey.** Until they do, their
   agent's payments to you are refused. No payment can complete before
   this step, so wait for the owner to confirm it.
6. **The owner's agent pays.** The paid request appears in your terminal.
   Keep the tab open until then.

Delete the codespace afterwards from <https://github.com/codespaces> if you
like. Stuck? See [Codespaces](docs/troubleshooting.md#codespaces) in
troubleshooting.

## Quick start: five minutes on testnet

You need Node.js 20.12 or later (`node -v`). Everything on testnet is free:
the network gives out test XLM and nothing here costs real money.

```sh
mkdir my-paid-api && cd my-paid-api
npm init -y
npm install https://github.com/emirykl/Beaver402/releases/download/merchant-v0.1.0/beaver402-merchant-0.1.0.tgz express tsx
npx beaver402-merchant init
npm start
```

`init` does all of the setup and asks you one question:

1. makes your merchant key and saves it in `.env` (keep that file private;
   it is added to `.gitignore` for you)
2. opens your testnet account with free test XLM and adds the USDC trustline
   it needs to receive payments
3. asks whether to get a free testnet key from OpenZeppelin Channels, the
   service that settles each payment and pays its network fee. Say yes, or
   say no and put your own key in `.env` as `FACILITATOR_API_KEY`
4. writes `server.ts`: a paid `GET /forecast` (0.1 USDC) and a paid
   `POST /summarize` (0.2 USDC)

It never overwrites anything, so you can run it again if it stops halfway.

`npm start` checks the setup against the network and prints one line per
check. When every line says `ok`, open <http://localhost:4021/forecast>: you
get `402 Payment Required` with a signed challenge. Your API is now for sale.
The last line printed is your **merchant key**; you need it in the next step.

## Take your first payment

A Beaver402 account pays a merchant only after its owner approves that
merchant with their passkey. So the first payment takes three short steps
between you and the account owner. You do not need an agent or USDC of your
own.

1. **Make your server reachable.** The owner's agent has to call it over
   https. A free tunnel works without an account:

   ```sh
   brew install cloudflared      # or see developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads
   cloudflared tunnel --url http://localhost:4021
   ```

   It prints an address like `https://something.trycloudflare.com`. Put it
   in `.env` as `PUBLIC_URL`, then restart `npm start`. The challenge signs
   the full URL, so it has to be the address the agent calls.

2. **Send the account owner two things:** your merchant key (`G...`, also at
   `/merchant`) and your public URL. Never send `MERCHANT_SECRET`.

3. **The owner approves you and pays.** They press APPROVE next to your key
   in their panel and run a payment against your URL. Each paid request
   appears in your terminal, and the payment and its Proof of Intent
   appear on <https://stellar.expert/explorer/testnet> under your merchant
   key.

Before approval, the owner's payments to you are refused with
`the paying account's owner has not approved this merchant`. That refusal is
the protection working, not an error. Approving you does not raise the
owner's limits: every merchant shares the same per payment and daily caps.

## Add it to your own Express app

```ts
import express from "express";
import { captureRawBody, createMerchant, fileStore, optionsFromEnv, usdc } from "@beaver402/merchant";

const merchant = createMerchant(optionsFromEnv(process.env, fileStore("./data/payments.jsonl")));

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

`protect()` goes in front of any route you want paid for, with an optional
price per route. Every option is checked when `createMerchant` runs, and the
network side (RPC, recipient trustline, facilitator, signer balance) before
the first challenge goes out. A merchant that is set up wrong answers `503`
and logs why: it never hands out a challenge that cannot be paid. Pass the
options as an object instead of `optionsFromEnv` if you prefer; see the
[configuration reference](docs/configuration.md).

## Run the example from this repository

To read or change the kit itself:

```sh
git clone https://github.com/emirykl/Beaver402.git
cd Beaver402/packages/merchant && npm install && npm run build
cd example && npm install && npx beaver402-merchant init && npm start
```

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
