# Mainnet Supabase setup

The existing testnet project stays separate. The fresh mainnet project needs
the schema in [`supabase/migrations/20260930000000_mainnet_baseline.sql`](../../supabase/migrations/20260930000000_mainnet_baseline.sql).
`backend/.env.mainnet` currently has the mainnet project URL and service key;
those credentials do **not** grant SQL migration access. Keep that file local.

## Apply the baseline

1. Open the **new mainnet project** in Supabase SQL Editor. Confirm its project
   reference matches the `SUPABASE_URL` in `backend/.env.mainnet`.
2. Run the complete baseline migration once, in that project only. Keep the
   migration file in version control as the source of truth for later changes.
   SQL Editor does not record this file in Supabase CLI migration history. If
   CLI deployment is introduced later, reconcile the applied version before
   running a CLI push, or it will try to create these tables again.
3. In Table Editor, confirm `credentials`, `sessions`, and `transactions` exist
   and are empty. Confirm RLS is enabled on all three.
4. Run this read-only verification in SQL Editor:

   ```sql
   select c.relname as table_name, c.relrowsecurity as rls_enabled,
          has_table_privilege('anon', c.oid, 'SELECT') as anon_can_select,
          has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_can_select
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('credentials', 'sessions', 'transactions')
   order by c.relname;
   ```

   Expect three rows, `rls_enabled = true`, and both privilege columns `false`.

Do not copy testnet passkeys, sessions, or payment logs. Register a new owner
passkey at the final production origin; the mainnet contract has a new owner
identity and deployment record.

## Before connecting a mainnet backend

The baseline supports the current backend schema. It does not make the current
backend mainnet ready: the payment adapter still uses testnet constants, and
`GET /api/transactions` currently returns raw logs without authentication.
Close the mainnet readiness gates in the execution plan before serving the
backend on a public mainnet domain.

The planned chain event collector will get a separate migration when its event
and cursor format is implemented. This keeps the baseline limited to tables
the running backend already writes and reads.
