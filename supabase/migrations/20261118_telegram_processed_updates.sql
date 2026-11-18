-- Run once in the Supabase SQL editor before deploying this branch.
-- update_id must be unique for concurrent webhook requests.
create table if not exists public.telegram_processed_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);

-- Also protect an older table that was created without a unique constraint.
-- If duplicate rows already exist, remove them before creating the index.
create unique index if not exists telegram_processed_updates_update_id_unique
  on public.telegram_processed_updates (update_id);

-- The server-side Supabase key must have INSERT permission on this table.
-- Never expose SUPABASE_SECRET_KEY to a client.
