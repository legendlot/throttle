-- Docket — Dashboard sharing control.
-- Applied to Supabase lot-production as migration `docket_dashboard_sharing_v1` (2026-06-06).
-- Mirror kept here for repo record.
--
-- Decouples dashboard visibility from docket_view_all: a persistent global "public" flag
-- (docket.settings) + per-person grants (docket.dashboard_viewers, keyed on auth user_id
-- like space_members). Worker canViewDashboard = view_all OR public OR granted.
-- File 0004 (0003 is scratchpad). See
-- docs/superpowers/specs/2026-06-06-docket-dashboard-sharing-design.md + RULE-DOCKET-006.

-- 1. settings (key-value; extensible) ───────────────────────────────────────
create table docket.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid
);
insert into docket.settings (key, value) values ('dashboard_public', 'false'::jsonb)
  on conflict (key) do nothing;

-- 2. per-person dashboard grants (keys on auth user_id) ──────────────────────
create table docket.dashboard_viewers (
  user_id uuid primary key,
  granted_by_user_id uuid,
  granted_at timestamptz not null default now()
);

-- 3. RLS + grants (service_role only; RULE-RLS-001) ──────────────────────────
do $$
declare t text;
begin
  foreach t in array array['settings', 'dashboard_viewers'] loop
    execute format('alter table docket.%I enable row level security;', t);
    execute format('grant all on docket.%I to service_role;', t);
  end loop;
end $$;
