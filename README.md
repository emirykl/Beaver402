# Beaver402

An AI agent can pay for things on its own over Stellar x402. A payment can be
perfectly valid under the protocol and still not be the one the account owner
approved. A manipulated prompt, a misbehaving tool or a retry loop can change
the endpoint, the request body, the recipient or the amount, or produce many
individually valid payments in a short time.

Binding intent on the buyer side alone does not close this. Soroban cannot
read an HTTP request, so it cannot tell whether the buyer adapter described
honestly what the merchant asked for.

Beaver402 closes both gaps with a two party proof of intent. The merchant
signs a challenge describing the paid request and the settlement terms. The
buyer independently reconstructs the same fields from what was actually sent.
A Soroban smart account authorizes settlement only when both signatures and
every security critical field agree, and only within limits the owner sets.
Payments settle through a standard x402 v2 facilitator.

Neither the agent nor a compromised adapter can redefine an approved payment
on its own, while the owner keeps immediate control through a passkey.

**Status: running on Stellar testnet; a limited mainnet pilot is being
prepared.** On mainnet the account will hold at most 10 USDC, pay at most
1 USDC at a time and at most 5 payments or 5 USDC in any 24 hours.

[A seven minute recording](https://youtu.be/0vFrfGZc1x0) of the first month
shows an agent paying without holding a key, the owner halting it with a
passkey, the agent key revoked on chain, and the adversarial cases refused.

## Evidence

| | |
|---|---|
| [Testnet rehearsal](docs/operations/rehearsals/2026-10-02-testnet-hosted.md) | the whole pilot on a fresh account, settled by the hosted OpenZeppelin facilitator: x402 payments, one started from the MCP tool, every refusal with its reason, the incident drill and the migration |
| [x402 compatibility](docs/mainnet/x402-compat.md) | what a facilitator requires of the account, and the measurements |
| [First month](docs/evidence.md) | the original testnet deployment and its transactions |

## How a payment happens

1. The agent asks for a resource. The merchant answers `402` with standard
   x402 v2 payment requirements, and a challenge signed over this exact
   request and the settlement terms.
2. The agent rebuilds the same description from what it actually sent, not
   from what the merchant claims was sent. Disagreement stops here.
3. The agent signs one Soroban authorization entry for a USDC transfer **out
   of the policy account**, which is what puts the contract in the
   authorization chain, and simulates it. The contract rebuilds the
   challenge, verifies the merchant signature, checks the transfer is the
   agreed one, the nonce is new, the challenge is current and the limits
   hold. A refusal stops here, with the contract's own reason.
4. The payment goes back to the merchant. The merchant checks it answers its
   own challenge for this very request, has an x402 facilitator verify and
   settle it, and confirms on the ledger that exactly the agreed transfer
   happened.
5. The merchant publishes the payment's proof of intent from the account and
   returns the resource, with the settlement and the proof in its receipt.

The contract is given fields rather than hashes on purpose. Deriving the
hashes itself is what turns the merchant signature into a statement about a
specific recipient and amount rather than about an opaque digest.

## Two keys, two paths

The account answers to two parties and decides which one applies from what is
being authorized, never from which signature the caller offers.

| Path | Key | May do |
|---|---|---|
| Payment | agent ed25519, in the agent backend | spend, within the policy |
| Owner | passkey secp256r1, in device hardware, bound to the panel's domain | halt, resume, revoke or reinstate the agent, approve or remove the merchant, lower the limits, recover the funds |

An agent signature offered for an owner action is refused. An owner assertion
offered for a payment is refused. A batch mixing the two is refused, so an
approved payment cannot carry an unapproved administrative call alongside it.

The owner path ignores the frozen flag, because a frozen account still has to
accept the call that thaws it. Owner actions do not depend on the agent
signer existing, so revoking it cannot brick the account. Limits can only go
down, and the contract cannot be upgraded.

## Documentation

| | |
|---|---|
| [Canonical encoding](docs/canonical-encoding.md) | exactly what is signed, and how |
| [Threat model](docs/threat-model.md) | what is defended against, and what is not |
| [Known limitations](docs/known-limitations.md) | what the pilot does not do |
| [Operating guide](docs/operations/operating-guide.md) | how it is deployed and run |
| [Incident response](docs/operations/incident-response.md) | what to do when something goes wrong |
| [Replacing the account](docs/operations/migration.md) | the migration procedure |
| [Network configuration](docs/mainnet/network-config.md) | testnet and mainnet side by side |
| [Readiness checklist](docs/mainnet/readiness-checklist.md) | what has to be true before mainnet |
| [Findings](docs/security/findings.md) | every issue found, and its fix |

## Setup

### Prerequisites

- Node.js 24 or later
- Rust 1.96, pinned in `rust-toolchain.toml`, with the `wasm32v1-none` target
- Stellar CLI 27
- A Supabase project

### 1. Install

```bash
git clone https://github.com/emirykl/Beaver402.git
cd Beaver402

cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### 2. Configure Supabase

Run `scripts/supabase-migration.sql`, `scripts/supabase-migration-002.sql`
and `scripts/supabase-migration-003.sql`, in that order, in the Supabase SQL
editor. Then copy `backend/.env.example` to `backend/.env` and fill in the
Supabase values. Everything else is written for you in the next step.

### 3. Create the testnet keys

```bash
./scripts/setup-keys.sh
```

This generates and funds the deployer, agent and merchant accounts, and picks
free ports.

### 4. Register the owner passkey

```bash
cd backend && npm run dev      # one terminal
cd frontend && npm run dev     # another
```

Open the owner panel at `/panel` on the port the frontend prints, and
register a passkey. The contract stores the owner as a secp256r1 public key
and the hash of the panel's domain, so this has to exist before there is
anything to deploy.

### 5. Deploy

```bash
npm --prefix backend run preflight   # checks accounts, trustlines and services
./scripts/deploy.sh
```

Checks the configuration the way the backend will, reads the registered
passkey, deploys the contract and records its id in `backend/.env`. On
mainnet, `./scripts/deploy.sh --network mainnet` also refuses any artifact but
the reviewed one and asks for confirmation.

### 6. Approve and fund

Approve the merchant from the panel, which asks for the passkey, then send
USDC to the contract address within the limits.

## Using it

### As an agent tool

```bash
cd backend && npm run mcp
```

A stdio MCP server offering two tools: one that fetches a resource and pays
for it when the merchant asks, one that reports the policy state. It holds no
keys, so the model sees a price, a transaction hash and the content, and
never anything it could spend. On mainnet the agent backend requires
`AGENT_API_TOKEN`, which the MCP server sends.

### Directly

```bash
curl -X POST http://localhost:<port>/api/agent/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"http://localhost:<port>/api/data"}'
```

## Testing

```bash
cargo test                        # contract
cd backend && npm run test        # backend
cd frontend && npx tsc --noEmit   # panel and public pages
```

The Rust and TypeScript encoders are checked against the same fixture in
`test-vectors/vectors.json`, so neither can drift without the other noticing.
Regenerate it with `npm run vectors`. CI also checks that the contract has no
upgrade path, runs strict lint and every dependency audit, and builds the
release WASM with its hash.

### Against testnet

```bash
cd backend && npm run scenarios   # the adversarial cases, against a running backend
cd backend && npm run rehearse    # the whole pilot on a fresh account, written to docs/operations/rehearsals
```

## Layout

```
contracts/payment_policy/   the Soroban smart account
  src/lib.rs                the two authorization paths, owner actions, recovery
  src/crypto.rs             canonical encoding and hashing
  src/passkey.rs            WebAuthn assertion verification
  src/velocity.rs           the sliding window, replay protection, proofs
  src/lifetime.rs           keeping the account on the ledger
backend/
  src/config/               the network and the passkey domain, validated
  src/x402/                 the x402 v2 messages
  src/adapter/              buyer intent and the payment authorization
  src/agent/                the paid fetch, and the route that runs it
  src/merchant/             challenge signer, request binding, settlement check
  src/passkey/              WebAuthn, owner key extraction, assertion conversion
  src/policy/               policy state and owner actions
  src/ops/                  event collection, status, traffic counts
  src/mcp/                  the agent facing server
  scripts/                  vectors, scenarios, rehearsal, preflight, deploy parameters
frontend/                   the landing page, the status page and the owner panel
scripts/                    key setup, deploy, database migrations
test-vectors/               the fixture both languages read
docs/                       specification, threat model, operations, evidence
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/config` | the network and the account, public |
| GET | `/api/status` | the account's live state, public |
| POST | `/api/agent/fetch` | fetch a resource, paying if asked; needs the agent token on mainnet |
| GET | `/api/data` | demo merchant, answers 402 |
| POST | `/api/submit` | demo merchant, 402 on a request with a body |
| GET | `/api/merchant-info` | who the demo merchant is |
| GET | `/api/policy/state` | frozen flag, agent signer, limits, the window |
| POST | `/api/policy/prepare` | what the owner passkey has to sign |
| POST | `/api/policy/submit` | carry the assertion back and submit |
| POST | `/api/passkey/register/start` | begin passkey registration |
| POST | `/api/passkey/register/finish` | complete passkey registration, issue a session |
| POST | `/api/passkey/auth/start` | begin passkey sign in |
| POST | `/api/passkey/auth/finish` | complete passkey sign in, issue a session |
| GET | `/api/passkey/credentials/:userId` | whether a passkey is registered |
| GET, POST | `/api/ops/collect` | collect the account's events; needs the cron secret |
| GET | `/api/ops/events` | the collected events, JSON or CSV |
| POST | `/api/metrics` | count a page view or a link, cookieless |
| GET | `/api/metrics/report` | daily traffic totals |
| POST | `/api/mcp/extract` | read an HTTP request out of a tool call |
| GET | `/api/transactions` | payment history |
| GET | `/health` | health check |

Owner actions take two calls. The first works out the payload the account
will be asked about, the second carries the passkey assertion back. Both want
the session id in an `x-session-id` header, and that id is minted by the
backend when a passkey ceremony succeeds rather than chosen by the caller.
The session gates the interface; the authority itself is the passkey, and the
contract is what enforces that.

## Environment

Every variable is described in [`backend/.env.example`](backend/.env.example).
`BEAVER_NETWORK` picks testnet or mainnet and everything about the network
follows from it. On mainnet the backend refuses to start without the values
that have no safe default, and refuses any that disagree with the network.

A passkey is bound to the domain it was registered on, and so is the
account. Moving the panel to another domain means a new account.

## Scope

A limited pilot: one account, one merchant, the builder's own USDC, small
limits that can only be lowered, an immutable contract, a peer review rather
than a formal audit. No custody of anyone else's funds, no merchant registry,
no device recovery for the passkey. See the
[known limitations](docs/known-limitations.md). The encoding and the schema
here are a reference specification, not a standard.

## License

MIT
