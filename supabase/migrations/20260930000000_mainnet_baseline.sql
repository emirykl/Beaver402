-- Beaver402 mainnet baseline. Apply only to the separate, empty mainnet project.
-- The backend is the only database client; public reads go through reviewed API routes.

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  credential_id text not null unique,
  public_key bytea not null,
  counter integer not null default 0,
  transports text[],
  created_at timestamptz not null default now()
);

create index credentials_user_id_idx on public.credentials (user_id);

create table public.sessions (
  id text primary key,
  authenticated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index sessions_expires_at_idx on public.sessions (expires_at);

create table public.transactions (
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
  created_at timestamptz not null default now()
);

create index transactions_created_at_idx on public.transactions (created_at desc);

alter table public.credentials enable row level security;
alter table public.sessions enable row level security;
alter table public.transactions enable row level security;

-- Supabase's service_role bypasses RLS. No anon/authenticated policies are
-- defined: passkeys, sessions and raw payment logs must stay server-side.
revoke all on table public.credentials, public.sessions, public.transactions
  from anon, authenticated;
grant select, insert, update, delete
  on table public.credentials, public.sessions, public.transactions
  to service_role;
