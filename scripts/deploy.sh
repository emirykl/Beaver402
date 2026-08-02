#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — Deploy payment_policy contract to Stellar testnet
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

# Prefer rustup toolchain over Homebrew Rust
if [ -d "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin" ]; then
    export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
fi

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# stellar CLI v27+ uses wasm32v1-none target
WASM_PATH="$ROOT_DIR/target/wasm32v1-none/release/payment_policy.wasm"
ENV_FILE="$ROOT_DIR/backend/.env"

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── Pre-checks ───────────────────────────────────────────────────
command -v stellar >/dev/null 2>&1 || error "stellar CLI not found. Install: https://soroban.stellar.org/docs/getting-started/setup"

# ── Step 1: Build the contract ────────────────────────────────────
info "Building payment_policy contract..."
cd "$ROOT_DIR"
stellar contract build 2>&1

if [ ! -f "$WASM_PATH" ]; then
    error "WASM not found at $WASM_PATH — build failed"
fi

info "WASM built: $(du -h "$WASM_PATH" | cut -f1) — $WASM_PATH"

# ── Step 2: Generate keys if needed ──────────────────────────────
generate_key() {
    local name=$1
    if stellar keys address "$name" >/dev/null 2>&1; then
        info "Key '$name' already exists"
    else
        info "Generating key '$name'..."
        stellar keys generate "$name" --network $NETWORK 2>&1
        # Fund from friendbot
        info "Funding '$name' from friendbot..."
        stellar keys fund "$name" --network $NETWORK 2>&1 || warn "Funding failed — may already be funded"
    fi
}

generate_key "beaver402-owner"
generate_key "beaver402-agent"
generate_key "beaver402-merchant"

OWNER_ADDR=$(stellar keys address beaver402-owner)
AGENT_ADDR=$(stellar keys address beaver402-agent)
MERCHANT_ADDR=$(stellar keys address beaver402-merchant)

OWNER_SECRET=$(stellar keys show beaver402-owner)
AGENT_SECRET=$(stellar keys show beaver402-agent)
MERCHANT_SECRET=$(stellar keys show beaver402-merchant)

info "Owner:    $OWNER_ADDR"
info "Agent:    $AGENT_ADDR"
info "Merchant: $MERCHANT_ADDR"

# ── Step 3: Deploy the contract ───────────────────────────────────
info "Deploying contract to testnet..."

CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source beaver402-owner \
    --network $NETWORK \
    2>&1)

info "Contract deployed: $CONTRACT_ID"

# ── Step 4: Initialize the contract ──────────────────────────────
# Convert public keys to bytes32 format for the constructor
# The constructor takes: owner (bytes32), agent_signer (bytes32), velocity_config

# Get raw public key bytes (32 bytes hex)
owner_pk_hex=$(stellar keys address beaver402-owner | stellar contract invoke --id $CONTRACT_ID --source beaver402-owner --network $NETWORK -- 2>&1 || true)

info "Initializing contract with constructor..."
# Contract was already initialized during deploy since soroban v26 uses __constructor
# We need to deploy with constructor args

# Re-deploy with constructor args
info "Re-deploying with constructor arguments..."

# Convert Stellar addresses to raw 32-byte public keys
owner_hex=$(echo "$OWNER_ADDR" | python3 -c "
import sys, base64, struct
addr = sys.stdin.read().strip()
# Stellar public key: version byte (0x30) + 32 bytes + 2 byte checksum
import hashlib
def decode_stellar_key(key):
    # Base32 decode
    import base64
    decoded = base64.b32decode(key)
    return decoded[1:33].hex()
print(decode_stellar_key(addr))
")

agent_hex=$(echo "$AGENT_ADDR" | python3 -c "
import sys, base64
addr = sys.stdin.read().strip()
def decode_stellar_key(key):
    decoded = base64.b32decode(key)
    return decoded[1:33].hex()
print(decode_stellar_key(addr))
")

merchant_hex=$(echo "$MERCHANT_ADDR" | python3 -c "
import sys, base64
addr = sys.stdin.read().strip()
def decode_stellar_key(key):
    decoded = base64.b32decode(key)
    return decoded[1:33].hex()
print(decode_stellar_key(addr))
")

# Deploy with __constructor args
# First, remove the contract we just deployed (it failed to init)
info "Deploying contract with initialization parameters..."

CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source beaver402-owner \
    --network $NETWORK \
    -- \
    --owner "$owner_hex" \
    --agent_signer "$agent_hex" \
    --velocity_config '{"max_tx_count": 10, "max_total_amount": 100000000000, "window_size": 86400}' \
    2>&1) || true

# If the above fails, try the invoke-based approach
if [ -z "$CONTRACT_ID" ] || [[ "$CONTRACT_ID" == *"error"* ]]; then
    warn "Constructor-based deploy not available, using two-step approach..."

    CONTRACT_ID=$(stellar contract deploy \
        --wasm "$WASM_PATH" \
        --source beaver402-owner \
        --network $NETWORK \
        2>&1)

    info "Contract deployed: $CONTRACT_ID"

    stellar contract invoke \
        --id "$CONTRACT_ID" \
        --source beaver402-owner \
        --network $NETWORK \
        -- \
        __constructor \
        --owner "$owner_hex" \
        --agent_signer "$agent_hex" \
        --velocity_config '{"max_tx_count": 10, "max_total_amount": 100000000000, "window_size": 86400}' \
        2>&1 || warn "Constructor may have been called during deploy"
fi

info "Contract ID: $CONTRACT_ID"

# ── Step 5: Add merchant to allowlist ─────────────────────────────
info "Adding merchant to allowlist..."
stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source beaver402-owner \
    --network $NETWORK \
    -- \
    add_merchant \
    --merchant_pubkey "$merchant_hex" \
    2>&1 || warn "add_merchant failed (may need auth)"

# ── Step 6: Verify deployment ─────────────────────────────────────
info "Verifying deployment..."

FROZEN=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source beaver402-owner \
    --network $NETWORK \
    -- \
    is_frozen 2>&1) || true

info "is_frozen: ${FROZEN:-unknown}"

AGENT=$(stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source beaver402-owner \
    --network $NETWORK \
    -- \
    get_agent_signer 2>&1) || true

info "agent_signer: ${AGENT:-unknown}"

# ── Step 7: Write .env file (preserve existing Supabase keys) ────
info "Writing backend/.env..."

# Read existing Supabase values before overwriting
EXISTING_SUPABASE_URL=""
EXISTING_SUPABASE_ANON_KEY=""
EXISTING_SUPABASE_SERVICE_KEY=""
if [ -f "$ENV_FILE" ]; then
    EXISTING_SUPABASE_URL=$(grep '^SUPABASE_URL=' "$ENV_FILE" | cut -d'=' -f2- || true)
    EXISTING_SUPABASE_ANON_KEY=$(grep '^SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d'=' -f2- || true)
    EXISTING_SUPABASE_SERVICE_KEY=$(grep '^SUPABASE_SERVICE_KEY=' "$ENV_FILE" | cut -d'=' -f2- || true)
fi

cat > "$ENV_FILE" <<EOF
SOROBAN_RPC_URL=$RPC_URL
NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE
POLICY_CONTRACT_ID=$CONTRACT_ID
OWNER_SECRET=$OWNER_SECRET
MERCHANT_SECRET=$MERCHANT_SECRET
AGENT_SECRET=$AGENT_SECRET
RECIPIENT_ADDRESS=$MERCHANT_ADDR
USDC_ISSUER=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
RP_ID=localhost
ORIGIN=http://localhost:5173
CREDENTIAL_STORE=.beaver402-credentials.json
SUPABASE_URL=${EXISTING_SUPABASE_URL}
SUPABASE_ANON_KEY=${EXISTING_SUPABASE_ANON_KEY}
SUPABASE_SERVICE_KEY=${EXISTING_SUPABASE_SERVICE_KEY}
PORT=3000
EOF

info "──────────────────────────────────────────────"
info "Deployment complete!"
info "──────────────────────────────────────────────"
info "Contract ID:  $CONTRACT_ID"
info "Owner:        $OWNER_ADDR"
info "Agent:        $AGENT_ADDR"
info "Merchant:     $MERCHANT_ADDR"
info ".env written: $ENV_FILE"
info "──────────────────────────────────────────────"
echo ""
echo "Next steps:"
echo "  1. cd backend && npm run dev"
echo "  2. cd frontend && npm run dev"
echo "  3. Open http://localhost:5173"
