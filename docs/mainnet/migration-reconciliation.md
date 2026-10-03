# Mainnet Supabase migration reconciliation — 2 October 2026

This is a source review and read-only remote inventory. It does not assert
which SQL files were run in the Supabase SQL Editor. Keep the testnet and
mainnet projects separate; never run another migration solely because its
filename does not appear in Supabase CLI history.

| Source | Objects it supplies | Mainnet interpretation |
|---|---|---|
| `supabase/migrations/20260930000000_mainnet_baseline.sql` | `credentials`, `sessions`, `transactions`; RLS and private role grants | Versioned mainnet starting point; run once on an empty project. |
| `scripts/supabase-migration.sql` | Same first three tables, legacy policies | Alternative first migration for the original testnet project. Do **not** run after the versioned baseline. Its `transactions_anon_select` policy exposes raw payment rows until migration 002 removes it. Its `create policy` statements also make the whole file unsafe to rerun despite the older operating guide's general claim. |
| `scripts/supabase-migration-002.sql` | `webauthn_challenges`, `rate_limits`, `settled_payments`, `chain_events`, `collector_state`; `hit_rate_limit`; two transaction fields; private grants and removal of the legacy anon policy | Applicable after either first migration. It uses `IF NOT EXISTS` / `OR REPLACE` for objects, but still verify remote state before any rerun. |
| `scripts/supabase-migration-003.sql` | `page_metrics`, `count_page_metric`; private grants | Applicable after 002. |

The baseline and legacy first migration have the same core columns, but the
baseline makes several fields `NOT NULL` that the legacy file leaves nullable.
They also name the first three indexes differently, so running 002 after the
baseline may add a redundant `transactions(created_at desc)` index. This is a
storage/performance cleanup item, not proof of a missing table. Do not drop an
index during this verification.

On 2 October, read-only service-role `HEAD` checks found all nine expected
tables present and empty in the configured mainnet project. That supports the
object inventory, not the migration history or permissions. The next read-only
step is to run [the SQL Editor verification](supabase-verification.sql) in that
project and save the nine table RLS/privilege results, policies, two function
permissions and extra transaction columns. If any anonymous or authenticated
role can read or write these objects, close that finding before the mainnet
backend is exposed. Record the actual SQL Editor run history separately if it
is available from the project owner.

The current [mainnet setup note](supabase.md) describes only the three-table
baseline and is incomplete for the current backend. The [operating guide](../operations/operating-guide.md)
lists the legacy `001 → 002 → 003` path for all networks. For this mainnet
project, the source sequence is **versioned baseline → 002 → 003**; for an old
testnet project, the legacy sequence may already have been applied. Before a
future CLI `db push`, reconcile any SQL Editor changes with the CLI migration
ledger so the baseline is not replayed on populated tables.
