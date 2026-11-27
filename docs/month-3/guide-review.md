# Setup guide review, from a newcomer's side

27 November 2026. Before the independent developer's session, the builder
followed the merchant kit guide (`merchant-v0.1.0-rc.2`) word for word from a
fresh clone, as someone who had never seen the project would, and noted
every place that needed knowledge the guide did not give. The guide was then
rewritten around a single setup command and the same path was run again in
an empty folder. This is the builder's own review; the independent
developer's observed setup is recorded separately and is what the scope
counts.

## What got in the way

| # | Where | Problem for a newcomer |
|---|---|---|
| 1 | Step 1 | The guide cloned the whole repository, 39 MB with the Rust contract and the Solana work, to run a 100 line Express server |
| 2 | Step 1 | Two installs and a build in two folders before anything ran |
| 3 | Step 2 | The secret key was printed on screen to be copied into `.env` by hand, then the public key copied a second time as the recipient. A wrong paste failed only later |
| 4 | Step 2 | `keygen` said to fund the account with XLM, but the next command did that, so it read as an extra manual step |
| 5 | Step 3 | Getting the facilitator key meant leaving the guide for another site and pasting a third value |
| 6 | Step 7 | "The account owner's agent calls your URL" did not say that a server on localhost cannot be called, how to expose it, or what to send the owner |
| 7 | Step 7 | It did not say what the developer would see when it worked, so there was no way to know it had |
| 8 | Throughout | Nothing said testnet is free, which matters to someone deciding whether to try |

## What changed

| # | Change | Fixes |
|---|---|---|
| 1 | New `beaver402-merchant init`: in an empty folder it makes the key, opens the testnet account with friendbot, adds the USDC trustline, offers to fetch a free testnet facilitator key, writes `.env` (private, git ignored) and a `server.ts` with a paid GET and POST, and sets the `start` script | 1, 2, 3, 4, 5 |
| 2 | `init` never overwrites anything and saves the new key before going to the network, so it can be run again after an interruption | 3 |
| 3 | The quick start installs the kit from its release instead of cloning the repository; the clone moved to a short section for people changing the kit itself | 1, 2 |
| 4 | New section, "Take your first payment": expose the server with a free tunnel, set `PUBLIC_URL`, send the owner the merchant key and URL (never the secret), and what appears on the explorer when it works | 6, 7 |
| 5 | The refusal before approval is described as the protection working, with its exact message | 6 |
| 6 | The guide opens with "everything on testnet is free" and the Node version to check | 8 |
| 7 | `npm start` prints each check and ends with the merchant key the owner needs | 7 |

## Before and after

| | Before (`rc.2`) | After (`rc.3`) |
|---|---|---|
| Commands to a running testnet merchant | 9, plus three values pasted into `.env` by hand | 5, nothing edited by hand |
| Download | 39 MB repository | the kit and its dependencies |
| Time, measured on the builder's machine with a warm npm cache | not comparable: the old path needs a second site for the key | 17 seconds from an empty folder to every check passing |
| Knowing it worked | not described | `402` at `/forecast`, then the payment and its Proof of Intent on the explorer |

The new path was run end to end on testnet in an empty folder: `init` opened
the account ([trustline](https://stellar.expert/explorer/testnet/tx/e370a08816a6f3940620a4e7e058c421ebeac68517e3117c2f8a71d0b2fb830f)),
`check` passed every line, and `npm start` answered `/forecast` with `402`
and a signed challenge. The facilitator key was supplied beforehand for
this run, so no new key was generated.

## Left for the independent developer's session

- Whether the tunnel step is clear to someone who has not used one
- Whether the owner hand-off (key and URL) feels natural, or needs a form
- Time on a machine without a warm npm cache
