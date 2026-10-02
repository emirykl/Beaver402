# Incident response

What to do when something goes wrong with the pilot account. Every step that
changes the account needs the owner passkey, in the owner panel at `/panel`.

The order of the first three steps never changes: **halt, revoke, look.**
Halting is instant and undoes nothing, so when in doubt, halt.

## The controls

| Control | Panel button | What it does | Undo |
|---|---|---|---|
| Halt | HALT ALL PAYMENTS | refuses every payment | RESUME PAYMENTS |
| Revoke | REVOKE AGENT KEY | the agent can no longer sign anything | REINSTATE AGENT KEY |
| Remove merchant | (owner action `remove_merchant`) | that merchant can no longer be paid | approve it again |
| Lower limits | LOWER LIMITS | tighter limits from now on | none, limits never go back up |
| Recover funds | RECOVER FUNDS, pressed twice | the whole balance goes to the recovery address | fund the account again |

Recovery only works while payments are halted.

## Recording an incident

Every incident gets a file in `docs/operations/incidents/`, named by date,
with:

- when it was noticed, and how
- what was seen, with transaction links
- every action taken, with its transaction link and the time
- the decision at the end: resume, or replace the account
- what changes because of it

Evidence is preserved before anything else is cleaned up: run the event
collector (`POST /api/ops/collect` with the cron secret) and export the
events (`/api/ops/events?format=csv`) as soon as the account is halted, so
nothing ages out of the RPC window while the incident is investigated.

## Scenarios

### An unexpected payment

Noticed on the status page, in the panel's settlements, or in the event log:
a transfer out of the account nobody expected.

1. **Halt.** Nothing else can be paid while you look.
2. **Revoke the agent key**, unless the payment is already explained.
3. **Preserve evidence**: collect and export the events.
4. **Look.** Find the payment's proof of intent, which carries the challenge
   hash, and the merchant's settlement record. Did the approved merchant sign
   it? For which request? Through which facilitator?
5. **Decide.**
   - Explained, and the agent is sound: reinstate the agent key, resume.
   - The agent is compromised: keep it revoked. Rotate the agent secret in
     the agent deployment, then set the new key with the panel.
   - The merchant is compromised: remove it, and rotate its key.
   - The account itself is in doubt: recover the funds and replace the
     account (see [migration](migration.md)).

### Repeated attempts

Many refused payments in a short time: the panel's log, the merchant's
logs, or the account freezing itself at a limit.

1. **Halt** if the account has not frozen itself already.
2. **Find the source.** Refusals carry their reason, such as `NonceReused`,
   `ChallengeExpired` or `VelocityExceeded`. A run of the same one points at
   a loop in the agent or at someone replaying payments.
3. **Revoke the agent key** if the agent is the source.
4. **Lower the limits** if the attempts show they are looser than needed.
5. Resume once the source is fixed. Payments made before the freeze keep
   counting until they leave the 24 hour window.

### A compromised agent signer

The agent secret has leaked, or the agent backend is not trustworthy.

1. **Revoke the agent key.** Everything it signs is refused from now on.
2. **Halt** as well, so nothing settles while you rotate.
3. Generate a new agent key, put its secret in the agent deployment only,
   redeploy the agent backend.
4. **Set the new key** with REINSTATE AGENT KEY, which uses the key the agent
   backend is now configured with.
5. Resume.

### Backend or facilitator failure

Payments fail with the facilitator unreachable, refusing everything, or the
backend erroring.

1. Nothing has to be halted: a payment that does not settle moves no money.
   Halt anyway if the cause is unknown.
2. Check the facilitator: `GET` its `/supported` with the API key, and its
   status page. Check the RPC endpoint the same way.
3. Check the fee: the facilitator refuses payments over its fee ceiling. The
   status page shows how long until the account needs extending; an
   archived account is the most likely reason for a sudden jump in fees.
4. Once the dependency is back, run the scenarios on testnet before
   resuming mainnet payments.

### Archived contract state

The status page shows the account's lifetime running out, or payments start
failing because their fee jumped.

1. Call `extend_ttl` on the account. Anyone can, from any funded account:

   ```bash
   stellar contract invoke --id <account> --source <fee account> \
     --rpc-url <rpc> --network-passphrase "<passphrase>" -- extend_ttl
   ```

2. If it has already been archived, restore it first:

   ```bash
   stellar contract restore --id <account> --source <fee account> \
     --rpc-url <rpc> --network-passphrase "<passphrase>"
   ```

   then extend it. Nothing is lost by archival; restoring brings the state
   back exactly as it was.
3. Check the status page shows the full lifetime again before resuming.

## After every incident

Write the incident file, add anything learned to this procedure and to the
known limitations, and re-run the scenarios against testnet if code or
configuration changed.
