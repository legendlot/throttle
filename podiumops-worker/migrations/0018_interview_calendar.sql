-- Podium O3 — one-click Calendar scheduling. Plan: docs/superpowers/plans/2026-11-13-podium-o3-calendar.md
-- Applied as `podium_interview_calendar_v1`.

-- D2: off until the super-admin check proves the write SA's calendar.events delegation.
create table if not exists podium.calendar_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  checked_at timestamptz,
  checked_by uuid,
  checked_mailbox text,
  updated_at timestamptz not null default now()
);
insert into podium.calendar_settings default values on conflict (id) do nothing;

-- D5: one row per interview, claimed before any Google call.
create table if not exists podium.interview_calendar (
  interview_id uuid primary key references podium.interviews(id) on delete cascade,
  calendar_id text not null check (length(calendar_id) between 3 and 320),       -- the organiser's mailbox (primary calendar)
  organiser_employee_id uuid not null references podium.employees(id),
  -- Postgres caps regex repetition at 255 → length + class (v2 applied as `podium_interview_calendar_v2`).
  event_id text not null check (length(event_id) between 5 and 1024 and event_id ~ '^[a-v0-9]+$'),
  candidate_event_id text check (candidate_event_id is null or (length(candidate_event_id) between 5 and 1024 and candidate_event_id ~ '^[a-v0-9]+$')),
  candidate_email text check (candidate_email is null or length(candidate_email) <= 320),
  invite_candidate boolean not null default false,
  meet_url text check (meet_url is null or length(meet_url) <= 500),
  conference_id text check (conference_id is null or length(conference_id) <= 300),   -- set once a Meet exists (or is being created)
  time_zone text not null default 'Asia/Kolkata',
  state text not null default 'pending' check (state in ('pending', 'linked', 'cancelled')),
  candidate_state text check (candidate_state is null or candidate_state in ('pending', 'linked', 'cancelled')),
  synced_start timestamptz,       -- what Calendar held at the last sync (D7)
  synced_end timestamptz,
  synced_hash text,               -- the Podium fields last pushed (D6)
  last_error text check (last_error is null or length(last_error) <= 500),
  last_synced_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function podium.touch_interview_calendar() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists interview_calendar_touch on podium.interview_calendar;
create trigger interview_calendar_touch before update on podium.interview_calendar
  for each row execute function podium.touch_interview_calendar();
drop trigger if exists calendar_settings_touch on podium.calendar_settings;
create trigger calendar_settings_touch before update on podium.calendar_settings
  for each row execute function podium.touch_interview_calendar();

-- ── RLS: on, no policies; service_role only ──
do $$
declare t text;
begin
  foreach t in array array['calendar_settings', 'interview_calendar'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;
revoke all on function podium.touch_interview_calendar() from public, anon, authenticated;

-- O2 left a placeholder column; O3 keeps its state in interview_calendar instead.
comment on column podium.interviews.calendar_event_id is 'Unused (O2 placeholder). O3 calendar state lives in podium.interview_calendar.';
