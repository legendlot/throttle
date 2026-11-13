-- 0037 (docket_involvement_visibility_v1, P3a): involvement — owner, assignee, collaborator, hand-off receiver — opens a
-- task in any live space but the Founders' space, in every list / search / card function, without the space in
-- p_member_space_ids. One DO block that always rolls back (ends by raising RESULT …). Run via execute_sql AFTER 0037.
-- Fixtures (one program, title token zzp3a): in a private space the caller is not in — own (owner), asg (assignee),
-- col (collaborator), rcv (hand-off to the caller's team), sib (nobody's: the sibling); fnd = own in the Founders'
-- space; pcol / psib = someone's personal space (collaborator / not involved); arch = own in an archived space.
-- EXPECT: 1:my=col,own,pcol 2:prog=asg,col,own,pcol,rcv 3:count=5 4:search=asg,col,own,pcol,rcv 5:cards=asg,col,own,pcol,rcv 6:member=asg,col,own,pcol,rcv,sib 7:grants_ok
do $iv$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';     -- owns the private space (not the caller)
  G uuid := (select id from docket.spaces where is_default limit 1);
  FS uuid := (select id from docket.spaces where is_founders and archived_at is null limit 1);
  E uuid; L uuid; D uuid; E2 uuid; V uuid := gen_random_uuid();
  P uuid; PS uuid; AR uuid; PR uuid; x uuid; out text := ''; ids uuid[];
begin
  -- the caller: a real active employee with a login and a team, who is not A
  select e.id, e.auth_user_id, e.department_id into E, L, D from podium.employees e
   where e.status = 'active' and e.auth_user_id is not null and e.department_id is not null and e.auth_user_id <> A
   order by e.id limit 1;
  E2 := (select id from podium.employees where status = 'active' and id <> E order by id limit 1);   -- everyone else's tasks
  insert into docket.spaces (name, is_private, is_default, owner_user_id, created_by_user_id) values ('ZZ p3a private', true, false, A, A) returning id into P;
  insert into docket.spaces (name, is_private, is_default, owner_user_id, created_by_user_id, archived_at) values ('ZZ p3a archived', true, false, A, A, now()) returning id into AR;
  PS := docket.ensure_personal_space(V);
  insert into docket.programs (name, created_by_user_id) values ('ZZ p3a program', A) returning id into PR;
  create temp table zz_p3a (id uuid, label text) on commit drop;

  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id) values ('ZZP3A-1', 'zzp3a own', A, P, PR, E) returning id into x;
  insert into zz_p3a values (x, 'own');
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id, assignee_employee_id) values ('ZZP3A-2', 'zzp3a asg', A, P, PR, E2, E) returning id into x;
  insert into zz_p3a values (x, 'asg');
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id) values ('ZZP3A-3', 'zzp3a col', A, P, PR, E2) returning id into x;
  insert into zz_p3a values (x, 'col'); insert into docket.task_collaborators (task_id, employee_id, added_by) values (x, E, A);
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id, handoff_to_department_id) values ('ZZP3A-4', 'zzp3a rcv', A, P, PR, E2, D) returning id into x;
  insert into zz_p3a values (x, 'rcv');
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id) values ('ZZP3A-5', 'zzp3a sib', A, P, PR, E2) returning id into x;
  insert into zz_p3a values (x, 'sib');
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id) values ('ZZP3A-6', 'zzp3a fnd', A, FS, PR, E) returning id into x;
  insert into zz_p3a values (x, 'fnd');
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id) values ('ZZP3A-7', 'zzp3a pcol', A, PS, PR, E2) returning id into x;
  insert into zz_p3a values (x, 'pcol'); insert into docket.task_collaborators (task_id, employee_id, added_by) values (x, E, A);
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id) values ('ZZP3A-8', 'zzp3a psib', A, PS, PR, E2) returning id into x;
  insert into zz_p3a values (x, 'psib');
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, owner_employee_id) values ('ZZP3A-9', 'zzp3a arch', A, AR, PR, E) returning id into x;
  insert into zz_p3a values (x, 'arch');
  ids := (select array_agg(id) from zz_p3a);

  -- 1: My tasks (owner / collaborator / own open creation only — so asg and rcv are not "mine"); fnd, arch out
  out := '1:my=' || coalesce((select string_agg(z.label, ',' order by z.label) from zz_p3a z
    where z.id in (select t.id from docket.list_my_tasks(L, E, false, '{}', G) t)), '');
  -- 2: a program's list — every involved row, never the sibling / Founders' / personal-not-involved / archived
  out := out || ' 2:prog=' || coalesce((select string_agg(z.label, ',' order by z.label) from zz_p3a z
    where z.id in (select t.id from docket.list_tasks_by_program(L, E, D, false, '{}', G, PR) t)), '');
  -- 3: the program's sidebar count = those rows
  out := out || ' 3:count=' || coalesce((select task_count::text from docket.programs_for_user(L, E, D, false, '{}', G) where id = PR), '0');
  -- 4: search
  out := out || ' 4:search=' || coalesce((select string_agg(z.label, ',' order by z.label) from zz_p3a z
    where z.id in (select s.id from docket.search_tasks(L, E, D, false, '{}', G, 'zzp3a', null, 50) s)), '');
  -- 5: cards (links) — visible exactly for those
  out := out || ' 5:cards=' || coalesce((select string_agg(z.label, ',' order by z.label) from zz_p3a z
    join docket.task_cards(ids, L, E, D, false, '{}', G) c on c.id = z.id where c.visible), '');
  -- 6: membership still works as before (the private space passed in → its sibling too; the rest unchanged)
  out := out || ' 6:member=' || coalesce((select string_agg(z.label, ',' order by z.label) from zz_p3a z
    where z.id in (select t.id from docket.list_tasks_by_program(L, E, D, false, array[P], G, PR) t)), '');
  -- 7: service_role only, on all five
  out := out || ' 7:' || case when (select bool_and(has_function_privilege('service_role', f, 'execute')
      and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute')) from unnest(array[
      'docket.list_my_tasks(uuid,uuid,boolean,uuid[],uuid,text,uuid,text,boolean,boolean,uuid,text)',
      'docket.list_tasks_by_program(uuid,uuid,uuid,boolean,uuid[],uuid,uuid,text,uuid,uuid,text,boolean,boolean,boolean,text)',
      'docket.programs_for_user(uuid,uuid,uuid,boolean,uuid[],uuid)',
      'docket.search_tasks(uuid,uuid,uuid,boolean,uuid[],uuid,text,text,integer)',
      'docket.task_cards(uuid[],uuid,uuid,uuid,boolean,uuid[],uuid)']) f) then 'grants_ok' else 'GRANTS_WRONG' end;
  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $iv$;
