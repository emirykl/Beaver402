-- Beaver402 Supabase migration 005
--
-- Completed payments for a merchant built with @beaver402/merchant and
-- deployed where it has no lasting disk, such as Vercel. The unique
-- transaction hash and nonce are what stop one payment from unlocking two
-- responses. Same table as POSTGRES_SCHEMA in the package.
--
-- Runs after supabase-migration-004.sql. Safe to run more than once.

create table if not exists beaver402_settlements (
  tx_hash text primary key,
  nonce text not null unique,
  challenge_hash text not null,
  payer text not null,
  recipient text not null,
  asset text not null,
  amount text not null,
  network text not null,
  method text not null,
  url text not null,
  settled_at timestamptz not null,
  proof_transaction text
);

alter table beaver402_settlements enable row level security;
grant select, insert, update, delete on beaver402_settlements to service_role;
revoke all on beaver402_settlements from anon, authenticated;
