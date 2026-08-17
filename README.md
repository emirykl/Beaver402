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
every security critical field agree.

Neither the agent nor a compromised adapter can redefine an approved payment
on its own, while the owner keeps immediate control through a passkey.

**Stellar testnet only. Testnet USDC, no real value.**

## Deployment

| | |
|---|---|
| Contract | [`CBPE37HQ6CHIKB7F3OFU2BIDAQOLB3QZD2DAO5Y6F6DKUSHLW2JZTX2S`](https://stellar.expert/explorer/testnet/contract/CBPE37HQ6CHIKB7F3OFU2BIDAQOLB3QZD2DAO5Y6F6DKUSHLW2JZTX2S) |
| Network | Stellar testnet |
| Owner | a WebAuthn passkey, secp256r1 |
| Asset | testnet USDC |

Evidence on chain:

| What | Transaction |
|---|---|
| A payment both parties agreed on | [`19d9c4e4`](https://stellar.expert/explorer/testnet/tx/19d9c4e4f519e4ab9971c394a6338d9a82b83287f3e90d648ef3e15c49a1219a) |
| An owner action authorized by passkey | [`61e6485c`](https://stellar.expert/explorer/testnet/tx/61e6485c8ef7df96b92ada8c79687acc69d8ea1b5d307d952d9b9efcab259b48) |
| The account funded | [`ff0d3fa8`](https://stellar.expert/explorer/testnet/tx/ff0d3fa8de4076b6ea584109c530a3f6a1376847d9a52ac3ebf1f119fc8ec956) |

## How a payment happens

1. The agent asks for a resource. The merchant answers `402` with a signed
   challenge covering the request and the settlement terms.
2. The adapter rebuilds the same description from what was actually sent,
   not from what the merchant claims was sent. Disagreement stops here.
3. The transfer is built to move funds **out of the policy account**, which
   is what puts the contract in the authorization chain.
4. The contract rebuilds the challenge hash from the fields it was given,
   verifies the merchant signature against it, and checks that the transfer
   it is being asked to authorize has the recipient, asset and amount that
   were agreed. It also checks the nonce, the expiry and the velocity budget.
5. Only then does the payment settle, and the request is repeated.

The contract is given fields rather than hashes on purpose. Deriving the
hashes itself is what turns the merchant signature into a statement about a
specific recipient and amount rather than about an opaque digest.

## Two keys, two paths

The account answers to two parties and decides which one applies from what is
being authorized, never from which signature the caller offers.

| Path | Key | May do |
|---|---|---|
| Payment | agent ed25519, in the backend | spend, within the policy |
| Owner | passkey secp256r1, in device hardware | freeze, restore, revoke or reinstate the agent, allowlist |

An agent signature offered for an owner action is refused. An owner assertion
offered for a payment is refused. A batch mixing the two is refused, so an
approved payment cannot carry an unapproved administrative call alongside it.

The owner path ignores the frozen flag, because a frozen account still has to
accept the call that thaws it. Owner actions do not depend on the agent
signer existing, so revoking it cannot brick the account.

## Documentation

| | |
|---|---|
| [Evidence](docs/evidence.md) | what the deployed contract did, with transactions |
| [Canonical encoding](docs/canonical-encoding.md) | how a challenge and an intent become bytes, and the domain rules |
| [Threat model](docs/threat-model.md) | what is defended against, and what is not |

## Setup

### Prerequisites

- Node.js 22 or later
- Rust toolchain with the `wasm32v1-none` target
- Stellar CLI 27 or later
- A Supabase project

### 1. Install

```bash
git clone https://github.com/emirykl/Beaver402.git
cd Beaver402

cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### 2. Configure Supabase

Run `scripts/supabase-migration.sql` in the Supabase SQL editor, then copy
`backend/.env.example` to `backend/.env` and fill in the three Supabase
values. Everything else is written for you in the next step.

### 3. Create the testnet keys

```bash
./scripts/setup-keys.sh
```

This generates and funds the deployer, agent and merchant accounts, and picks
free ports. It touches no contract, which it cannot: registering the owner
passkey needs a running backend, and the backend needs a merchant key to
start.

### 4. Register the owner passkey

```bash
cd backend && npm run dev      # one terminal
cd frontend && npm run dev     # another
```

Open the control panel at the port the frontend prints, and register a
passkey. The contract stores the owner as a secp256r1 public key, so this has
to exist before there is anything to deploy.

### 5. Deploy

```bash
./scripts/deploy.sh
```

Reads the registered passkey, deploys the contract with it as the owner, and
records the contract id in `backend/.env`.

### 6. Fund and allowlist

Send testnet USDC to the contract address, then allowlist the demo merchant
from the control panel. Allowlisting is an owner action, so it asks for the
passkey.

## Using it

### As an agent tool

```bash
cd backend && npm run mcp
```

A stdio MCP server offering two tools: one that fetches a resource and pays
for it when the merchant asks, one that reports the policy state. It holds no
keys, so the model sees a price, a transaction hash and the content, and
never anything it could spend.

### Directly

```bash
curl -X POST http://localhost:<port>/api/agent/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"http://localhost:<port>/api/data"}'
```

## Testing

```bash
cargo test                        # contract, 35 tests
cd backend && npm run test        # backend, 116 tests
cd frontend && npx tsc --noEmit   # control panel
```

The Rust and TypeScript encoders are checked against the same fixture in
`test-vectors/vectors.json`, so neither can drift without the other noticing.
Regenerate it with `npm run vectors`.

### Against the deployed contract

```bash
cd backend && npm run scenarios
```

Runs the adversarial cases against testnet and names the error the contract
raised, rather than reporting only that something was refused.

| Scenario | Result |
|---|---|
| A payment both parties agree on | allowed |
| The endpoint changed after signing | refused, field mismatch |
| The method changed after signing | refused, field mismatch |
| A body was added after signing | refused, field mismatch |
| A merchant nobody approved | refused, `UnauthorizedMerchant` |
| A challenge that already expired | refused |
| A payment while the account is frozen | refused, `AccountFrozen` |
| Ten payments in one window | account froze itself |

Settlement level tampering, where the transfer differs from what was signed,
is covered by the contract tests rather than here, because the real client
cannot construct that disagreement.

## Layout

```
contracts/payment_policy/   the Soroban smart account
  src/lib.rs                the two authorization paths
  src/crypto.rs             canonical encoding and hashing
  src/passkey.rs            WebAuthn assertion verification
  src/velocity.rs           the circuit breaker
backend/
  src/agent/                the paid fetch, and the route that runs it
  src/adapter/              buyer intent, payment submission, signature encoding
  src/merchant/             challenge signer and the demo 402 endpoint
  src/passkey/              WebAuthn, owner key extraction, assertion conversion
  src/policy/               policy state and owner actions
  src/mcp/                  the agent facing server
  scripts/                  vectors, owner key, adversarial scenarios
frontend/                   the control panel
scripts/                    key setup, deploy, database migration
test-vectors/               the fixture both languages read
docs/                       encoding specification and threat model
```

## API

| Method | Path | Description |
|---|---|---|
| POST | `/api/agent/fetch` | fetch a resource, paying if asked |
| GET | `/api/data` | demo merchant, answers 402 |
| POST | `/api/submit` | demo merchant, 402 on a request with a body |
| GET | `/api/merchant-info` | who the demo merchant is |
| GET | `/api/policy/state` | frozen flag, agent signer, velocity |
| POST | `/api/policy/prepare` | what the owner passkey has to sign |
| POST | `/api/policy/submit` | carry the assertion back and submit |
| POST | `/api/passkey/register/start` | begin passkey registration |
| POST | `/api/passkey/register/finish` | complete passkey registration |
| POST | `/api/passkey/auth/start` | begin passkey sign in |
| POST | `/api/passkey/auth/finish` | complete passkey sign in |
| GET | `/api/passkey/credentials/:userId` | whether a passkey is registered |
| POST | `/api/auth/session` | mark a session authenticated |
| POST | `/api/mcp/extract` | read an HTTP request out of a tool call |
| GET | `/api/transactions` | payment history |
| GET | `/health` | health check |

Owner actions take two calls. The first works out the payload the account
will be asked about, the second carries the passkey assertion back. The
session check gates the interface; the authority itself is the passkey, and
the contract is what enforces that.

## Environment

| Variable | Description |
|---|---|
| `SOROBAN_RPC_URL` | Soroban RPC endpoint |
| `NETWORK_PASSPHRASE` | Stellar network passphrase |
| `POLICY_CONTRACT_ID` | the deployed policy account |
| `FEE_SOURCE_SECRET` | pays for owner actions, approves nothing |
| `AGENT_SECRET` | the delegated signer |
| `MERCHANT_SECRET` | signs the demo merchant's challenges |
| `RECIPIENT_ADDRESS` | where a demo payment lands |
| `USDC_ISSUER` | the token contract payments settle through |
| `RP_ID` | WebAuthn relying party, the domain |
| `ORIGIN` | the control panel origin, has to match where it is served |
| `SUPABASE_URL` | project URL |
| `SUPABASE_ANON_KEY` | anonymous key |
| `SUPABASE_SERVICE_KEY` | service role key |
| `PORT` | backend port |
| `FRONTEND_PORT` | control panel port |

A passkey is bound to the origin it was registered on. Moving the control
panel to another domain means registering a new passkey and setting a new
owner on the contract.

## Storage

| Table | Purpose |
|---|---|
| `credentials` | passkey public keys |
| `sessions` | authenticated sessions, 24 hour expiry |
| `transactions` | payment log with hashes, amount, status |

Row level security keeps credentials and sessions to the service role. The
transaction log is readable by the control panel.

## Continuous integration

Three jobs on every push and pull request: contract tests with the release
WASM build, backend type check and test suite, control panel type check and
build.

## Scope

Testnet only. No mainnet, no custody, no third party audit, no production key
management, no merchant registry beyond the one reference signer. Velocity
rules are deterministic; there is no behavioural profiling or risk scoring.
The encoding and the schema here are a reference specification, not a
standard.

## License

MIT
