# Three customer conversations, November 2026

Three online conversations over Google Meet with people who build or run
systems that would pay for, or sell, APIs to agents. Each was shown the
merchant guide, the owner panel and the account's limits. Names are left out;
each participant is described by role only. Answers are summarized in
English, not quoted.

| | Role | Date | Channel |
|---|---|---|---|
| A | IT specialist, fintech company | 13 November 2026 | Google Meet |
| B | Team lead, SaaS company | 15 November 2026 | Google Meet |
| C | Developer, API company | 17 November 2026 | Google Meet |

## A: IT specialist, fintech company

**What they said.** The merchant-signed request, the per payment limit and
the passkey controls answer their main worry, that an agent could pay for a
request it did not mean to make. Halting payments, revoking the agent key and
removing a merchant were clear in the panel.

**Concerns and requests.** Before production use at their company: a passkey
recovery plan, an independent security audit, and a way to send incident
records to the company's monitoring system.

**Decision.** A limited value security trial; no production approval yet.

## B: Team lead, SaaS company

**What they said.** Stopping wrong or repeated agent payments is valuable.
Five payments per 24 hours suits a pilot but is too few for the team's usual
workload.

**Concerns and requests.** Separate budgets per agent and per merchant, usage
reports and team permissions. Limits that can only be lowered, and a new
account for any policy change, add operational work.

**Decision.** A pilot on one workflow; a wider rollout once team controls and
more flexible policies exist.

## C: Developer, API company

**What they said.** The Express merchant guide is concrete: the `init`
command, the paid example routes and the troubleshooting notes show how to
reach the first 402.

**Concerns and requests.** A first completed payment still needs a
facilitator key, an HTTPS tunnel, an exact `PUBLIC_URL` and the owner's
approval. Keeping the raw body on POST routes is easy to miss. They asked for
an automated end to end testnet payment example and examples for other server
frameworks.

**Decision.** Try the Express integration on testnet before estimating a
production integration.

## Across the three

| Theme | A | B | C |
|---|---|---|---|
| The core protection (exact request, limits, owner halt) is convincing | yes | yes | yes |
| First completed payment has too many steps | | | yes |
| Passkey recovery plan needed | yes | | |
| Independent security audit needed | yes | | |
| Team level controls: budgets per agent or merchant, roles, reports | | yes | |
| Policy changes need a new account | | yes | |

Shared priority: make the first completed payment easier first, then team
level controls and passkey recovery. The
[independent developer](developer-feedback.md) named the same two barriers
afterwards: the steps around the first payment, and an audit and a recovery
plan before real use.

## What has changed since

| Request | Status |
|---|---|
| Fewer steps to a first payment (C) | Addressed for testnet. `beaver402-merchant init` gets the facilitator key itself (`merchant-v0.1.0-rc.3`); the Codespaces route needs no tunnel and sets `PUBLIC_URL` itself (`rc.4`); the guide lists the owner's approval as its own step (`0.1.0`) |
| Raw body on POST routes (C) | The generated `server.ts` and the guide's Express snippet keep it with `captureRawBody`; troubleshooting covers the refusal when it is missing |
| End to end example (C) | `npm run kit:e2e` runs a GET and a POST payment against the example on testnet; not yet one command for a newcomer without an agent |
| Other frameworks (C) | Not done; Express only |
| Passkey recovery plan (A) | Not done; the account's recovery path moves funds to a fixed address but does not replace a lost owner passkey |
| Independent audit (A) | Not done |
| Incident records to monitoring (A) | Partly: the collector sends email alerts; no export to other systems |
| Team budgets, roles, reports, flexible policy (B) | Not done; out of scope this month |
