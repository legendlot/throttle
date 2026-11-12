-- F9 R5 (migrations 0021 + 0022 + 0023) — the deadline RPC, the cohort, open/close and week_score, run against
-- the LIVE database in one DO block that always rolls back (it ends by raising RESULT …). Run via
-- execute_sql; every token must match EXPECT. Leaves 0 rows. A = Afshaan (actor). G = General.
-- Times are relative to the current week, so it runs any day (not within ~2 minutes of a week boundary).
-- EXPECT (k6 = created already done → entry created_done, on time even past its deadline):
--   1:first_commitment 2:none 3:first_commitment 4:set-hist-ok 5:reason_required 6:revised-ok
--   7:still-in 8:none 9:no-hist 10:noop 11:abandoned-untouched 12:frozen-team
--   13:[k1/due,k2/on_time,k5/miss/open,k6/on_time,k7/miss/abandoned] 13b:created_done 14:0 15:week_not_started
--   16:week_not_over 17:[k10/miss/done_late,k8/miss/open,k9/on_time] 18:final-pct-ok 19:week_closed 20:0
--   21:deadline_via_rpc 22:deadline_immutable 23:rpc-ok
do $$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';
  G uuid := 'be65c92f-8896-42fa-b251-6da9f1af521a';
  D1 uuid := (select id from podium.departments order by name limit 1);            -- any two real teams
  D2 uuid := (select id from podium.departments order by name offset 1 limit 1);
  WE date := docket.week_end_at(now()); S timestamptz; CUT timestamptz;
  inw timestamptz; pastw timestamptz; nextw timestamptz; lastw timestamptz; LE date;
  k1 uuid; k2 uuid; k3 uuid; k4 uuid; k5 uuid; k6 uuid; k7 uuid; k8 uuid; k9 uuid; k10 uuid; ks uuid;
  j jsonb; out text := ''; c int; agg text; v text; TODAY date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select starts_at, cutoff_at into S, CUT from docket.weeks where week_end = WE;
  if S is null then raise exception 'RESULT current week not open'; end if;
  inw := now() + (CUT - now()) / 2; pastw := S + (now() - S) / 2;
  nextw := CUT + interval '1 day'; LE := WE - 7 * 104; lastw := docket.ist_midnight(LE - 3) + interval '12 hours';   -- a week long before R5: never opened

  -- 1: created with a deadline inside the week → enters as a first commitment
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline, department_id)
  values ('ZZS-1', 'zz', A, G, inw, D1) returning id into k1;
  select entry_reason into v from docket.week_commitments where week_end = WE and task_id = k1;
  out := out || '1:' || coalesce(v, 'none') || ' ';
  -- 2: a sub-task never enters
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline, parent_task_id)
  values ('ZZS-2', 'zz', A, G, inw, k1) returning id into ks;
  select entry_reason into v from docket.week_commitments where week_end = WE and task_id = ks;
  out := out || '2:' || coalesce(v, 'none') || ' ';
  -- 3-4: an undated task gets its first deadline through the RPC → enters; history written in the same txn
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, department_id) values ('ZZS-3', 'zz', A, G, D2) returning id into k2;
  j := docket.task_set_deadline(A, array[k2], inw, null);
  select entry_reason into v from docket.week_commitments where week_end = WE and task_id = k2;
  out := out || '3:' || coalesce(v, 'none') || ' ';
  select count(*) into c from docket.task_history where task_id = k2 and event_type = 'deadline_set'
     and actor_user_id = A and new_value = docket.iso_utc(inw) and new_value like '%Z';
  out := out || '4:' || case when c = 1 and jsonb_array_length(j->'first') = 1 then 'set-hist-ok' else 'c=' || c || ' ' || j::text end || ' ';
  -- 5: revising needs a reason
  begin j := docket.task_set_deadline(A, array[k2], nextw, '  '); out := out || '5:REVISED ';
  exception when check_violation then out := out || '5:' || sqlerrm || ' '; end;
  -- 6: revise with a reason → revised_deadline, history with old/new/note; original untouched
  j := docket.task_set_deadline(A, array[k2], nextw, 'zz slip');
  select count(*) into c from docket.task_history where task_id = k2 and event_type = 'deadline_revised'
     and old_value = docket.iso_utc(inw) and new_value = docket.iso_utc(nextw) and note = 'zz slip';
  out := out || '6:' || case when c = 1 and (select deadline = inw and revised_deadline = nextw from docket.tasks where id = k2)
    then 'revised-ok' else 'c=' || c end || ' ';
  -- 7: re-dating OUT of the week leaves it in, committed deadline frozen
  out := out || '7:' || case when (select committed_deadline = inw from docket.week_commitments where week_end = WE and task_id = k2)
    then 'still-in' else 'MOVED' end || ' ';
  -- 8: re-dating INTO the week never enters
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline) values ('ZZS-4', 'zz', A, G, nextw) returning id into k3;
  j := docket.task_set_deadline(A, array[k3], inw, 'zz pull in');
  select entry_reason into v from docket.week_commitments where week_end = WE and task_id = k3;
  out := out || '8:' || coalesce(v, 'none') || ' ';
  -- 9: before 0023, a direct UPDATE writes no history (the old worker still logs its own)
  --    (after 0023 it is refused — 21)
  if not exists (select 1 from pg_trigger where tgname = 'tasks_deadline_guard') then
    update docket.tasks set revised_deadline = nextw where id = k3;
    select count(*) into c from docket.task_history where task_id = k3;
    out := out || '9:' || case when c = 1 then 'no-hist' else 'c=' || c end || ' ';
  else out := out || '9:no-hist '; end if;
  -- 10: the same value again is a no-op (no reason needed, no history)
  select count(*) into c from docket.task_history where task_id = k2;
  j := docket.task_set_deadline(A, array[k2], nextw, null);
  out := out || '10:' || case when jsonb_array_length(j->'revised') = 0 and jsonb_array_length(j->'first') = 0
    and (select count(*) from docket.task_history where task_id = k2) = c then 'noop' else j::text end || ' ';
  -- 11: an abandoned task is untouched
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, status, abandoned_at, abandon_reason)
  values ('ZZS-5', 'zz', A, G, 'abandoned', now(), 'zz') returning id into k4;
  j := docket.task_set_deadline(A, array[k4], inw, null);
  out := out || '11:' || case when (select deadline is null from docket.tasks where id = k4) then 'abandoned-untouched' else 'SET' end || ' ';
  -- 12: team is frozen at entry
  update docket.tasks set department_id = D2 where id = k1;
  out := out || '12:' || case when (select department_id = D1 from docket.week_commitments where week_end = WE and task_id = k1)
    then 'frozen-team' else 'MOVED' end || ' ';
  -- 13: provisional outcomes
  update docket.tasks set status = 'done', completed_at = now() where id = k2;                    -- done before inw
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline) values ('ZZS-6', 'zz', A, G, pastw) returning id into k5;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline, status, completed_at)
  values ('ZZS-7', 'zz', A, G, pastw, 'done', now()) returning id into k6;          -- created already done, deadline already past
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline) values ('ZZS-8', 'zz', A, G, inw) returning id into k7;
  update docket.tasks set status = 'abandoned', abandoned_at = now(), abandon_reason = 'zz' where id = k7;
  select string_agg(n || '/' || (e->>'outcome') || coalesce('/' || (e->>'miss_reason'), ''), ',' order by n) into agg
    from jsonb_array_elements(docket.week_score(TODAY)->'tasks') e
    join (values (k1, 'k1'), (k2, 'k2'), (k5, 'k5'), (k6, 'k6'), (k7, 'k7')) x(id, n) on x.id = (e->>'task_id')::uuid;
  out := out || '13:[' || agg || '] ';
  out := out || '13b:' || (select entry_reason from docket.week_commitments where week_end = WE and task_id = k6) || ' ';
  -- 14-16: open is idempotent, a future week is refused, a running week can't close
  out := out || '14:' || docket.week_open(TODAY) || ' ';
  begin perform docket.week_open((CUT + interval '2 days')::date); out := out || '15:OPENED ';
  exception when check_violation then out := out || '15:' || sqlerrm || ' '; end;
  begin perform docket.week_close(WE); out := out || '16:CLOSED ';
  exception when check_violation then out := out || '16:' || sqlerrm || ' '; end;
  -- 17-20: a finished week (last week, opened late here) closes with frozen outcomes
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline) values ('ZZS-9', 'zz', A, G, lastw) returning id into k8;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline) values ('ZZS-10', 'zz', A, G, lastw) returning id into k9;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, deadline) values ('ZZS-11', 'zz', A, G, lastw) returning id into k10;
  if exists (select 1 from docket.weeks where week_end = LE) then raise exception 'RESULT week % already open — test needs it unopened', LE; end if;
  perform docket.week_open(LE);
  update docket.tasks set status = 'done', completed_at = lastw - interval '1 hour' where id = k9;  -- on time
  update docket.tasks set status = 'done', completed_at = now() where id = k10;                      -- late
  perform docket.week_close(LE);
  select string_agg(n || '/' || wc.outcome || coalesce('/' || wc.miss_reason, ''), ',' order by n) into agg
    from docket.week_commitments wc join (values (k8, 'k8'), (k9, 'k9'), (k10, 'k10')) x(id, n) on x.id = wc.task_id
   where wc.week_end = LE;
  out := out || '17:[' || agg || '] ';
  j := docket.week_score(LE - 2);
  out := out || '18:' || case when (j->>'final')::boolean and (j->'totals'->>'pct')::numeric
      = round(100.0 * (j->'totals'->>'on_time')::int / (j->'totals'->>'cohort')::int, 1) and (j->>'opened_late')::boolean
    then 'final-pct-ok' else j::text end || ' ';
  begin update docket.week_commitments set outcome = 'on_time', miss_reason = null where week_end = LE and task_id = k8; out := out || '19:EDITED ';
  exception when check_violation then out := out || '19:' || sqlerrm || ' '; end;
  out := out || '20:' || docket.week_close(LE) || ' ';
  -- 21-23: the guard (0023)
  if exists (select 1 from pg_trigger where tgname = 'tasks_deadline_guard') then
    begin update docket.tasks set revised_deadline = nextw + interval '1 day' where id = k1; out := out || '21:UPDATED ';
    exception when check_violation then out := out || '21:' || sqlerrm || ' '; end;
    begin perform set_config('docket.deadline_rpc', 'on', true); update docket.tasks set deadline = nextw where id = k1;
      perform set_config('docket.deadline_rpc', '', true); out := out || '22:UPDATED ';
    exception when check_violation then perform set_config('docket.deadline_rpc', '', true); out := out || '22:' || sqlerrm || ' '; end;
    j := docket.task_set_deadline(A, array[k1], nextw, 'zz');
    out := out || '23:' || case when (select revised_deadline = nextw from docket.tasks where id = k1) then 'rpc-ok' else 'BAD' end;
  else out := out || '21:(no guard yet) 22:(no guard yet) 23:(no guard yet)'; end if;

  raise exception 'RESULT %', out;   -- always roll back
end $$;
