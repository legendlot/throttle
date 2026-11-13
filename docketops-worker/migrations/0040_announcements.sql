-- 0040 (docket_announcements_v1) — General-space rethink, P4 "Announcements".
-- General (retired in P3c, 0039) was the "everyone sees it" space; announcements take over that broadcast role.
--
-- docket.announcements        one post: title, body (plain text, line breaks kept), author, audience 'everyone' or
--                             'teams' (then ≥1 row in announcement_teams — the worker refuses an empty list), pinned,
--                             an optional expiry, archive. `slack` = the Slack mirror's per-channel results (written by
--                             the worker after the create; [] until then, and never on an edit).
-- docket.announcement_teams   the teams a 'teams' post goes to (podium.departments). A team row on an 'everyone' post
--                             is refused by announcement_teams_guard ('announcement_audience').
-- docket.announcement_seen    who has marked a post Seen (one row per post · login; the worker inserts on conflict do
--                             nothing, so a second "Seen" is a no-op).
--
-- Who may post / see / edit is the worker's rule (founders = docket_plan_admin; team heads =
-- podium.departments.head_employee_id, their own active teams only).
-- docket.settings.announcements — the Slack mirror, like slack_reminders (0031):
--   mode               'off' sends nothing · 'test' posts to NO channel, only DMs test_employee_ids (none by default =
--                      nothing is sent) the message plus the channel it would have gone to · 'live' posts to channels.
--   org_channel        the channel an everyone-post goes to (null = no mirror)
--   team_channels      { department_id: channel_id } — a team with none set gets no mirror
-- Seeded in 'test' with no recipients; an existing value (an admin's choice) is never overwritten.
-- Additive + idempotent (no begin/commit). RLS on, no policies, service_role only (the docket convention).

create table if not exists docket.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 5000),
  author_user_id uuid not null,
  author_employee_id uuid references podium.employees(id),
  audience text not null check (audience in ('everyone', 'teams')),
  pinned boolean not null default false,
  expires_at timestamptz,
  archived_at timestamptz,
  slack jsonb not null default '[]'::jsonb check (jsonb_typeof(slack) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists announcements_live_idx on docket.announcements (pinned desc, created_at desc) where archived_at is null;
create index if not exists announcements_author_idx on docket.announcements (author_user_id);

create table if not exists docket.announcement_teams (
  announcement_id uuid not null references docket.announcements(id) on delete cascade,
  department_id uuid not null references podium.departments(id),
  primary key (announcement_id, department_id)
);
create index if not exists announcement_teams_dept_idx on docket.announcement_teams (department_id);

create table if not exists docket.announcement_seen (
  announcement_id uuid not null references docket.announcements(id) on delete cascade,
  user_id uuid not null,
  seen_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
create index if not exists announcement_seen_user_idx on docket.announcement_seen (user_id);

-- A team row only on a 'teams' post.
create or replace function docket.announcement_teams_guard() returns trigger
language plpgsql set search_path = docket, public as $$
begin
  if exists (select 1 from docket.announcements a where a.id = new.announcement_id and a.audience <> 'teams') then
    raise exception 'announcement_audience: an everyone-post has no teams' using errcode = 'check_violation';
  end if;
  return new;
end $$;
revoke all on function docket.announcement_teams_guard() from public, anon, authenticated;
drop trigger if exists announcement_teams_guard on docket.announcement_teams;
create trigger announcement_teams_guard before insert or update on docket.announcement_teams
  for each row execute function docket.announcement_teams_guard();

alter table docket.announcements enable row level security;
alter table docket.announcement_teams enable row level security;
alter table docket.announcement_seen enable row level security;
revoke all on docket.announcements, docket.announcement_teams, docket.announcement_seen from public, anon, authenticated;
grant all on docket.announcements, docket.announcement_teams, docket.announcement_seen to service_role;

insert into docket.settings (key, value)
values ('announcements', '{"mode":"test","org_channel":null,"team_channels":{},"test_employee_ids":[]}'::jsonb)
on conflict (key) do nothing;

notify pgrst, 'reload schema';
