#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — Create the testnet keys the backend needs to run
#
# None of these depend on the contract, so this runs before anything
# is deployed. It has to, because registering the owner passkey needs
# a running backend, and the backend needs these keys to start.
#
# Safe to run more than once. Existing keys are left alone.
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

NETWORK="testnet"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/backend/.env"

USDC_CONTRACT="${USDC_CONTRACT:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}"
# Ports are searched for rather than fixed, because whatever number we
# picked would eventually collide with something else on the machine.
port_is_free() {
    ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

find_free_port() {
    local port=$1
    local limit=$((port + 50))
    while [ "$port" -lt "$limit" ]; do
        if port_is_free "$port"; then
            echo "$port"
            return 0
        fi
        port=$((port + 1))
    done
    echo "no free port between $1 and $limit" >&2
    return 1
}

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

command -v stellar >/dev/null 2>&1 \
    || error "stellar CLI not found. Install it from https://developers.stellar.org/docs/tools/cli"

BACKEND_PORT=$(find_free_port "${BACKEND_PORT:-3000}") \
    || error "Could not find a free port for the backend"
FRONTEND_PORT=$(find_free_port "${FRONTEND_PORT:-5173}") \
    || error "Could not find a free port for the control panel"

info "Backend port:  $BACKEND_PORT"
info "Frontend port: $FRONTEND_PORT"

# ── Keys ──────────────────────────────────────────────────────────
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

MERCHANT_ADDR=$(stellar keys address beaver402-merchant)

# ── Write them into the env file ──────────────────────────────────
# Values are replaced in place so anything already there, the contract
# id in particular, survives.
set_var() {
    local key=$1 value=$2
    touch "$ENV_FILE"
    if grep -q "^$key=" "$ENV_FILE"; then
        # Rewrite the line without letting sed interpret the value.
        python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
out = [f"{key}={value}" if line.startswith(f"{key}=") else line for line in lines]
open(path, "w").write("\n".join(out) + "\n")
PY
    else
        echo "$key=$value" >> "$ENV_FILE"
    fi
}

info "Writing keys into $ENV_FILE..."

set_var SOROBAN_RPC_URL "https://soroban-testnet.stellar.org"
set_var NETWORK_PASSPHRASE "Test SDF Network ; September 2015"
set_var FEE_SOURCE_SECRET "$(stellar keys show beaver402-deployer)"
set_var AGENT_SECRET "$(stellar keys show beaver402-agent)"
set_var MERCHANT_SECRET "$(stellar keys show beaver402-merchant)"
set_var RECIPIENT_ADDRESS "$MERCHANT_ADDR"
set_var USDC_ISSUER "$USDC_CONTRACT"
set_var PORT "$BACKEND_PORT"
# The control panel reads this so its proxy and the passkey origin agree
# with whichever ports were free.
set_var FRONTEND_PORT "$FRONTEND_PORT"

# A passkey is bound to the origin it was registered on, so a deployed
# setup keeps whatever it has. Local ones follow the frontend port.
if ! grep -q "^ORIGIN=" "$ENV_FILE" || grep -q "^ORIGIN=http://localhost" "$ENV_FILE"; then
    set_var ORIGIN "http://localhost:$FRONTEND_PORT"
fi
grep -q "^RP_ID=" "$ENV_FILE" || set_var RP_ID "localhost"
grep -q "^POLICY_CONTRACT_ID=" "$ENV_FILE" || set_var POLICY_CONTRACT_ID ""

info "──────────────────────────────────────────────"
info "Keys ready"
info "──────────────────────────────────────────────"
info "Deployer: $(stellar keys address beaver402-deployer)"
info "Agent:    $(stellar keys address beaver402-agent)"
info "Merchant: $MERCHANT_ADDR"
echo ""
echo "Next steps:"
echo "  1. cd backend && npm run dev"
echo "  2. cd frontend && npm run dev"
echo "  3. Open the control panel and register the owner passkey"
echo "  4. ./scripts/deploy.sh"
