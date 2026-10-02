-- Beaver402 Supabase migration 003
--
-- Traffic for the landing page, counted the way the customer development
-- plan promises: without cookies and without recording who visited. Each row
-- is a daily total for one page and one kind of interaction, nothing more.
--
-- Runs after supabase-migration-002.sql. Safe to run more than once.

create table if not exists page_metrics (
  day date not null,
  path text not null,
  -- view: the page was shown. click: an outbound link on it was followed.
  kind text not null,
  -- Which link, for clicks. Empty for views.
  target text not null default '',
  count integer not null default 0,
  primary key (day, path, kind, target)
);

alter table page_metrics enable row level security;
grant select, insert, update, delete on page_metrics to service_role;
revoke all on page_metrics from anon, authenticated;

-- Add one to today's total, in a single statement so concurrent visits are
-- all counted.
create or replace function count_page_metric(p_path text, p_kind text, p_target text)
returns void
language sql
as $$
  insert into page_metrics as m (day, path, kind, target, count)
  values (current_date, p_path, p_kind, coalesce(p_target, ''), 1)
  on conflict (day, path, kind, target) do update set count = m.count + 1;
$$;

revoke all on function count_page_metric(text, text, text) from public, anon, authenticated;
grant execute on function count_page_metric(text, text, text) to service_role;
