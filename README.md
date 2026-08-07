# Beaver402

Beaver402 is a payment security layer for the Stellar network that implements the HTTP 402 Payment Required protocol with two-party Proof of Intent (PoI) verification. It provides a Soroban smart contract for on-chain policy enforcement, a TypeScript backend for challenge/intent orchestration, and a React control panel for passkey-based account management.

## Architecture

The system consists of three components:

- **Soroban Smart Contract** (Rust) enforces payment policies on-chain, including merchant allowlisting, velocity limits, nonce replay protection, and account freeze/restore controls.
- **Backend** (TypeScript/Express) handles the x402 payment flow: merchant challenge signing, buyer intent generation, challenge-intent field matching, and payment submission through Soroban. It also provides passkey (WebAuthn) authentication and policy management endpoints.
- **Frontend** (React) is a control panel where the account owner authenticates via passkey and manages payment policies (freeze, restore, revoke agent signer) with a live transaction history.

## How It Works

1. A merchant issues an HTTP 402 response containing a signed payment challenge with fields such as recipient, amount, asset, endpoint, and expiry.
2. The agent (acting on behalf of the buyer) independently constructs a Proof of Intent from the observed HTTP request.
3. The backend verifies that the challenge and intent share identical field hashes using domain-separated canonical encoding. If the hashes match, it confirms both parties agree on the same payment terms.
4. The payment is submitted to the Soroban policy contract, which performs on-chain checks: merchant allowlist membership, nonce uniqueness, velocity limits, and freeze status.
5. If all checks pass, the USDC transfer executes on the Stellar testnet.

## Project Structure

```
beaver402/
  contracts/payment_policy/    Soroban smart contract (Rust)
  backend/                     Express API server (TypeScript)
    src/adapter/               x402 payment client, buyer intent
    src/merchant/              Challenge signer, demo 402 endpoint
    src/passkey/               WebAuthn registration and authentication
    src/policy/                Policy state and management routes
    src/mcp/                   MCP tool call handler
    src/shared/                Types, hashing, canonical encoding
    src/lib/                   Supabase client
  frontend/                    React control panel
  scripts/                     Deployment and migration scripts
  test-vectors/                Cross-language test vector data
```

## Prerequisites

- Node.js 22 or later
- Rust toolchain with `wasm32-unknown-unknown` target
- Stellar CLI (`stellar`)
- A Supabase project (for persistent storage)

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/anthropics/beaver402.git
cd beaver402

cd backend && npm install && cd ..
cd frontend && npm install && cd ..
```

### 2. Deploy the smart contract

The deployment script builds the WASM binary, generates testnet accounts (owner, agent, merchant), deploys the contract, initializes it with velocity limits, and writes the resulting configuration to `backend/.env`.

```bash
bash scripts/deploy.sh
```

### 3. Configure Supabase

Create a Supabase project and run the migration to set up the required tables:

```bash
# Copy the SQL from scripts/supabase-migration.sql
# and execute it in the Supabase SQL Editor
```

Then add the following keys to `backend/.env`:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key
```

### 4. Start the servers

```bash
# Terminal 1: Backend
cd backend && npm run dev

# Terminal 2: Frontend
cd frontend && npm run dev
```

The frontend runs at `http://localhost:5403` and proxies API requests to the backend on port 5402. Both can be moved with `FRONTEND_PORT` and `BACKEND_PORT` if something else already holds them.

## Smart Contract

The `payment_policy` contract is a Soroban smart account policy with the following capabilities:

- **Merchant allowlist**: Only pre-approved merchants can initiate payment challenges.
- **Two-party verification**: Both the merchant signature and the agent-constructed intent must produce matching field hashes before a payment proceeds.
- **Nonce replay protection**: Each payment challenge carries a unique nonce; reused nonces are rejected.
- **Velocity limits**: Configurable per-window transaction count and total amount limits. When exceeded, the account freezes automatically.
- **Freeze and restore**: The account owner can freeze all outgoing payments at any time via passkey authentication, and restore them when ready.
- **Agent signer revocation**: The owner can permanently revoke the agent's signing authority through the control panel.

## Data Storage

Persistent data is stored in Supabase across three tables:

| Table | Purpose |
|---|---|
| credentials | Passkey (WebAuthn) credential storage |
| sessions | Authenticated session tracking with 24-hour expiry |
| transactions | Payment audit log with hash, amount, status, and error details |

Row Level Security policies restrict credentials and sessions to service role access only. The transactions table allows public read access for the frontend.

## Testing

```bash
# Contract tests
cargo test --verbose

# Backend tests (60 tests)
cd backend && npm run test

# Frontend type check
cd frontend && npx tsc --noEmit
```

## CI/CD

GitHub Actions runs three jobs on every push and pull request to main:

1. **Contract Tests**: Builds and tests the Soroban contract, produces a WASM binary.
2. **Backend Tests**: Type-checks and runs the full Vitest suite.
3. **Frontend Build**: Type-checks and builds the production bundle.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| POST | /api/passkey/register/start | Begin passkey registration |
| POST | /api/passkey/register/finish | Complete passkey registration |
| POST | /api/passkey/auth/start | Begin passkey authentication |
| POST | /api/passkey/auth/finish | Complete passkey authentication |
| GET | /api/passkey/credentials/:userId | Check if credentials exist |
| POST | /api/auth/session | Mark a session as authenticated |
| GET | /api/policy/state | Query current policy state from contract |
| POST | /api/policy/freeze | Freeze all outgoing payments |
| POST | /api/policy/restore | Restore payment operations |
| POST | /api/policy/revoke | Revoke the agent signer |
| POST | /api/mcp/extract | Extract request info from MCP tool calls |
| GET | /api/transactions | Retrieve payment transaction history |
| GET | /api/merchant/quote | Get a payment challenge from demo merchant |
| POST | /api/merchant/pay | Submit payment for a merchant challenge |
| GET | /health | Health check |

## Environment Variables

| Variable | Description |
|---|---|
| SOROBAN_RPC_URL | Soroban RPC endpoint |
| NETWORK_PASSPHRASE | Stellar network passphrase |
| POLICY_CONTRACT_ID | Deployed smart contract ID |
| OWNER_SECRET | Owner account secret key |
| MERCHANT_SECRET | Merchant account secret key |
| RECIPIENT_ADDRESS | Payment recipient address |
| USDC_ISSUER | USDC token contract address |
| RP_ID | WebAuthn relying party ID |
| ORIGIN | Frontend origin URL |
| SUPABASE_URL | Supabase project URL |
| SUPABASE_ANON_KEY | Supabase anonymous public key |
| SUPABASE_SERVICE_KEY | Supabase service role secret key |
| PORT | Backend server port |

## License

MIT
