-- 0036 (docket_personal_spaces_v1) — General-space rethink, P2 "Defaults".
-- Every login gets ONE personal space ("Personal"): private, only them, never shared (no other member, no team),
-- never archived, never the Founders' space. It is created on first use (docket.ensure_personal_space, called by
-- the worker from getMe), not backfilled for people who never open Docket. Only work that is just the owner's may be
-- MOVED in (worker rule). A create with no space still goes to General: routing those here waits for P3 (hostile
-- review 2026-11-13 — a personal space would hide a task from a later owner / receiver / collaborator).

alter table docket.spaces add column if not exists is_personal boolean not null default false;
alter table docket.spaces drop constraint if exists spaces_personal_shape;
alter table docket.spaces add constraint spaces_personal_shape
  check (not is_personal or (is_private and not is_default and not is_founders and owner_user_id is not null));
create unique index if not exists spaces_one_personal on docket.spaces (owner_user_id) where is_personal and archived_at is null;

-- The existing one-person "Personal" space (Afshaan's, created by hand S457-era) becomes his personal space, so
-- he doesn't get a second one. Only a live, private, non-Founders space named exactly 'Personal' whose only
-- member is its owner, and only if that owner has no personal space yet.
update docket.spaces s set is_personal = true
 where s.name = 'Personal' and s.is_private and not s.is_default and not s.is_founders and s.archived_at is null
   and s.owner_user_id is not null
   and not exists (select 1 from docket.space_members m where m.space_id = s.id and m.user_id <> s.owner_user_id)
   and not exists (select 1 from docket.spaces p where p.is_personal and p.archived_at is null and p.owner_user_id = s.owner_user_id)
   and s.id = (select s2.id from docket.spaces s2 where s2.name = 'Personal' and s2.owner_user_id = s.owner_user_id
                 and s2.is_private and s2.archived_at is null and not s2.is_founders order by s2.created_at limit 1);

-- Nobody but the owner is ever a member of a personal space.
create or replace function docket.space_members_personal_guard() returns trigger
language plpgsql set search_path = docket, public as $$
begin
  if exists (select 1 from docket.spaces s where s.id = new.space_id and s.is_personal and s.owner_user_id is distinct from new.user_id) then
    raise exception 'personal_space: a personal space has no other members';
  end if;
  return new;
end $$;
revoke all on function docket.space_members_personal_guard() from public, anon, authenticated;
drop trigger if exists space_members_personal_guard on docket.space_members;
create trigger space_members_personal_guard before insert or update on docket.space_members
  for each row execute function docket.space_members_personal_guard();

-- No team ever gets a personal space (0035's guard, widened).
create or replace function docket.space_teams_guard() returns trigger
language plpgsql set search_path = docket, public as $$
declare v_founders boolean; v_default boolean; v_personal boolean;
begin
  select s.is_founders, s.is_default, s.is_personal into v_founders, v_default, v_personal from docket.spaces s where s.id = new.space_id;
  if coalesce(v_founders, false) then raise exception 'founders_space: the Founders'' space is never team-shared'; end if;
  if coalesce(v_default, false) then raise exception 'general_is_system: General is not team-shared'; end if;
  if coalesce(v_personal, false) then raise exception 'personal_space: a personal space is never team-shared'; end if;
  return new;
end $$;

-- The caller's personal space id, created (with its owner membership + a history row) if they have none.
-- Safe under a race: the partial unique index decides, the loser reads the winner's row.
create or replace function docket.ensure_personal_space(p_user uuid) returns uuid
language plpgsql security definer set search_path = docket, public as $$
declare v_id uuid;
begin
  if p_user is null then return null; end if;
  select id into v_id from docket.spaces where is_personal and archived_at is null and owner_user_id = p_user;
  if v_id is not null then return v_id; end if;
  insert into docket.spaces (name, is_private, is_default, is_founders, is_personal, owner_user_id, created_by_user_id)
  values ('Personal', true, false, false, true, p_user, p_user)
  on conflict (owner_user_id) where is_personal and archived_at is null do nothing
  returning id into v_id;
  if v_id is null then   -- lost a race
    select id into v_id from docket.spaces where is_personal and archived_at is null and owner_user_id = p_user;
    return v_id;
  end if;
  insert into docket.space_members (space_id, user_id, added_by_user_id) values (v_id, p_user, p_user) on conflict do nothing;
  insert into docket.space_history (space_id, actor_user_id, action, note) values (v_id, p_user, 'created', 'personal space (auto)');
  return v_id;
end $$;
revoke all on function docket.ensure_personal_space(uuid) from public, anon, authenticated;
grant execute on function docket.ensure_personal_space(uuid) to service_role;
