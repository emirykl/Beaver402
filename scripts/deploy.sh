#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — Deploy payment_policy contract to Stellar testnet
#
# The account owner is a passkey, so a passkey has to be registered
# before the contract can be created. Register one in the control
# panel, then run this.
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
# stellar CLI v27+ uses the wasm32v1-none target
WASM_PATH="$ROOT_DIR/target/wasm32v1-none/release/payment_policy.wasm"
ENV_FILE="$ROOT_DIR/backend/.env"

# Testnet USDC. Override with USDC_CONTRACT to settle in another token.
USDC_CONTRACT="${USDC_CONTRACT:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}"

# Velocity budget the account starts with.
MAX_TX_COUNT="${MAX_TX_COUNT:-10}"
MAX_TOTAL_AMOUNT="${MAX_TOTAL_AMOUNT:-100000000000}"
WINDOW_SIZE="${WINDOW_SIZE:-86400}"

PASSKEY_USER="${PASSKEY_USER:-owner}"

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── Pre-checks ────────────────────────────────────────────────────
command -v stellar >/dev/null 2>&1 \
    || error "stellar CLI not found. Install it from https://developers.stellar.org/docs/tools/cli"

# ── Step 1: The owner passkey ─────────────────────────────────────
# Read this first. Everything below is wasted work if there is no
# passkey to own the account.
info "Reading the owner passkey..."
OWNER_KEY=$(cd "$ROOT_DIR/backend" && npm run --silent owner:key "$PASSKEY_USER") \
    || error "Could not read the owner passkey. Register one in the control panel first."

if [ ${#OWNER_KEY} -ne 130 ]; then
    error "Owner key should be 130 hex characters, got ${#OWNER_KEY}"
fi
info "Owner passkey: ${OWNER_KEY:0:16}..."

# ── Step 2: Build ─────────────────────────────────────────────────
info "Building the contract..."
cd "$ROOT_DIR"
stellar contract build

[ -f "$WASM_PATH" ] || error "WASM not found at $WASM_PATH"
info "Built $(du -h "$WASM_PATH" | cut -f1) at $WASM_PATH"

# ── Step 3: Keys ──────────────────────────────────────────────────
ensure_key() {
    local name=$1
    if stellar keys address "$name" >/dev/null 2>&1; then
        info "Key '$name' already exists"
    else
        info "Generating and funding '$name'..."
        stellar keys generate "$name" --network "$NETWORK"
        stellar keys fund "$name" --network "$NETWORK" \
            || warn "Funding '$name' failed, it may already be funded"
    fi
}

ensure_key "beaver402-deployer"
ensure_key "beaver402-agent"
ensure_key "beaver402-merchant"

DEPLOYER_ADDR=$(stellar keys address beaver402-deployer)
AGENT_ADDR=$(stellar keys address beaver402-agent)
MERCHANT_ADDR=$(stellar keys address beaver402-merchant)

DEPLOYER_SECRET=$(stellar keys show beaver402-deployer)
AGENT_SECRET=$(stellar keys show beaver402-agent)
MERCHANT_SECRET=$(stellar keys show beaver402-merchant)

info "Deployer: $DEPLOYER_ADDR"
info "Agent:    $AGENT_ADDR"
info "Merchant: $MERCHANT_ADDR"

# The contract stores the agent as a raw ed25519 key, not as an address.
strkey_to_hex() {
    python3 -c "
import base64, sys
print(base64.b32decode(sys.argv[1])[1:33].hex())
" "$1"
}

AGENT_HEX=$(strkey_to_hex "$AGENT_ADDR")
MERCHANT_HEX=$(strkey_to_hex "$MERCHANT_ADDR")

# ── Step 4: Deploy ────────────────────────────────────────────────
# One deploy, with the constructor arguments. If this fails the script
# stops, rather than leaving a half configured contract behind.
info "Deploying to $NETWORK..."

CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source beaver402-deployer \
    --network "$NETWORK" \
    -- \
    --owner "$OWNER_KEY" \
    --agent_signer "$AGENT_HEX" \
    --velocity_config "{\"max_tx_count\":$MAX_TX_COUNT,\"max_total_amount\":$MAX_TOTAL_AMOUNT,\"window_size\":$WINDOW_SIZE}")

[ -n "$CONTRACT_ID" ] || error "Deploy produced no contract id"
info "Contract deployed: $CONTRACT_ID"

# ── Step 5: Allowlist the demo merchant ───────────────────────────
# Adding a merchant is an owner action, so it needs the passkey. The
# control panel does that; here we only report what still has to happen.
warn "The demo merchant is not allowlisted yet."
warn "Adding a merchant is an owner action and needs the passkey."
warn "Do it from the control panel, or run the add_merchant scenario."
info "Merchant key to allowlist: $MERCHANT_HEX"

# ── Step 6: Verify ────────────────────────────────────────────────
info "Verifying..."

FROZEN=$(stellar contract invoke --id "$CONTRACT_ID" --source beaver402-deployer \
    --network "$NETWORK" -- is_frozen)
info "is_frozen: $FROZEN"

AGENT_ON_CHAIN=$(stellar contract invoke --id "$CONTRACT_ID" --source beaver402-deployer \
    --network "$NETWORK" -- get_agent_signer)
info "agent_signer: $AGENT_ON_CHAIN"

# ── Step 7: Write backend/.env ────────────────────────────────────
info "Writing $ENV_FILE..."

preserve() {
    # Keep a value that is already in the env file, if there is one.
    [ -f "$ENV_FILE" ] && grep "^$1=" "$ENV_FILE" | head -1 | cut -d'=' -f2- || true
}

SUPABASE_URL=$(preserve SUPABASE_URL)
SUPABASE_ANON_KEY=$(preserve SUPABASE_ANON_KEY)
SUPABASE_SERVICE_KEY=$(preserve SUPABASE_SERVICE_KEY)
RP_ID=$(preserve RP_ID)
ORIGIN=$(preserve ORIGIN)

cat > "$ENV_FILE" <<EOF
SOROBAN_RPC_URL=$RPC_URL
NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE
POLICY_CONTRACT_ID=$CONTRACT_ID
FEE_SOURCE_SECRET=$DEPLOYER_SECRET
AGENT_SECRET=$AGENT_SECRET
MERCHANT_SECRET=$MERCHANT_SECRET
RECIPIENT_ADDRESS=$MERCHANT_ADDR
USDC_ISSUER=$USDC_CONTRACT
RP_ID=${RP_ID:-localhost}
ORIGIN=${ORIGIN:-http://localhost:5173}
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY
PORT=3000
EOF

info "──────────────────────────────────────────────"
info "Done"
info "──────────────────────────────────────────────"
info "Contract:  $CONTRACT_ID"
info "Explorer:  https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
info "Owner:     the registered passkey"
info "Agent:     $AGENT_ADDR"
info "Merchant:  $MERCHANT_ADDR"
echo ""
echo "Next steps:"
echo "  1. Fund the account with testnet USDC: $CONTRACT_ID"
echo "  2. Allowlist the merchant from the control panel"
echo "  3. cd backend && npm run dev"
echo "  4. cd frontend && npm run dev"
