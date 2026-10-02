# Building the release artifact

The WASM deployed to mainnet has to be the one that was reviewed, and anyone
has to be able to rebuild it from the tagged source and get the same hash.

## What fixes the output

| | Pinned in |
|---|---|
| Source and dependency versions | the release tag, `Cargo.lock` |
| Rust 1.96.0 and the `wasm32v1-none` target | `rust-toolchain.toml` |
| Stellar CLI 27.0.0, which builds and optimizes it | `.github/workflows/ci.yml`, with the download's checksum |
| Release profile: size optimized, symbols stripped, overflow checks on | `Cargo.toml` |

The artifact carries no local paths, so a build on another machine with the
same three things produces the same bytes.

## Rebuilding it

```bash
git checkout <release tag>
stellar --version            # 27.0.0
stellar contract build
shasum -a 256 target/wasm32v1-none/release/payment_policy.wasm
```

CI does the same on every push and writes the hash into the run's summary;
the artifact is attached to the run.

## Builds so far

| Date | Commit | Bytes | sha256 | Note |
|---|---|---|---|---|
| 2026-09-30 | `d8dae24` | 15,168 | `b47cff38…eb56b96d` | first month, SDK 26 |
| 2026-10-02 | `3111ebc` | 28,488 | `963c55c19644bddb55ad0c78ba75572cc7bb4289cde517520f820f060e76d42f` | reworked for the mainnet pilot, before review |

The release candidate's hash goes here when it is tagged, and the deploy
script refuses any other on mainnet.
