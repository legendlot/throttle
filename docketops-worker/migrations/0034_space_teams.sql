-- 0034 (docket_space_teams_v1) — General-space rethink, P1 "Sharing".
-- A private space can now be shared with a whole TEAM (a podium department) as well as with named people
-- (space_members). Every live member of a shared team reads and works in the space exactly like a member;
-- management (rename, members, teams, transfer, archive) stays owner-only. The Founders' space and General
-- are never team-shared (worker-enforced: founders_space / general_is_system).
-- Team = podium.employees.department_id of the caller's linked login, not exited — the same field the
-- worker's auth.departmentId reads.

create table if not exists docket.space_teams (
  space_id         uuid not null references docket.spaces(id) on delete cascade,
  department_id    uuid not null,
  added_by_user_id uuid,
  added_at         timestamptz not null default now(),
  primary key (space_id, department_id)
);
create index if not exists space_teams_department_idx on docket.space_teams (department_id);
alter table docket.space_teams enable row level security;   -- no policies: service_role only, like space_members
revoke all on docket.space_teams from anon, authenticated;
grant all on docket.space_teams to service_role;

-- plan_template_apply is the one SQL function that checks space access itself (everything else takes the
-- worker's p_member_space_ids). Widen its check by exactly one clause, in place, so the rest of the body is
-- untouched; fail loudly if the anchor text has drifted.
do $m$
declare
  sig  regprocedure := 'docket.plan_template_apply(uuid,uuid,boolean,uuid,jsonb,text)'::regprocedure;
  def  text := pg_get_functiondef(sig);
  old  text := 'or exists (select 1 from docket.space_members m where m.space_id = s.id and m.user_id = p_actor))) then';
  neu  text := 'or exists (select 1 from docket.space_members m where m.space_id = s.id and m.user_id = p_actor)'
            || E'\n                   or exists (select 1 from docket.space_teams st join podium.employees e on e.department_id = st.department_id'
            || E'\n                              where st.space_id = s.id and e.auth_user_id = p_actor and e.status <> ''exited''))) then';
begin
  if position('docket.space_teams' in def) > 0 then return; end if;   -- already applied
  if position(old in def) = 0 then raise exception 'plan_template_apply anchor not found — re-read the live body'; end if;
  execute replace(def, old, neu);
end $m$;
