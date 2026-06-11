-- Docket — user activity / "last seen". Applied as migration `docket_user_activity_v1` (2026-06-12, S124).
-- Mirror kept here for repo record.
--
-- There is no login/page-view log today (verifyJWT writes nothing; Supabase auth audit is pruned).
-- This stamps a per-user last_seen_at on each app load (getMe) + every mutation (POST), so the
-- founder Dashboard can show "last seen …" against each person. One row per user, upserted.
create table if not exists docket.user_activity (
  user_id uuid primary key,
  last_seen_at timestamptz not null default now()
);
alter table docket.user_activity enable row level security;
grant all on docket.user_activity to service_role;
