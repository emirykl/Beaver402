-- Beaver402 Supabase migration 002
--
-- What the second month needs on top of supabase-migration.sql: state that
-- used to live in process memory, which a serverless host does not keep
-- between requests, the merchant's record of payments it has already
-- honoured, and the on-chain event log.
--
-- Runs after supabase-migration.sql. Safe to run more than once.
--
-- Nothing here is exposed to the anon or authenticated roles. The backend is
-- the only client and it connects with the secret key, so every table is
-- granted to service_role alone and row level security stays on with no
-- policies, which refuses everyone else outright.

-- ── Access for the tables migration 001 created ──────────────────
-- A project created without automatic exposure of new tables grants them to
-- nobody, the backend's own role included. The control panel never reads the
-- database directly, so the anonymous read on the payment log goes as well.

grant usage on schema public to service_role;

grant select, insert, update, delete on credentials, sessions, transactions to service_role;
revoke all on credentials, sessions, transactions from anon, authenticated;

drop policy if exists "transactions_anon_select" on transactions;

-- The payment log records which facilitator settled a payment and the
-- transaction that published its proof of intent afterwards.
alter table transactions add column if not exists facilitator text;
alter table transactions add column if not exists proof_tx_hash text;

create index if not exists idx_transactions_created_at on transactions (created_at desc);

-- ── Passkey ceremonies in progress ───────────────────────────────
-- The challenge issued at the start of a registration or sign in, kept
-- until the browser comes back with the answer. One per user, replaced by
-- the next ceremony, and useless after it expires.

create table if not exists webauthn_challenges (
  user_id text primary key,
  challenge text not null,
  expires_at timestamptz not null default (now() + interval '5 minutes')
);

-- ── Rate limiting ────────────────────────────────────────────────
-- One row per caller and route, counted inside a fixed window.

create table if not exists rate_limits (
  key text primary key,
  count integer not null,
  reset_at timestamptz not null
);

-- Count one attempt and say whether it is allowed, in a single statement so
-- two requests arriving together cannot both read the old count.
create or replace function hit_rate_limit(p_key text, p_window_ms integer, p_max integer)
returns table (allowed boolean, retry_after_seconds integer)
language sql
as $$
  insert into rate_limits as r (key, count, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_ms / 1000.0))
  on conflict (key) do update set
    count = case when r.reset_at < now() then 1 else r.count + 1 end,
    reset_at = case when r.reset_at < now()
      then now() + make_interval(secs => p_window_ms / 1000.0)
      else r.reset_at end
  returning
    r.count <= p_max,
    greatest(0, ceil(extract(epoch from (r.reset_at - now()))))::integer;
$$;

revoke all on function hit_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function hit_rate_limit(text, integer, integer) to service_role;

-- ── Payments the merchant has honoured ───────────────────────────
-- A settled transaction unlocks the resource once. The hash and the nonce
-- are both unique, so neither a replayed payment response nor a second
-- settlement of the same challenge can unlock it again.

create table if not exists settled_payments (
  tx_hash text primary key,
  nonce text not null unique,
  challenge_hash text not null,
  network text not null,
  payer text not null,
  recipient text not null,
  asset text not null,
  amount text not null,
  facilitator text,
  proof_tx_hash text,
  settled_at timestamptz not null default now()
);

-- ── On-chain events ──────────────────────────────────────────────
-- What the collector reads from the network: the policy account's own
-- events and the token transfers it took part in. Only public ledger data
-- is stored here, never request content, signatures or keys.

create table if not exists chain_events (
  id text primary key,
  network text not null,
  contract_id text not null,
  ledger integer not null,
  ledger_closed_at timestamptz,
  tx_hash text not null,
  event_type text not null,
  topics jsonb not null,
  data jsonb,
  collected_at timestamptz not null default now()
);

create index if not exists idx_chain_events_ledger on chain_events (network, ledger desc);
create index if not exists idx_chain_events_type on chain_events (network, event_type);

-- Where the collector stopped, so a run picks up from there, and how the
-- last run went, so a missed one is visible.
create table if not exists collector_state (
  network text primary key,
  cursor text,
  last_ledger integer,
  last_run_at timestamptz,
  last_error text
);

-- ── Access for the new tables ────────────────────────────────────

alter table webauthn_challenges enable row level security;
alter table rate_limits enable row level security;
alter table settled_payments enable row level security;
alter table chain_events enable row level security;
alter table collector_state enable row level security;

grant select, insert, update, delete
  on webauthn_challenges, rate_limits, settled_payments, chain_events, collector_state
  to service_role;

revoke all
  on webauthn_challenges, rate_limits, settled_payments, chain_events, collector_state
  from anon, authenticated;
