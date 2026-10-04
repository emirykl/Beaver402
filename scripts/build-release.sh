#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Beaver402 — Build the release WASM the same way on every machine
#
#   ./scripts/build-release.sh
#
# Writes target/release-wasm/payment_policy.wasm and its .sha256.
#
# The compiler's output depends on the platform it runs on: the same
# source, Rust and Stellar CLI give one hash on macOS and another on
# Linux, with or without wasm-opt. So the release artifact is always
# built on linux/amd64, inside a pinned Ubuntu image, with the pinned
# Stellar CLI and the toolchain from rust-toolchain.toml. CI runs this
# script, the reviewer runs it, and the mainnet deploy runs it, and
# all three get the same bytes. Only Docker is needed on the host.
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/target/release-wasm"

# Change these together with docs/mainnet/release.md.
IMAGE="ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55"
STELLAR_CLI_VERSION="27.0.0"
STELLAR_CLI_SHA256="357bf712f6353c28cd33c794402a3c87231757a5b305e6ef1604365af4fdd556"

command -v docker >/dev/null 2>&1 || { echo "Docker is required: https://docs.docker.com/get-docker/" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running; start it and try again" >&2; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT/payment_policy.wasm" "$OUT/payment_policy.wasm.sha256"

# Only what the contract build reads goes in, read-only. The build runs
# on a copy so nothing from the host's target directory leaks in.
docker run --rm --platform linux/amd64 \
    -e STELLAR_CLI_VERSION="$STELLAR_CLI_VERSION" \
    -e STELLAR_CLI_SHA256="$STELLAR_CLI_SHA256" \
    -v "$ROOT/Cargo.toml:/src/Cargo.toml:ro" \
    -v "$ROOT/Cargo.lock:/src/Cargo.lock:ro" \
    -v "$ROOT/rust-toolchain.toml:/src/rust-toolchain.toml:ro" \
    -v "$ROOT/contracts:/src/contracts:ro" \
    -v "$OUT:/out" \
    "$IMAGE" bash -euo pipefail -c '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq >/dev/null
        apt-get install -y -qq --no-install-recommends \
            curl ca-certificates build-essential libdbus-1-3 libudev1 >/dev/null
        curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none >/dev/null 2>&1
        . "$HOME/.cargo/env"
        curl -sSfL -o /tmp/stellar.tgz \
            "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
        echo "${STELLAR_CLI_SHA256}  /tmp/stellar.tgz" | sha256sum --check --quiet
        tar xzf /tmp/stellar.tgz -C /usr/local/bin stellar
        cp -r /src /build && cd /build
        rustup toolchain install >/dev/null 2>&1
        echo "rustc   $(rustc --version)"
        echo "stellar $(stellar --version | head -1)"
        stellar contract build --quiet
        cp target/wasm32v1-none/release/payment_policy.wasm /out/
        cd /out && sha256sum payment_policy.wasm > payment_policy.wasm.sha256
    '

echo "bytes   $(wc -c <"$OUT/payment_policy.wasm" | tr -d " ")"
echo "sha256  $(cut -d" " -f1 "$OUT/payment_policy.wasm.sha256")"
echo "file    $OUT/payment_policy.wasm"
