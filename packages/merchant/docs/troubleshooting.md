# Troubleshooting

Start with `npx beaver402-merchant check` in the folder holding `.env`.
Each `FAIL` line names the problem.

## `init` stopped halfway

Run it again. It keeps the key it already saved and fills in only what is
missing. If friendbot was down, it tries the funding again.

## `npm start` says `Cannot use import statement outside a module`

`package.json` needs `"type": "module"`. `init` sets it; if you made the
package by hand, run `npm pkg set type=module`.

## The owner's payment is refused with `the payment was authorized for a different request`

The URL the agent called is not the URL your server signed. Behind a tunnel
or proxy, `PUBLIC_URL` in `.env` must be exactly the https origin the agent
uses (for example `https://something.trycloudflare.com`, no path), and the
server has to be restarted after you change it. A quick tunnel gets a new
address every time it starts.

## The merchant answers 503

The setup is broken, and the server log says how. Usual causes:

- **`... has no USDC trustline`**: the recipient cannot receive USDC. On
  testnet run `npx beaver402-merchant setup-testnet`. On mainnet add a trustline for
  `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` in your wallet.
- **`... does not exist`**: the account was never funded. Friendbot on
  testnet, a real XLM deposit on mainnet.
- **`facilitator ... 401`**: the API key is wrong, or it belongs to the
  other network. Testnet and mainnet keys are separate.
- **`the request has a body but its raw bytes were not kept`**: mount
  `express.json({ verify: captureRawBody })` before `protect()`. For a body
  that is not JSON, use `express.text` or `express.raw` with the same
  `verify`.

## A payment is refused with 402

The `error` field says why.

| error | Cause | Fix |
| --- | --- | --- |
| `the paying account's owner has not approved this merchant` | The owner has not approved your key | Send the owner `merchantPubkey` from `GET /merchant`. They approve it with their passkey |
| `the payment was authorized for a different request` | The agent paid for another URL, query or body than the one it sent | On your side usually a proxy: set `PUBLIC_URL` to the origin agents call |
| `the payment goes to another recipient` / `another amount` | The payment was built for other terms | Ask for a fresh 402 and pay that |
| `the challenge this payment answers has expired` | The payment came after `challengeSeconds` | Ask for a fresh 402 |
| `the payment does not come from a Beaver402 policy account` | The payer is a plain wallet or another kind of contract | Beaver402 merchants take payments from policy accounts only |
| `the facilitator refused the payment: ...` | The policy account's own checks failed in the facilitator's simulation: a limit reached, the account halted, an approval missing | The reason is in the text. Limits are the owner's to change |
| `the payment does not match what this resource costs` | The requirements in the payment were changed | Pay the requirements as given |

## 409: this payment has already been used

The payment already unlocked one response. Ask for a new 402 and pay again.
The store remembers payments by transaction and by nonce.

## 502: the settlement could not be confirmed

The facilitator reported a settlement that the ledger does not show as one
transfer of the agreed USDC to your recipient. Nothing is served. Open the
`transaction` in the response on the explorer: if it failed, nothing moved;
if it moved something else, treat it as an incident.

## The receipt has no proofTransaction

The payment settled and was served, but publishing the Proof of Intent
failed. The log line gives the exact command. Usually the signing account
has run out of XLM, or the RPC failed. Fund it, then
`npx beaver402-merchant pending-proofs --publish`.

## `fileStore ... is held by process N`

Another process has the same store file open. One process per file. Run
several instances with `postgresStore()`.

## `XDR Read Error: unknown ... member`

The network moved to a protocol the installed `@stellar/stellar-sdk` cannot
read. Update this package or the SDK.
