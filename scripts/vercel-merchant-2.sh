#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — Put the second mainnet merchant on Vercel
#
#   ./scripts/vercel-merchant-2.sh
#
# Deploys packages/merchant/deploy-vercel, the kit's example as a Vercel
# function, as the project beaver402-merchant-2. Its signing key and
# recipient come from packages/merchant/example/.env.mainnet; the RPC,
# facilitator key and database from backend/.env.mainnet. The agent's
# project is told the merchant exists, so the owner panel lists it for
# approval, and redeployed. No value is printed.
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MERCHANT_ENV="$ROOT_DIR/packages/merchant/example/.env.mainnet"
BACKEND_ENV="$ROOT_DIR/backend/.env.mainnet"
PROJECT=beaver402-merchant-2
PUBLIC_URL="https://$PROJECT.vercel.app"

for f in "$MERCHANT_ENV" "$BACKEND_ENV"; do
    [ -f "$f" ] || { echo "$f does not exist" >&2; exit 1; }
done

value() {
    python3 - "$1" "$2" <<'PY'
import sys
path, key = sys.argv[1], sys.argv[2]
for line in open(path).read().splitlines():
    if line.startswith(f"{key}="):
        print(line[len(key) + 1:].strip(), end="")
        break
PY
}

put() {
    local project=$1 name=$2 val=$3
    [ -n "$val" ] || { echo "  FAIL  $project $name is empty" >&2; exit 1; }
    printf '%s' "$val" | npx vercel env add "$name" production \
        --project "$project" --force --sensitive >/dev/null 2>&1 \
        && echo "  ok    $project $name" \
        || { echo "  FAIL  $project $name" >&2; exit 1; }
}

echo "Project"
npx vercel project add "$PROJECT" >/dev/null 2>&1 && echo "  ok    created $PROJECT" || echo "  --    $PROJECT already exists"

echo "Settings"
for name in BEAVER402_NETWORK USDC_CONTRACT MERCHANT_SECRET RECIPIENT_ADDRESS PRICE_USDC; do
    put "$PROJECT" "$name" "$(value "$MERCHANT_ENV" "$name")"
done
for name in SOROBAN_RPC_URL FACILITATOR_API_KEY SUPABASE_URL SUPABASE_SERVICE_KEY; do
    put "$PROJECT" "$name" "$(value "$BACKEND_ENV" "$name")"
done
put "$PROJECT" PUBLIC_URL "$PUBLIC_URL"

echo "Deploy"
cd "$ROOT_DIR/packages/merchant/deploy-vercel"
npx vercel link --yes --project "$PROJECT" >/dev/null 2>&1
npx vercel deploy --prod --yes >/dev/null 2>&1 && echo "  ok    $PUBLIC_URL" || { echo "  FAIL  deploy" >&2; exit 1; }

echo "Owner panel"
SIGNER="$(cd "$ROOT_DIR/backend" && node -e "import('@stellar/stellar-sdk').then(s => process.stdout.write(s.Keypair.fromSecret(process.argv[1]).publicKey()))" "$(value "$MERCHANT_ENV" MERCHANT_SECRET)")"
printf '%s' "Merchant 2=$SIGNER" | npx vercel env add MERCHANTS production \
    --project beaver402-api --force >/dev/null 2>&1 && echo "  ok    beaver402-api MERCHANTS" || { echo "  FAIL  MERCHANTS" >&2; exit 1; }
cd "$ROOT_DIR/backend"
npx vercel link --yes --project beaver402-api >/dev/null 2>&1
npx vercel deploy --prod --yes >/dev/null 2>&1 && echo "  ok    beaver402-api redeployed" || { echo "  FAIL  beaver402-api deploy" >&2; exit 1; }

echo "Done. Check: $PUBLIC_URL/health"
