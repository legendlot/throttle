-- 0035 (docket_space_teams_guard_v1) — hostile review of 0034: the "never the Founders' space, never General" rule
-- lived only in the worker's share action. Enforce it in the table, and make plan_template_apply's team clause
-- ignore the Founders' space too (its only other target is General, which passes on is_default anyway), so a
-- stray row can never open the Founders' space to a whole team.

create or replace function docket.space_teams_guard() returns trigger
language plpgsql set search_path = docket, public as $$
declare v_founders boolean; v_default boolean;
begin
  select s.is_founders, s.is_default into v_founders, v_default from docket.spaces s where s.id = new.space_id;
  if coalesce(v_founders, false) then raise exception 'founders_space: the Founders'' space is never team-shared'; end if;
  if coalesce(v_default, false) then raise exception 'general_is_system: General is not team-shared'; end if;
  return new;
end $$;
revoke all on function docket.space_teams_guard() from public, anon, authenticated;

drop trigger if exists space_teams_guard on docket.space_teams;
create trigger space_teams_guard before insert or update on docket.space_teams
  for each row execute function docket.space_teams_guard();

do $m$
declare
  sig  regprocedure := 'docket.plan_template_apply(uuid,uuid,boolean,uuid,jsonb,text)'::regprocedure;
  def  text := pg_get_functiondef(sig);
  old  text := 'where st.space_id = s.id and e.auth_user_id = p_actor';
  neu  text := 'where st.space_id = s.id and not s.is_founders and e.auth_user_id = p_actor';
begin
  if position(neu in def) > 0 then return; end if;   -- already applied
  if position(old in def) = 0 then raise exception 'plan_template_apply 0034 clause not found — re-read the live body'; end if;
  execute replace(def, old, neu);
end $m$;
