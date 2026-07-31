-- Beaver402 Supabase Migration
-- Run this in the Supabase SQL Editor to create tables and RLS policies.

-- 1. credentials: passkey credential storage
create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  credential_id text unique not null,
  public_key bytea not null,
  counter integer default 0,
  transports text[],
  created_at timestamptz default now()
);

create index if not exists idx_credentials_user_id on credentials (user_id);

-- 2. sessions: authenticated session storage
create table if not exists sessions (
  id text primary key,
  authenticated_at timestamptz default now(),
  expires_at timestamptz default (now() + interval '24 hours')
);

-- 3. transactions: payment audit log
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  tx_hash text,
  challenge_hash text,
  intent_hash text,
  merchant_pubkey text,
  recipient text,
  asset text,
  amount text,
  network text,
  status text,
  error text,
  created_at timestamptz default now()
);

-- RLS policies

-- credentials: service_role only
alter table credentials enable row level security;

create policy "credentials_service_select" on credentials
  for select using (auth.role() = 'service_role');

create policy "credentials_service_insert" on credentials
  for insert with check (auth.role() = 'service_role');

create policy "credentials_service_update" on credentials
  for update using (auth.role() = 'service_role');

create policy "credentials_service_delete" on credentials
  for delete using (auth.role() = 'service_role');

-- sessions: service_role only
alter table sessions enable row level security;

create policy "sessions_service_select" on sessions
  for select using (auth.role() = 'service_role');

create policy "sessions_service_insert" on sessions
  for insert with check (auth.role() = 'service_role');

create policy "sessions_service_update" on sessions
  for update using (auth.role() = 'service_role');

create policy "sessions_service_delete" on sessions
  for delete using (auth.role() = 'service_role');

-- transactions: service_role insert, anon can read
alter table transactions enable row level security;

create policy "transactions_service_insert" on transactions
  for insert with check (auth.role() = 'service_role');

create policy "transactions_anon_select" on transactions
  for select using (true);
