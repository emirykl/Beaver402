# Risk register

What could stop the pilot or go wrong in it, and what is done about each.
Updated as risks are retired or found.

| # | Risk | Effect | Status | What is done |
|---|---|---|---|---|
| R1 | The facilitator refuses any event besides the transfer | no payment can settle | **retired** | the account emits nothing while authorizing; the proof is published afterwards |
| R2 | The payment fee exceeds the facilitator's ceiling | no payment can settle | **retired**, measured at 38,411 of 50,000 | payments create no entry, grow no entry and extend nothing |
| R3 | The hosted facilitator rejects a contract account as payer, or the custom signature | no payment can settle | **retired** | the hosted OpenZeppelin facilitator settled the whole testnet rehearsal |
| R4 | The account gets archived | payments stop, fees jump | mitigated | every non-payment call extends it; `extend_ttl`; status page shows the lifetime |
| R5 | A request changed in its query or path case still matches | request mutation undetected | **retired** | encoding version 2 |
| R6 | The velocity limit is exceeded at a window boundary or by the payment that reaches it | more spent than promised | **retired** | sliding window, total checked including the payment |
| R7 | Freezing and resuming resets the limit | more spent than promised | **retired** | the window is kept across freezes |
| R8 | The merchant releases content on an unverified claim of payment | resource given away | **retired** | the merchant checks the ledger itself and records each settlement once |
| R9 | The agent route is reachable by anyone | anyone can spend up to the limits | **retired** | token and merchant allowlist, required on mainnet |
| R10 | A phished passkey assertion | an attacker acts as owner | **retired** | relying party hash and user verification checked on chain |
| R11 | RPC drops events before they are collected | gaps in the record | mitigated | collector runs daily and by hand; gaps are reported |
| R12 | The domain the passkey belongs to changes | owner locked out | mitigated | domain fixed before deployment; changing it is a migration |
| R13 | Mainnet protocol changes during the pilot | different behaviour | open preflight | testnet RPC reported protocol 29 on 2 October; mainnet RPC version and network identity must be measured before deploy, then scenarios rerun after any upgrade |
| R14 | The external reviewer is late | the release waits | open | review brief prepared early |
| R15 | The token balance entry expires | balance unreachable until restored | accepted | at least 120 days on mainnet, longer than the pilot |
| R16 | High advisories in production dependencies | exploitable backend | **retired** | axios overridden, audits clean, audits in CI |
| R17 | Collector diagnostics expose a provider credential | secret can appear on public status or in hosted logs | open, mainnet blocker | [I15](../security/findings.md): normalize existing database error rows on read, sanitize hosted logs and verify a canary through public routes before go |
| R18 | Mainnet Supabase migration or permissions differ from source | private tables may be public or backend operations may fail | open preflight | nine tables are readable by service role; [migration paths reconciled](migration-reconciliation.md), [read-only RLS/privilege query](supabase-verification.sql) awaiting SQL Editor output |
