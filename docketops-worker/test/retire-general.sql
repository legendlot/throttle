-- 0039 (docket_retire_general_v1): General retired. The trigger refuses a task / record put into General (an insert
-- or a move in); dashboard_stats_spaces over two fixture spaces = the sum of dashboard_stats over each; grants are
-- service_role only (the trigger function not callable by anyone else); General is archived and empty; tasks.space_id
-- has no default. One DO block that always rolls back (ends by raising RESULT …). Run via execute_sql after 0039.
-- EXPECT: 1:task_ins=general_retired 2:task_move=general_retired 3:rec_ins=general_retired 4:rec_move=general_retired 5:dash=by_status_ok,sum_ok,c30=2,dept_open=3 6:grants_ok 7:general=archived,empty 8:no_default
do $rg$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';   -- an actor (created_by only)
  G uuid := (select id from docket.spaces where is_default limit 1);
  D uuid := (select id from podium.departments order by id limit 1);
  TM uuid := (select id from docket.checklist_templates order by created_at limit 1);
  S1 uuid; S2 uuid; T1 uuid; R1 uuid; j jsonb; a jsonb; b jsonb; out text := ''; dl timestamptz := now() + interval '30 days';
  fn text := 'docket.dashboard_stats_spaces(uuid[])';
begin
  insert into docket.spaces (name, is_private, is_default, owner_user_id, created_by_user_id) values ('ZZ rg one', true, false, A, A) returning id into S1;
  insert into docket.spaces (name, is_private, is_default, owner_user_id, created_by_user_id) values ('ZZ rg two', true, false, A, A) returning id into S2;
  -- S1: 2 not_started + 1 done; S2: 1 blocked + 1 done (+ 1 archived task, not counted)
  insert into docket.tasks (task_no, title, status, created_by_user_id, deadline, space_id, department_id) values
    (docket.next_task_seq(), 'ZZ rg a', 'not_started', A, dl, S1, D) returning id into T1;
  insert into docket.tasks (task_no, title, status, created_by_user_id, deadline, space_id, department_id) values
    (docket.next_task_seq(), 'ZZ rg b', 'not_started', A, dl, S1, D);
  insert into docket.tasks (task_no, title, status, completed_at, created_by_user_id, deadline, space_id, department_id) values
    (docket.next_task_seq(), 'ZZ rg c', 'done', now(), A, dl, S1, D),
    (docket.next_task_seq(), 'ZZ rg d', 'done', now(), A, dl, S2, D);
  insert into docket.tasks (task_no, title, status, created_by_user_id, deadline, space_id, department_id) values
    (docket.next_task_seq(), 'ZZ rg e', 'blocked', A, dl, S2, D);
  insert into docket.tasks (task_no, title, status, created_by_user_id, deadline, space_id, archived_at) values
    (docket.next_task_seq(), 'ZZ rg arch', 'in_progress', A, dl, S2, now());

  -- 1/2: a task into General — insert, and a move in
  begin insert into docket.tasks (task_no, title, created_by_user_id, deadline, space_id) values (docket.next_task_seq(), 'ZZ rg g', A, dl, G);
    out := out || '1:task_ins=ACCEPTED';
  exception when check_violation then out := out || '1:task_ins=' || split_part(sqlerrm, ':', 1); end;
  begin update docket.tasks set space_id = G where id = T1; out := out || ' 2:task_move=ACCEPTED';
  exception when check_violation then out := out || ' 2:task_move=' || split_part(sqlerrm, ':', 1); end;
  -- 3/4: a record into General — insert, and a move in
  insert into docket.checklist_records (template_id, title, space_id, created_by_user_id) values (TM, 'ZZ rg rec', S1, A) returning id into R1;
  begin insert into docket.checklist_records (template_id, title, space_id, created_by_user_id) values (TM, 'ZZ rg recg', G, A);
    out := out || ' 3:rec_ins=ACCEPTED';
  exception when check_violation then out := out || ' 3:rec_ins=' || split_part(sqlerrm, ':', 1); end;
  begin update docket.checklist_records set space_id = G where id = R1; out := out || ' 4:rec_move=ACCEPTED';
  exception when check_violation then out := out || ' 4:rec_move=' || split_part(sqlerrm, ':', 1); end;

  -- 5: the two spaces together = each one's dashboard_stats summed
  j := docket.dashboard_stats_spaces(array[S1, S2]);
  a := docket.dashboard_stats(S1); b := docket.dashboard_stats(S2);
  out := out || ' 5:dash=' || case when j->'by_status' = '{"not_started":2,"done":2,"blocked":1}'::jsonb then 'by_status_ok' else 'BY_STATUS=' || (j->'by_status')::text end
    || ',' || case when (j->>'completed_30d')::int = (a->>'completed_30d')::int + (b->>'completed_30d')::int
                    and (j->>'revised')::int = (a->>'revised')::int + (b->>'revised')::int
                    and (j->>'overdue')::int = (a->>'overdue')::int + (b->>'overdue')::int then 'sum_ok' else 'SUM_BAD' end
    || ',c30=' || (j->>'completed_30d')
    || ',dept_open=' || coalesce((select x->>'open' from jsonb_array_elements(j->'by_department') x where x->>'dept_id' = D::text), 'NONE');

  -- 6: service_role only; the trigger function not callable
  out := out || ' 6:' || case when has_function_privilege('service_role', fn, 'execute')
      and not has_function_privilege('anon', fn, 'execute') and not has_function_privilege('authenticated', fn, 'execute')
      and not has_function_privilege('anon', 'docket.general_retired_guard()', 'execute')
      and not has_function_privilege('authenticated', 'docket.general_retired_guard()', 'execute') then 'grants_ok' else 'GRANTS_BAD' end;
  -- 7: General archived and (outside this block's refused rows) empty
  out := out || ' 7:general=' || case when (select archived_at from docket.spaces where id = G) is not null then 'archived' else 'LIVE' end
    || ',' || case when not exists (select 1 from docket.tasks where space_id = G) and not exists (select 1 from docket.checklist_records where space_id = G)
                   then 'empty' else 'NOT_EMPTY' end;
  -- 8: tasks.space_id has no default
  out := out || ' 8:' || coalesce((select 'DEFAULT=' || column_default from information_schema.columns
    where table_schema = 'docket' and table_name = 'tasks' and column_name = 'space_id' and column_default is not null), 'no_default');

  raise exception 'RESULT %', out;
end $rg$;
