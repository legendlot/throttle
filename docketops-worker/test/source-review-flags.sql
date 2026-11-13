-- 0033 (docket_source_and_review_flags_v1): link / unlink / unblocked history rows carry the caller's source;
-- plan_proposals_for names an accepted item a review reader sees (level R), never one in a restricted theme.
-- One DO block that always rolls back (ends by raising RESULT …). All fixtures are rolled back.
-- EXPECT: 1:connector,connector 2:slack,slack 3:unb=1/connector 4:app,app 5:noR=null R=code 6:restricted=null 7:grants_ok
do $sr$
declare
  A uuid := gen_random_uuid(); M uuid := gen_random_uuid(); ME uuid := gen_random_uuid();
  SE uuid := (select id from podium.employees where status = 'active' order by id limit 1);   -- an owner must be a real employee
  G uuid := (select id from docket.spaces where is_default and archived_at is null limit 1);
  X uuid; Y uuid; Z uuid; L uuid; j jsonb; th uuid; tr uuid; p1 uuid; p2 uuid; rec record; out text := ''; c int;
begin
  insert into docket.tasks (task_no, title, created_by_user_id, space_id) values ('ZZ-SR-1', 'zz x', A, G) returning id into X;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id) values ('ZZ-SR-2', 'zz y', A, G) returning id into Y;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id) values ('ZZ-SR-3', 'zz z', A, G) returning id into Z;

  -- 1: add with 'connector' → both rows connector
  j := docket.add_task_link(X, Y, 'waiting_on', A, 'connector'); L := (j->>'link_id')::uuid;
  out := out || '1:' || (select string_agg(source, ',' order by task_id) from docket.task_history where event_type = 'link_added' and task_id in (X, Y));
  -- 2: remove with 'slack'
  perform docket.remove_task_link(L, A, 'slack');
  out := out || ' 2:' || (select string_agg(source, ',' order by task_id) from docket.task_history where event_type = 'link_removed' and task_id in (X, Y));
  -- 3: Y blocks X again; Y done → one unblocked row, connector
  perform docket.add_task_link(X, Y, 'waiting_on', A);
  update docket.tasks set status = 'done', completed_at = now() where id = Y;
  c := docket.log_unblocked(array[Y], A, 'connector');
  out := out || ' 3:unb=' || c || '/' || (select string_agg(source, ',') from docket.task_history where event_type = 'unblocked' and task_id = X);
  -- 4: the old call shape (no source) still works and stores 'app'
  perform docket.add_task_link(Z, X, 'relates', A);
  out := out || ' 4:' || (select string_agg(source, ',' order by task_id) from docket.task_history where event_type = 'link_added' and task_id = Z or (event_type = 'link_added' and task_id = X and new_value = Z::text));

  -- 5: an accepted proposal owned by someone else in an unrestricted theme: hidden at no level, named at R
  j := docket.plan_create(A, null, true, '{"kind":"theme","title":"ZZ sr theme"}'); th := (j->>'id')::uuid;
  j := docket.plan_create(A, null, true, '{"kind":"theme","title":"ZZ sr restricted","restricted":true}'); tr := (j->>'id')::uuid;
  j := docket.plan_propose(M, false, '{"title":"ZZ sr prop 1","why":"zz"}'); p1 := (j->>'id')::uuid;
  j := docket.plan_propose(M, false, '{"title":"ZZ sr prop 2","why":"zz"}'); p2 := (j->>'id')::uuid;
  j := docket.plan_proposal_decide(A, null, true, p1, jsonb_build_object('decision','accept','owner_employee_id',SE,'theme_id',th));
  out := out || case when (j->>'ok')::boolean then '' else ' DECIDE1_FAILED:' || j::text end;
  j := docket.plan_proposal_decide(A, null, true, p2, jsonb_build_object('decision','accept','owner_employee_id',SE,'theme_id',tr));
  out := out || case when (j->>'ok')::boolean then '' else ' DECIDE2_FAILED:' || j::text end;
  select * into rec from docket.plan_proposals_for(M, ME, false) x where x.id = p1;
  out := out || ' 5:noR=' || case when rec.status = 'accepted' then coalesce(rec.accepted_item_code, 'null') else 'NOT_ACCEPTED' end;
  select * into rec from docket.plan_proposals_for(M, ME, false, true) x where x.id = p1;
  out := out || ' R=' || case when rec.accepted_item_code is not null and rec.accepted_item_title = 'ZZ sr prop 1' then 'code' else 'MISSING' end;
  -- 6: a restricted theme stays hidden from R
  select * into rec from docket.plan_proposals_for(M, ME, false, true) x where x.id = p2;
  out := out || ' 6:restricted=' || case when rec.status = 'accepted' then coalesce(rec.accepted_item_code, 'null') else 'NOT_ACCEPTED' end;

  -- 7: one signature each, service_role only
  out := out || ' 7:' || case when (select count(*) from pg_proc p where p.pronamespace = 'docket'::regnamespace
      and p.proname in ('add_task_link', 'remove_task_link', 'log_unblocked', 'plan_proposals_for')) = 4
    and not exists (select 1 from pg_proc p where p.pronamespace = 'docket'::regnamespace
      and p.proname in ('add_task_link', 'remove_task_link', 'log_unblocked', 'plan_proposals_for')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
           or not has_function_privilege('service_role', p.oid, 'execute')))
    then 'grants_ok' else 'GRANTS_WRONG' end;

  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $sr$;
