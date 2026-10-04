#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — Deploy the payment_policy contract
#
#   ./scripts/deploy.sh                    testnet, backend/.env
#   ./scripts/deploy.sh --network mainnet  mainnet, backend/.env.mainnet
#
# The account owner is a passkey, so a passkey has to be registered
# before the contract can be created. Register one in the control
# panel, then run this.
#
# The contract cannot be changed after this. Everything that decides
# where money can go is fixed here: the owner passkey and its domain,
# the token, the recovery address and the highest limits.
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

# Prefer rustup toolchain over Homebrew Rust
if [ -d "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin" ]; then
    export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
fi

NETWORK="testnet"
while [ $# -gt 0 ]; do
    case "$1" in
        --network) NETWORK="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# stellar CLI v27+ uses the wasm32v1-none target
WASM_PATH="$ROOT_DIR/target/wasm32v1-none/release/payment_policy.wasm"

case "$NETWORK" in
    testnet)
        ENV_FILE="$ROOT_DIR/backend/.env"
        KEY_PREFIX="beaver402"
        ;;
    mainnet)
        ENV_FILE="$ROOT_DIR/backend/.env.mainnet"
        KEY_PREFIX="beaver402-mainnet"
        ;;
    *)
        echo "--network must be testnet or mainnet" >&2
        exit 1
        ;;
esac

# The pilot limits, the same on both networks so a testnet rehearsal is
# the real thing. Amounts are in stroops, seven decimals: 1 USDC per
# payment, 5 payments and 5 USDC in any 24 hours. They can only be
# lowered once the account exists.
MAX_PAYMENT_AMOUNT="${MAX_PAYMENT_AMOUNT:-10000000}"
MAX_TX_COUNT="${MAX_TX_COUNT:-5}"
MAX_TOTAL_AMOUNT="${MAX_TOTAL_AMOUNT:-50000000}"
WINDOW_SIZE="${WINDOW_SIZE:-86400}"

# Matches the identifier the control panel registers under.
PASSKEY_USER="${PASSKEY_USER:-beaver402-owner}"

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
[ -f "$ENV_FILE" ] || error "$ENV_FILE does not exist"

env_value() {
    python3 - "$ENV_FILE" "$1" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
for line in open(path).read().splitlines():
    if line.startswith(f"{key}="):
        print(line[len(key) + 1:].strip().strip('"'))
        break
PY
}

json_value() {
    python3 -c "import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]])" "$1" "$2"
}

# ── Step 1: The network, as the backend sees it ───────────────────
# The same validation the backend runs at startup, including asking the
# RPC which network it actually serves.
info "Checking the $NETWORK configuration in $ENV_FILE..."
PARAMS=$(cd "$ROOT_DIR/backend" && npx --no-install tsx --env-file="$ENV_FILE" scripts/deploy-params.ts) \
    || error "The configuration is not one the backend would run with."

[ "$(json_value "$PARAMS" network)" = "$NETWORK" ] \
    || error "$ENV_FILE is set up for $(json_value "$PARAMS" network), not $NETWORK"

RPC_URL=$(json_value "$PARAMS" rpcUrl)
NETWORK_PASSPHRASE=$(json_value "$PARAMS" passphrase)
USDC_CONTRACT=$(json_value "$PARAMS" usdcContract)
EXPLORER=$(json_value "$PARAMS" explorer)
RP_ID=$(json_value "$PARAMS" rpId)
RP_ID_HASH=$(json_value "$PARAMS" rpIdHash)
NET_ARGS=(--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")

info "Network:  $NETWORK ($RPC_URL)"
info "USDC:     $USDC_CONTRACT"
info "Passkey:  $RP_ID"

# ── Step 2: The owner passkey ─────────────────────────────────────
# Read this first. Everything below is wasted work if there is no
# passkey to own the account.
info "Reading the owner passkey..."
OWNER_KEY=$(cd "$ROOT_DIR/backend" && npx --no-install tsx --env-file="$ENV_FILE" scripts/owner-key.ts "$PASSKEY_USER") \
    || error "Could not read the owner passkey. Register one in the control panel first."

if [ ${#OWNER_KEY} -ne 130 ]; then
    error "Owner key should be 130 hex characters, got ${#OWNER_KEY}"
fi
info "Owner passkey: ${OWNER_KEY:0:16}..."

# ── Step 3: Where funds go in an emergency ────────────────────────
RECOVERY_ADDRESS="${RECOVERY_ADDRESS:-$(env_value RECOVERY_ADDRESS)}"
if [ -z "$RECOVERY_ADDRESS" ]; then
    if [ "$NETWORK" = "mainnet" ]; then
        error "RECOVERY_ADDRESS is required on mainnet. It cannot be changed after deployment."
    fi
    RECOVERY_ADDRESS=$(stellar keys address "$KEY_PREFIX-deployer")
    warn "No RECOVERY_ADDRESS set, using the deployer on testnet: $RECOVERY_ADDRESS"
fi

# ── Step 4: Build ─────────────────────────────────────────────────
cd "$ROOT_DIR"
if [ "$NETWORK" = "mainnet" ]; then
    # The reviewed hash comes from the pinned Linux build; a native build
    # on macOS gives different bytes from the same source.
    info "Building the release artifact in the pinned Linux image..."
    "$ROOT_DIR/scripts/build-release.sh" >/dev/null
    WASM_PATH="$ROOT_DIR/target/release-wasm/payment_policy.wasm"
else
    info "Building the contract..."
    stellar contract build >/dev/null
fi

[ -f "$WASM_PATH" ] || error "WASM not found at $WASM_PATH"
WASM_HASH=$(shasum -a 256 "$WASM_PATH" | cut -d' ' -f1)
info "Built $(wc -c < "$WASM_PATH" | tr -d ' ') bytes, sha256 $WASM_HASH"

# On mainnet only the artifact that was reviewed may be deployed.
if [ "$NETWORK" = "mainnet" ]; then
    EXPECTED_WASM_HASH="${EXPECTED_WASM_HASH:-}"
    [ -n "$EXPECTED_WASM_HASH" ] \
        || error "EXPECTED_WASM_HASH is required on mainnet: the hash of the reviewed release candidate"
    [ "$WASM_HASH" = "$EXPECTED_WASM_HASH" ] \
        || error "This build is $WASM_HASH, the reviewed one is $EXPECTED_WASM_HASH. Build from the release tag."
fi

# ── Step 5: Keys ──────────────────────────────────────────────────
# setup-keys.sh made the testnet ones before the backend was ever
# started. Mainnet keys are created and funded by hand.
for role in deployer agent merchant; do
    stellar keys address "$KEY_PREFIX-$role" >/dev/null 2>&1 \
        || error "Key '$KEY_PREFIX-$role' is missing."
done

DEPLOYER_ADDR=$(stellar keys address "$KEY_PREFIX-deployer")
AGENT_ADDR=$(stellar keys address "$KEY_PREFIX-agent")
MERCHANT_ADDR=$(stellar keys address "$KEY_PREFIX-merchant")

info "Deployer: $DEPLOYER_ADDR"
info "Agent:    $AGENT_ADDR"
info "Merchant: $MERCHANT_ADDR"
info "Recovery: $RECOVERY_ADDRESS"

# The contract stores the agent as a raw ed25519 key, not as an address.
strkey_to_hex() {
    python3 -c "
import base64, sys
print(base64.b32decode(sys.argv[1])[1:33].hex())
" "$1"
}

AGENT_HEX=$(strkey_to_hex "$AGENT_ADDR")
MERCHANT_HEX=$(strkey_to_hex "$MERCHANT_ADDR")

VELOCITY_CONFIG="{\"max_payment_amount\":\"$MAX_PAYMENT_AMOUNT\",\"max_tx_count\":$MAX_TX_COUNT,\"max_total_amount\":\"$MAX_TOTAL_AMOUNT\",\"window_size\":$WINDOW_SIZE}"

# ── Step 6: Say exactly what is about to happen ───────────────────
echo ""
echo "  Network         $NETWORK"
echo "  Artifact        $WASM_HASH"
echo "  Owner passkey   ${OWNER_KEY:0:16}... on $RP_ID"
echo "  Agent signer    $AGENT_ADDR"
echo "  Asset           $USDC_CONTRACT"
echo "  Recovery        $RECOVERY_ADDRESS"
echo "  Limits          $VELOCITY_CONFIG"
echo ""
if [ "$NETWORK" = "mainnet" ]; then
    warn "None of this can be changed after deployment."
    read -r -p "Type 'deploy to mainnet' to continue: " CONFIRMATION
    [ "$CONFIRMATION" = "deploy to mainnet" ] || error "Not confirmed, nothing was deployed."
fi

# ── Step 7: Deploy ────────────────────────────────────────────────
# One deploy, with the constructor arguments. If this fails the script
# stops, rather than leaving a half configured contract behind.
info "Deploying to $NETWORK..."

CONTRACT_ID=$(stellar contract deploy \
    --wasm "$WASM_PATH" \
    --source "$KEY_PREFIX-deployer" \
    "${NET_ARGS[@]}" \
    -- \
    --owner "$OWNER_KEY" \
    --rp_id_hash "$RP_ID_HASH" \
    --agent_signer "$AGENT_HEX" \
    --asset "$USDC_CONTRACT" \
    --recovery "$RECOVERY_ADDRESS" \
    --velocity_config "$VELOCITY_CONFIG")

[ -n "$CONTRACT_ID" ] || error "Deploy produced no contract id"
info "Contract deployed: $CONTRACT_ID"

# ── Step 8: Verify ────────────────────────────────────────────────
info "Verifying what the contract reports about itself..."
view() {
    stellar contract invoke --id "$CONTRACT_ID" --source "$KEY_PREFIX-deployer" \
        "${NET_ARGS[@]}" --send=no -- "$@"
}

ASSET_ON_CHAIN=$(view get_asset | tr -d '"')
RECOVERY_ON_CHAIN=$(view get_recovery | tr -d '"')
AGENT_ON_CHAIN=$(view get_agent_signer | tr -d '"')

[ "$ASSET_ON_CHAIN" = "$USDC_CONTRACT" ] || error "asset on chain is $ASSET_ON_CHAIN"
[ "$RECOVERY_ON_CHAIN" = "$RECOVERY_ADDRESS" ] || error "recovery on chain is $RECOVERY_ON_CHAIN"
[ "$AGENT_ON_CHAIN" = "$AGENT_HEX" ] || error "agent on chain is $AGENT_ON_CHAIN"
info "is_frozen:       $(view is_frozen)"
info "velocity_config: $(view get_velocity_config)"

# ── Step 9: Record the contract id ────────────────────────────────
# Only this one value changes. Everything else in the file is still
# correct.
info "Recording the contract id in $ENV_FILE..."

python3 - "$ENV_FILE" "$CONTRACT_ID" <<'PY'
import sys
path, contract_id = sys.argv[1], sys.argv[2]
lines = open(path).read().splitlines() if __import__("os").path.exists(path) else []
if any(line.startswith("POLICY_CONTRACT_ID=") for line in lines):
    lines = [
        f"POLICY_CONTRACT_ID={contract_id}"
        if line.startswith("POLICY_CONTRACT_ID=")
        else line
        for line in lines
    ]
else:
    lines.append(f"POLICY_CONTRACT_ID={contract_id}")
open(path, "w").write("\n".join(lines) + "\n")
PY

info "──────────────────────────────────────────────"
info "Done"
info "──────────────────────────────────────────────"
info "Contract:  $CONTRACT_ID"
info "Explorer:  $EXPLORER/contract/$CONTRACT_ID"
info "Artifact:  $WASM_HASH"
echo ""
echo "Next steps:"
echo "  1. Approve the merchant from the control panel: $MERCHANT_HEX"
echo "  2. Fund the account with USDC, within the pilot limit: $CONTRACT_ID"
echo "  3. Record this deployment in docs/mainnet/deployment-record.md"
