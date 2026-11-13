-- 0038 (docket_team_home_spaces_v1) — General-space rethink, P3b "New defaults".
-- (1) spaces.home_department_id: a team's ONE home space (P3 decision: one space per team, owned by the team head,
--     shared with that team). It is where a create with no space lands when the caller can open it (worker
--     defaultTargetSpace), else the caller's Personal space. Never General / Founders' / personal.
-- (2) plan_template_apply takes the target space the caller picked (p_payload.space_id, validated by the worker
--     with canAccessSpace) instead of always General. A restricted theme still forces the Founders' space. The
--     body is edited IN PLACE (0034 / 0035 did the same), so 0028's text is stale for these lines too.

alter table docket.spaces add column if not exists home_department_id uuid references podium.departments(id);
alter table docket.spaces drop constraint if exists spaces_home_shape;
alter table docket.spaces add constraint spaces_home_shape
  check (home_department_id is null or (is_private and not is_default and not is_founders and not is_personal));
create unique index if not exists spaces_one_home_team on docket.spaces (home_department_id)
  where home_department_id is not null and archived_at is null;

do $m$
declare
  sig  regprocedure := 'docket.plan_template_apply(uuid,uuid,boolean,uuid,jsonb,text)'::regprocedure;
  def  text := pg_get_functiondef(sig);
  old1 text := E'    select s.id into v_space from docket.spaces s where s.is_default order by s.created_at limit 1;\n  end if;';
  new1 text := E'    -- 0038 (P3b): the space the caller picked (worker-validated); General only for an old caller that sends none\n'
            || E'    v_space := docket.plan_try_uuid(p_payload->>''space_id'');\n'
            || E'    if v_space is null then select s.id into v_space from docket.spaces s where s.is_default order by s.created_at limit 1; end if;\n'
            || E'  end if;';
  old2 text := 'if not exists (select 1 from docket.spaces s where s.id = v_space and (s.is_default or s.owner_user_id = p_actor';
  new2 text := 'if not exists (select 1 from docket.spaces s where s.id = v_space and s.archived_at is null and (s.is_default or s.owner_user_id = p_actor'
            || E'\n                   or (v_super and s.is_private and not s.is_default and not s.is_personal and not s.is_founders)';
begin
  if position('0038 (P3b)' in def) > 0 then return; end if;   -- already applied
  if position(old1 in def) = 0 then raise exception 'plan_template_apply General clause not found — re-read the live body'; end if;
  if position(old2 in def) = 0 then raise exception 'plan_template_apply space gate not found — re-read the live body'; end if;
  execute replace(replace(def, old1, new1), old2, new2);
end $m$;
revoke all on function docket.plan_template_apply(uuid,uuid,boolean,uuid,jsonb,text) from public, anon, authenticated;
grant execute on function docket.plan_template_apply(uuid,uuid,boolean,uuid,jsonb,text) to service_role;
