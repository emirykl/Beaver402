#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — What the external reviewer runs before reading the code
#
#   ./scripts/review-check.sh                 the checked-out commit
#   ./scripts/review-check.sh v0.2.0-rc.1     a tag, checked out first
#
# Runs every check the release depends on and prints one summary the
# reviewer can paste into docs/security/peer-review.md: the commit,
# the toolchain, every test and audit result, and the WASM hash next
# to the one CI built for the same commit.
#
# It reads nothing secret, needs no .env file and sends nothing to
# any network except package registries and GitHub.
# ──────────────────────────────────────────────────────────────────
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ $# -gt 0 ]; then
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
        echo "the working tree has changes; commit or stash them before checking out $1" >&2
        exit 1
    fi
    git checkout --quiet "$1" || exit 1
fi

COMMIT="$(git rev-parse HEAD)"
TAG="$(git describe --tags --exact-match 2>/dev/null || echo "none")"
LOG="$(mktemp -d)"
FAILED=0
declare -a RESULTS

run() {
    local name="$1"; shift
    printf '… %s\n' "$name"
    if "$@" >"$LOG/$name.log" 2>&1; then
        RESULTS+=("pass  $name")
    else
        RESULTS+=("FAIL  $name   (log: $LOG/$name.log)")
        FAILED=1
    fi
}

need() {
    command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2" >&2; exit 1; }
}
need cargo   "install Rust with rustup; rust-toolchain.toml picks the version"
need npm     "install Node.js 22 or newer"
need stellar "install Stellar CLI 27.0.0 (the version CI pins)"
need shasum  "comes with macOS and most Linux distributions"

# ── Contract ──────────────────────────────────────────────────────
run contract-tests  cargo test --quiet
run contract-clippy cargo clippy --all-targets -- -D warnings
if command -v cargo-audit >/dev/null 2>&1; then
    run contract-audit cargo audit
else
    RESULTS+=("skip  contract-audit   (cargo install cargo-audit)")
fi
run contract-build  stellar contract build

WASM="target/wasm32v1-none/release/payment_policy.wasm"
LOCAL_HASH="$( [ -f "$WASM" ] && shasum -a 256 "$WASM" | cut -d' ' -f1 || echo "not built")"
LOCAL_BYTES="$( [ -f "$WASM" ] && wc -c <"$WASM" | tr -d ' ' || echo "-")"

# ── Backend and frontend ──────────────────────────────────────────
run backend-install  npm ci --prefix backend
run backend-tests    npm test --prefix backend
run backend-build    npm run build --prefix backend
run backend-audit    npm audit --omit=dev --prefix backend
run frontend-install npm ci --prefix frontend
run frontend-build   npm run build --prefix frontend
run frontend-audit   npm audit --omit=dev --prefix frontend

# ── The hash CI built for this same commit ────────────────────────
CI_HASH="not found"
CI_RUN="not found"
if command -v gh >/dev/null 2>&1; then
    RUN_ID="$(gh run list --commit "$COMMIT" --workflow CI --status success --limit 1 \
        --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
    if [ -n "$RUN_ID" ]; then
        CI_RUN="$(gh run view "$RUN_ID" --json url -q .url)"
        if gh run download "$RUN_ID" --dir "$LOG/ci" >/dev/null 2>&1; then
            FOUND="$(find "$LOG/ci" -name wasm.sha256 | head -1)"
            [ -n "$FOUND" ] && CI_HASH="$(cut -d' ' -f1 "$FOUND")"
        fi
    fi
fi
if [ "$CI_HASH" = "$LOCAL_HASH" ]; then
    HASH_MATCH="yes"
else
    HASH_MATCH="NO"
    FAILED=1
fi

# ── Summary ───────────────────────────────────────────────────────
CONTRACT_COUNT="$(grep -Eo '[0-9]+ passed' "$LOG/contract-tests.log" 2>/dev/null | awk '{s+=$1} END {print s+0}')"
BACKEND_COUNT="$(grep -E '^ +Tests ' "$LOG/backend-tests.log" 2>/dev/null | sed 's/^ *//')"

cat <<EOF

────────────────────────────────────────────────────────────────
Beaver402 review check — $(date -u +%Y-%m-%dT%H:%MZ)

commit          $COMMIT
tag             $TAG
rustc           $(rustc --version 2>/dev/null)
stellar         $(stellar --version 2>/dev/null | head -1)
node            $(node --version 2>/dev/null)

contract tests  $CONTRACT_COUNT passed
backend tests   ${BACKEND_COUNT:-see log}

wasm bytes      $LOCAL_BYTES
wasm sha256     $LOCAL_HASH
CI sha256       $CI_HASH
CI run          $CI_RUN
hashes match    $HASH_MATCH

$(printf '%s\n' "${RESULTS[@]}")
────────────────────────────────────────────────────────────────
EOF

if [ "$FAILED" -ne 0 ]; then
    echo "At least one check failed. The logs are in $LOG."
    exit 1
fi
echo "Every check passed. Paste this block into docs/security/peer-review.md."
