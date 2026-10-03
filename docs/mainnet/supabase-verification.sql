-- Read-only mainnet Supabase verification. Run in the SQL Editor of the
-- separate mainnet project; save the results without any row data or secrets.
-- The baseline plus migrations 002 and 003 should produce nine tables.

with expected(name) as (
  values
    ('credentials'), ('sessions'), ('transactions'),
    ('webauthn_challenges'), ('rate_limits'), ('settled_payments'),
    ('chain_events'), ('collector_state'), ('page_metrics')
)
select e.name as table_name,
       c.oid is not null as exists,
       coalesce(c.relrowsecurity, false) as rls_enabled,
       case when c.oid is null then null else
         has_table_privilege('service_role', c.oid, 'SELECT') and
         has_table_privilege('service_role', c.oid, 'INSERT') and
         has_table_privilege('service_role', c.oid, 'UPDATE') and
         has_table_privilege('service_role', c.oid, 'DELETE')
       end as service_role_can_use,
       case when c.oid is null then null else has_table_privilege('anon', c.oid, 'SELECT') end as anon_can_select,
       case when c.oid is null then null else
         has_table_privilege('anon', c.oid, 'INSERT') or
         has_table_privilege('anon', c.oid, 'UPDATE') or
         has_table_privilege('anon', c.oid, 'DELETE')
       end as anon_can_write,
       case when c.oid is null then null else has_table_privilege('authenticated', c.oid, 'SELECT') end as authenticated_can_select,
       case when c.oid is null then null else
         has_table_privilege('authenticated', c.oid, 'INSERT') or
         has_table_privilege('authenticated', c.oid, 'UPDATE') or
         has_table_privilege('authenticated', c.oid, 'DELETE')
       end as authenticated_can_write
from expected e
left join pg_namespace n on n.nspname = 'public'
left join pg_class c on c.relnamespace = n.oid and c.relname = e.name and c.relkind in ('r', 'p')
order by e.name;

-- Anonymous or authenticated policies should not exist on these private tables.
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in (
    'credentials', 'sessions', 'transactions', 'webauthn_challenges',
    'rate_limits', 'settled_payments', 'chain_events', 'collector_state',
    'page_metrics'
  )
order by tablename, policyname;

-- The two database functions should exist and only service_role should be
-- able to execute them. These queries do not invoke either function.
with expected(signature) as (
  values
    ('public.hit_rate_limit(text,integer,integer)'),
    ('public.count_page_metric(text,text,text)')
)
select signature,
       to_regprocedure(signature) is not null as exists,
       has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE') as service_role_can_execute,
       has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE') as authenticated_can_execute
from expected
order by signature;

-- Migration 002 adds both fields to the payment log. Only column names are
-- returned; no payment rows are read.
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'transactions'
  and column_name in ('facilitator', 'proof_tx_hash')
order by column_name;
