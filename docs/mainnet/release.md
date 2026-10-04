# Building the release artifact

The WASM deployed to mainnet has to be the one that was reviewed, and anyone
has to be able to rebuild it from the tagged source and get the same hash.

## What fixes the output

| | Pinned in |
|---|---|
| Source and dependency versions | the release tag, `Cargo.lock` |
| Rust 1.96.0 and the `wasm32v1-none` target | `rust-toolchain.toml` |
| Stellar CLI 27.0.0, which builds and optimizes it, with the download's checksum | `scripts/build-release.sh` |
| The build platform: linux/amd64, Ubuntu 24.04 by image digest | `scripts/build-release.sh` |
| Release profile: size optimized, symbols stripped, overflow checks on | `Cargo.toml` |

The platform is pinned because it changes the output. On 4 October the same
commit built natively on macOS (Apple silicon) gave `963c55c1…`, and on
Linux gave `b94e7a95…`: the same size, with the type, function and code
sections in a different order. Turning wasm-opt off did not remove the
difference, so it comes from the compiler's host, not the optimizer. Two
Linux builds in different directories (CI's runner and a container on the
Mac) gave the same bytes, so the artifact carries no local paths.

## Rebuilding it

Only Docker is needed:

```bash
git checkout <release tag>
./scripts/build-release.sh
```

It prints the size and the hash and writes the artifact to
`target/release-wasm/`. CI runs the same script on every push, writes the
hash into the run's summary and attaches the artifact; `scripts/review-check.sh`
compares the two. On mainnet, `scripts/deploy.sh` builds with this script
and refuses any hash other than the reviewed one. A native
`stellar contract build` is still fine for tests and testnet.

## Builds so far

| Date | Commit | Bytes | sha256 | Note |
|---|---|---|---|---|
| 2026-09-30 | `d8dae24` | 15,168 | `b47cff38…eb56b96d` | first month, SDK 26 |
| 2026-10-02 | `3111ebc` | 28,488 | `963c55c19644bddb55ad0c78ba75572cc7bb4289cde517520f820f060e76d42f` | reworked for the mainnet pilot; a native macOS build, so not a release reference |
| 2026-10-04 | `6203712` | 28,488 | `b94e7a951332b9192696a2f6778a8e3833398172162b305271598285e19ae73f` | the pinned Linux build; [CI run](https://github.com/emirykl/Beaver402/actions/runs/37184988982) and a local container agree. Contract source unchanged since `3111ebc` |

| 2026-10-04 | `36fc236`, tag `v0.2.0-rc.1` | 28,488 | `b94e7a951332b9192696a2f6778a8e3833398172162b305271598285e19ae73f` | first release candidate, sent for external review; [CI run](https://github.com/emirykl/Beaver402/actions/runs/37185797472) matches the local container build |

The reviewed release candidate's hash is the one in the last row, and the deploy
script refuses any other on mainnet.
