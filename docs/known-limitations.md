# Known limitations

What the pilot does not do, and what it does not defend against. Written so
that nobody has to infer it from what is missing elsewhere.

## By design, for this pilot

- **One merchant.** The account can approve several, but the pilot runs with
  one reference merchant. There is no merchant registry or onboarding. Every
  approved merchant also adds to what each payment reads and writes, so a
  long list would push the payment's fee past what a facilitator accepts.
- **Small amounts.** At most 1 USDC per payment, 5 payments and 5 USDC in any
  24 hours, and no more than 10 USDC funded. These are the limits on chain;
  they can only be lowered.
- **Builder funds only.** The account holds the builder's own USDC. Beaver402
  does not hold, receive or move anyone else's money.
- **No upgrades.** The contract cannot be changed. Fixing anything in it
  means a new account through the [migration procedure](operations/migration.md).
- **Peer review, not an audit.** The release was reviewed by an engineer who
  did not write it. It has not had a formal third party audit.

## What the owner has to know

- **The passkey is the owner.** Losing the device that holds it means losing
  control of the account. There is no recovery path for the passkey in this
  pilot. Funds are not lost with it only if they were recovered beforehand.
- **The passkey belongs to one domain.** It only works on the domain the
  panel was served from when it was registered. Moving the panel to another
  domain means a new account.
- **Recovery goes to one address.** `recover_funds` sends everything to the
  recovery address fixed at deployment, and only while payments are halted.

## What the system does not defend against

- **A compromised agent backend** can spend up to the limits with the
  approved merchant until the owner halts payments or revokes the agent key.
- **A stolen merchant key** can sign challenges at the merchant's price.
- **Unfair prices.** Nothing judges a price; the per payment limit bounds it.
- **Denial of service.** Using up the window freezes the account, which stops
  legitimate payments too. A facilitator outage also stops payments.
- **A balance above 10 USDC** cannot be prevented by the contract, since
  anyone can send it tokens. The ceiling is kept by funding it with less.

## Operational limits

- **The token balance entry** lives in the USDC contract, which the account
  cannot extend. Mainnet gives it at least 120 days, longer than the pilot.
- **Event history** is only as complete as the collector made it. RPC keeps
  events for a limited window; a collector that stops for longer than that
  leaves a gap, which the status page reports.
- **The proof of intent** is published in a transaction after the
  settlement, not inside it, because an x402 facilitator refuses settlements
  that emit anything but the transfer. The two are tied by the nonce and the
  challenge hash. A payment's proof can be published until its slot in the
  account is reused, at the earliest 24 hours later.
- **The fee ceiling.** The hosted facilitator only settles payments whose
  network fee is under its ceiling. The payment path was measured at 38,411
  stroops against 50,000; anything that pushed it over, such as an archived
  account, would stop payments until fixed.
- **Hosting.** The backend runs as serverless functions. Scheduled event
  collection is limited by the hosting plan; it can always be started by
  hand.
