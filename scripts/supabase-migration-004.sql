-- Beaver402 Supabase migration 004
--
-- Operator alerts for the event collector. One row per incident: a failed
-- run, or a stretch of ledgers that left the RPC window before they were
-- read. The row is what stops the same incident from being emailed again on
-- every run, and it records when the incident cleared.
--
-- Runs after supabase-migration-003.sql. Safe to run more than once.

create table if not exists ops_alerts (
  -- What the incident is about, such as collector_failed or
  -- ledger_gap:1200-1450. One open incident per key.
  key text primary key,
  network text not null,
  kind text not null,
  -- The summary the email carried. Never a raw provider error.
  detail text not null,
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- How many runs found it again after the email went out.
  repeats integer not null default 0,
  emailed_at timestamptz,
  resolved_at timestamptz
);

alter table ops_alerts enable row level security;
grant select, insert, update, delete on ops_alerts to service_role;
revoke all on ops_alerts from anon, authenticated;
