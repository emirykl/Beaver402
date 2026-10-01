# Baseline before the mainnet work

Measured on 2026-09-30 at commit `d8dae24`, before anything in the second
month scope was changed. Every later result is compared against this.

## What passes

| Check | Result |
|---|---|
| Contract tests, `cargo test` | 35 passed |
| Backend tests, `vitest run` | 145 passed, 14 files |
| Backend type check | clean |
| Control panel build | clean |
| Release WASM | 15,168 bytes, sha256 `b47cff389e1d9e7ce7d67d88e63273d0a3d926d777b196054ae2c97eeb56b96d` |
| Control panel production dependencies | no known vulnerabilities |

## What does not

**Strict Clippy fails with two findings.** A large size difference between
the variants of `PolicySignature`, and a hand written multiple-of check in
the tests.

**The backend dependency audit reports six advisories, one high.** `fast-uri`
is the high one, with `hono`, `ip-address` and `qs` moderate, all transitive
and all with a fix available. The other two are `vitest` and its mocker,
which are only reported as production dependencies because the test and
build tools are listed under `dependencies` rather than `devDependencies`.

## Versions

| | In the repository | Live |
|---|---|---|
| Stellar protocol | built against 26 | mainnet 28, testnet 29 |
| `soroban-sdk` | 26.1.1 | 28.0.0 is the latest release |
| `@stellar/stellar-sdk` | 16.2 | `@x402/stellar` 2.28.0 needs 16.3 |
| `stellar` CLI | 27.0.0 | |

The target for the release candidate is `soroban-sdk` 28, which runs on
mainnet as it is today and on testnet.

## The first month contract has been archived

`CBPE37HQ6CHIKB7F3OFU2BIDAQOLB3QZD2DAO5Y6F6DKUSHLW2JZTX2S` was deployed on
2026-08-10 and nothing has extended its lifetime since. Fifty days later a
call as small as `is_frozen` simulates at 65,523,731 stroops, about 6.5 XLM,
with 15,960 bytes written, because the network has to restore the contract
code and instance before it can run. The payment that cost 33,660 stroops in
August now simulates at 66,111,678.

Nothing is lost, the state comes back when someone pays for the restore. But
this is the failure the lifetime work in the second month exists to prevent,
observed on our own contract rather than predicted, and on mainnet it would
have stopped every payment: see the fee ceiling in
[x402 compatibility](x402-compat.md).
