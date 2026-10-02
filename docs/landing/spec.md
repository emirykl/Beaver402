# Landing page

The public face of the pilot. It has to make three things clear to someone
who has never heard of Beaver402, in this order: what can go wrong when an
agent pays on its own, what Beaver402 does about it, and where to check that
it really does.

## Routes

One origin serves everything, because the owner passkey belongs to it.

| Path | What | Who |
|---|---|---|
| `/` | the landing page | anyone |
| `/status` | live state of the pilot account, read only | anyone |
| `/panel` | the owner console, behind the passkey | the owner |

## Information architecture

| # | Section | Says | Links to |
|---|---|---|---|
| 1 | Hero | Your agent can only pay for what you approved. A Stellar smart account that settles an x402 payment only when the merchant and the buyer describe the same one. | live status, demo video, repository |
| 2 | The risk | With delegated x402 payments, a payment that is valid by the protocol is not necessarily the one the owner approved. A manipulated prompt, a rewritten request or a retry loop can all produce valid payments. | |
| 3 | How it works | Four steps: the merchant signs a challenge over the exact request; the agent rebuilds the request on its own; the smart account authorizes the transfer only if both agree, within its limits; an x402 facilitator settles and the proof of intent is published. | canonical encoding, threat model |
| 4 | Built on Stellar and x402 | Standard x402 v2 `exact` scheme, fee sponsored by the facilitator, USDC through its Stellar Asset Contract, the policy as a custom account contract checked in `__check_auth`. | x402 compatibility record |
| 5 | Pilot limits | 1 USDC per payment, at most 5 payments and 5 USDC in any 24 hours, at most 10 USDC held. Limits can only go down. The contract cannot be upgraded. | deployment record |
| 6 | Owner controls | A passkey on the owner's device: halt and resume payments, revoke and reinstate the agent key, approve and remove the merchant, lower the limits, send the balance to the recovery address. | owner panel |
| 7 | Evidence | The mainnet contract, the transactions, the deployment record, the evidence index, the demonstration, the repository. | each one |
| 8 | Known limitations | What the pilot does not defend against and does not do, in plain words. | known limitations |

## Content hierarchy

One sentence per idea at the top of each section, a short paragraph under
it, and nothing a reviewer has to scroll past to reach the evidence. The
evidence section is reachable from the hero in one click.

## Layout

- Single column, maximum width about 72 characters of body text.
- Sections stack on every width; the four steps sit in a row on wide
  screens and stack below 720 pixels.
- Touch targets at least 44 pixels high.
- Works from 360 pixels wide up. Checked at 390 (phone) and 1440 (desktop).

## Visual direction

The same instrument-panel language as the owner console: near black ground,
amber for actions and emphasis, green for working, red for refusals and
halts, monospaced type. Quiet: the glitch effects of the console stay in the
console. Contrast meets WCAG AA for body text.

## What it never shows

No request content, no signatures, no keys, no session data, nothing about
who is visiting. The status page shows only what anyone can read from the
ledger.

## Traffic

Counted without cookies and without storing who visited: the page view and
which outbound link was followed, added up per day. That is the traffic
report the customer development plan asks for.
