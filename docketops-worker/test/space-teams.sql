-- 0034 + 0035 (docket_space_teams_v1 / _guard_v1): team shares in the table and in plan_template_apply's gate.
-- Template tasks land in General (open) or the Founders' space, which is NEVER team-shared: the trigger refuses
-- the row, and the gate's team clause ignores the Founders' space even if a row got in (the trigger is disabled
-- inside the rollback to prove it). One DO block that always rolls back (ends by raising RESULT …).
-- EXPECT: 1:forbidden_space 2:trig=founders_space,general_is_system,private_ok 3:stray=forbidden_space 4:rls=t,anon=f,svc=t
do $st$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';     -- a super actor (saves the template)
  L uuid; D uuid; E1 uuid;   -- L = a real login outside the Founders' space; E1 = the template's role holder
  FS uuid := (select id from docket.spaces where is_founders and archived_at is null limit 1);
  G uuid := (select id from docket.spaces where is_default limit 1);
  P uuid; thr uuid; tf uuid; j jsonb; out text := ''; today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select e.auth_user_id, e.department_id into L, D from podium.employees e
   where e.status = 'active' and e.auth_user_id is not null and e.department_id is not null
     and not exists (select 1 from docket.space_members m where m.space_id = FS and m.user_id = e.auth_user_id)
     and not exists (select 1 from docket.spaces s where s.id = FS and s.owner_user_id = e.auth_user_id)
   order by e.id limit 1;
  E1 := (select id from podium.employees where status = 'active' and auth_user_id is distinct from L order by id limit 1);
  thr := (docket.plan_create(A, null, true, '{"kind":"theme","title":"ZZ st restricted","restricted":true}')->>'id')::uuid;
  tf := (docket.plan_template_save(A, null, true, '{"name":"zz st tpl","audience":"founders","nodes":[
    {"key":"m","kind":"milestone","title":"zz st ms","role_label":"Lead","offset_days":10,"done_when":"d"}]}')->>'id')::uuid;

  -- 1: not in the Founders' space → refused
  j := docket.plan_template_apply(L, null, true, tf, jsonb_build_object('anchor_id', thr, 'anchor_date', today, 'roles', jsonb_build_object('lead', E1)));
  out := out || '1:' || coalesce(j->>'code', 'OK');
  -- 2: the trigger refuses Founders' and General rows; a plain private space takes one
  out := out || ' 2:trig=';
  begin insert into docket.space_teams (space_id, department_id) values (FS, D); out := out || 'ACCEPTED';
  exception when others then out := out || split_part(sqlerrm, ':', 1); end;
  begin insert into docket.space_teams (space_id, department_id) values (G, D); out := out || ',ACCEPTED';
  exception when others then out := out || ',' || split_part(sqlerrm, ':', 1); end;
  insert into docket.spaces (name, is_private, is_default, owner_user_id, created_by_user_id) values ('ZZ st private', true, false, A, A) returning id into P;
  insert into docket.space_teams (space_id, department_id) values (P, D);
  out := out || ',' || case when exists (select 1 from docket.space_teams where space_id = P) then 'private_ok' else 'PRIVATE_MISSING' end;
  -- 3: a stray Founders' row (trigger off) still opens nothing through the gate
  alter table docket.space_teams disable trigger space_teams_guard;
  insert into docket.space_teams (space_id, department_id) values (FS, D);
  alter table docket.space_teams enable trigger space_teams_guard;
  j := docket.plan_template_apply(L, null, true, tf, jsonb_build_object('anchor_id', thr, 'anchor_date', today, 'roles', jsonb_build_object('lead', E1)));
  out := out || ' 3:stray=' || coalesce(j->>'code', 'OK');
  -- 4: service_role only
  out := out || ' 4:rls=' || (select relrowsecurity::text from pg_class where oid = 'docket.space_teams'::regclass)
    || ',anon=' || has_table_privilege('anon', 'docket.space_teams', 'select')::text
    || ',svc=' || has_table_privilege('service_role', 'docket.space_teams', 'select')::text;
  out := replace(replace(out, 'true', 't'), 'false', 'f');
  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $st$;
