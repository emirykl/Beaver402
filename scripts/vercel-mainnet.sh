#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — Point the hosted agent and merchant at mainnet
#
#   ./scripts/vercel-mainnet.sh
#
# Copies the values each role needs from backend/.env.mainnet into the
# production settings of its Vercel project, as sensitive variables, and
# redeploys both. No value is printed. The agent's contract id is copied
# once deploy.sh has written it, and removed before that.
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/backend/.env.mainnet"
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE does not exist" >&2; exit 1; }

env_value() {
    python3 - "$ENV_FILE" "$1" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
for line in open(path).read().splitlines():
    if line.startswith(f"{key}="):
        print(line[len(key) + 1:].strip(), end="")
        break
PY
}

put() {
    local project=$1 name=$2 value=$3
    [ -n "$value" ] || { echo "  FAIL  $project $name is empty in $ENV_FILE" >&2; exit 1; }
    printf '%s' "$value" | npx vercel env add "$name" production \
        --project "$project" --force --sensitive >/dev/null 2>&1 \
        && echo "  ok    $project $name" \
        || { echo "  FAIL  $project $name" >&2; exit 1; }
}

echo "Agent (beaver402-api)"
for name in BEAVER_NETWORK SOROBAN_RPC_URL SUPABASE_URL SUPABASE_SERVICE_KEY \
    AGENT_SECRET FEE_SOURCE_SECRET MERCHANT_PUBKEY AGENT_API_TOKEN \
    AGENT_ALLOWED_ORIGINS CRON_SECRET RP_ID ORIGIN; do
    put beaver402-api "$name" "$(env_value "$name")"
done
put beaver402-api BEAVER402_ROLE agent
# The account's id once deploy.sh has created it; until then the agent
# runs without one.
for name in POLICY_CONTRACT_ID POLICY_DEPLOY_LEDGER; do
    value="$(env_value "$name")"
    if [ -n "$value" ]; then
        put beaver402-api "$name" "$value"
    else
        npx vercel env rm "$name" production --project beaver402-api --yes >/dev/null 2>&1 \
            && echo "  ok    beaver402-api $name removed" \
            || echo "  --    beaver402-api $name was not set"
    fi
done

echo "Merchant (beaver402-merchant)"
for name in BEAVER_NETWORK SOROBAN_RPC_URL SUPABASE_URL SUPABASE_SERVICE_KEY \
    FACILITATOR_API_KEY MERCHANT_SECRET RECIPIENT_ADDRESS; do
    put beaver402-merchant "$name" "$(env_value "$name")"
done
put beaver402-merchant BEAVER402_ROLE merchant

echo "Redeploying"
cd "$ROOT_DIR/backend"
npx vercel link --yes --project beaver402-api >/dev/null 2>&1
npx vercel deploy --prod --yes >/dev/null 2>&1 && echo "  ok    beaver402-api" || { echo "  FAIL  beaver402-api deploy" >&2; exit 1; }
npx vercel link --yes --project beaver402-merchant >/dev/null 2>&1
npx vercel deploy --prod --yes --local-config vercel.merchant.json >/dev/null 2>&1 && echo "  ok    beaver402-merchant" || { echo "  FAIL  beaver402-merchant deploy" >&2; exit 1; }

echo "Done. Check: https://beaver402-api.vercel.app/health"
