-- F9 R8 (migration 0027) — hand-off columns, shape checks and the acceptance-reset trigger. One DO block that
-- always rolls back (ends by raising RESULT …). Run via execute_sql after 0027 is applied.
-- EXPECT: 1:accepted 2:reset 3:kept 4:cleared 5:shape 6:top-level 7:pair
do $$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c'; G uuid := 'be65c92f-8896-42fa-b251-6da9f1af521a';
  D1 uuid := (select id from podium.departments order by name limit 1);
  D2 uuid := (select id from podium.departments order by name offset 1 limit 1);
  E1 uuid := (select id from podium.employees order by id limit 1);
  E2 uuid := (select id from podium.employees order by id offset 1 limit 1);
  k uuid; out text := ''; r record;
begin
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, department_id, handoff_to_department_id)
  values ('ZZH-1', 'zz', A, G, D1, D2) returning id into k;
  -- 1 accept with no named receiver: sets the receiver + acceptance in one write → kept
  update docket.tasks set handoff_accepted_at = now(), handoff_accepted_by = A, handoff_to_employee_id = E1 where id = k;
  select * into r from docket.tasks where id = k;
  out := out || '1:' || case when r.handoff_accepted_at is not null and r.handoff_to_employee_id = E1 then 'accepted' else 'LOST' end || ' ';
  -- 2 the giver changes the receiver → acceptance voided
  update docket.tasks set handoff_to_employee_id = E2 where id = k;
  select * into r from docket.tasks where id = k;
  out := out || '2:' || case when r.handoff_accepted_at is null and r.handoff_accepted_by is null and r.handoff_to_employee_id = E2 then 'reset' else 'KEPT' end || ' ';
  -- 3 an unrelated edit keeps acceptance
  update docket.tasks set handoff_accepted_at = now(), handoff_accepted_by = A where id = k;
  update docket.tasks set title = 'zz2' where id = k;
  out := out || '3:' || case when (select handoff_accepted_at is not null from docket.tasks where id = k) then 'kept' else 'LOST' end || ' ';
  -- 4 clearing the department clears all four
  update docket.tasks set handoff_to_department_id = null where id = k;
  select * into r from docket.tasks where id = k;
  out := out || '4:' || case when r.handoff_to_employee_id is null and r.handoff_accepted_at is null and r.handoff_accepted_by is null then 'cleared' else 'LEFT' end || ' ';
  -- 5 a receiver without a department is refused
  begin insert into docket.tasks (task_no, title, created_by_user_id, space_id, handoff_to_employee_id) values ('ZZH-2', 'zz', A, G, E1);
    out := out || '5:INSERTED '; exception when check_violation then out := out || '5:shape '; end;
  -- 6 a sub-task can't be a hand-off
  begin insert into docket.tasks (task_no, title, created_by_user_id, space_id, parent_task_id, handoff_to_department_id) values ('ZZH-3', 'zz', A, G, k, D2);
    out := out || '6:INSERTED '; exception when check_violation then out := out || '6:top-level '; end;
  -- 7 accepted_at without accepted_by is refused
  begin update docket.tasks set handoff_to_department_id = D2 where id = k; update docket.tasks set handoff_accepted_at = now() where id = k;
    out := out || '7:UPDATED '; exception when check_violation then out := out || '7:pair'; end;
  raise exception 'RESULT %', out;
end $$;
