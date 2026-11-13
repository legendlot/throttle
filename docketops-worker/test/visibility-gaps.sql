-- The F4/F5 reviews' gap (2): docket.programs_for_user (and the program list / search / cards beside it) must not
-- let p_view_all reach a private space the caller isn't in — RULE-DOCKET-003. Already closed by 0016
-- (docket_private_space_gate_v1, applied 2026-11-11); this proves it on the LIVE functions, no migration to embed.
-- One DO block that always rolls back (ends by raising RESULT …). Fixtures (all rolled back): a program X, a
-- private space PS (member A), an archived private space PA (member A), three open top-level tasks in X — one
-- in PS, one in General owned by a stranger, one in PA. Scope args are built the worker's way (accessibleSpaces:
-- private, not archived, owner or member).
-- EXPECT: 1:B=1 2:A=1 3:Bprog=1/no-PS 4:Bsearch=0 5:Bcard=f 6:Aprog=PS 7:Acard=t
do $$
declare
  A uuid := gen_random_uuid();   -- member of PS and PA, no view_all
  B uuid := gen_random_uuid();   -- view_all, member of nothing
  S uuid := gen_random_uuid();   -- the stranger who raised the tasks
  G uuid := (select id from docket.spaces where is_default and archived_at is null limit 1);
  X uuid; PS uuid; PA uuid; T1 uuid; T2 uuid; T3 uuid;
  mA uuid[]; mB uuid[];
  out text := ''; c bigint; agg text; v boolean;
begin
  insert into docket.programs (name) values ('ZZ vis-gap program') returning id into X;
  insert into docket.spaces (name, is_private, is_default, owner_user_id, created_by_user_id)
    values ('ZZ vis-gap private', true, false, S, S) returning id into PS;
  insert into docket.spaces (name, is_private, is_default, owner_user_id, created_by_user_id, archived_at)
    values ('ZZ vis-gap archived', true, false, S, S, now()) returning id into PA;
  insert into docket.space_members (space_id, user_id) values (PS, A), (PA, A);
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, status)
    values ('ZZ-VG-1', 'ZZ vg private', S, PS, X, 'in_progress') returning id into T1;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, status)
    values ('ZZ-VG-2', 'ZZ vg general', S, G, X, 'in_progress') returning id into T2;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, program_id, status)
    values ('ZZ-VG-3', 'ZZ vg archived', S, PA, X, 'in_progress') returning id into T3;

  -- the worker's programScopeArgs: accessible private spaces (owner or member, not archived)
  select coalesce(array_agg(sp.id), '{}') into mA from docket.spaces sp
   where sp.is_private and sp.archived_at is null
     and (sp.owner_user_id = A or exists (select 1 from docket.space_members m where m.space_id = sp.id and m.user_id = A));
  select coalesce(array_agg(sp.id), '{}') into mB from docket.spaces sp
   where sp.is_private and sp.archived_at is null
     and (sp.owner_user_id = B or exists (select 1 from docket.space_members m where m.space_id = sp.id and m.user_id = B));

  -- 1: view_all non-member → only the General task counts (PS and PA add nothing)
  select task_count into c from docket.programs_for_user(B, null, null, true, mB, G) where id = X;
  out := out || '1:B=' || coalesce(c, 0) || ' ';
  -- 2: member without view_all → the PS task only (General's is a stranger's; PA is archived)
  select task_count into c from docket.programs_for_user(A, null, null, false, mA, G) where id = X;
  out := out || '2:A=' || coalesce(c, 0) || ' ';
  -- 3: the program list for B: the General row, never PS's
  select string_agg(t.task_no, ',' order by t.task_no) into agg from docket.list_tasks_by_program(B, null, null, true, mB, G, X) t;
  select count(*) into c from docket.list_tasks_by_program(B, null, null, true, mB, G, X) t where t.space_id in (PS, PA);
  out := out || '3:Bprog=' || (select count(*) from docket.list_tasks_by_program(B, null, null, true, mB, G, X))
              || case when c = 0 then '/no-PS ' else '/LEAK=' || agg || ' ' end;
  -- 4: search for B finds nothing private
  -- (the typo fallback may return the General row; only a PS/PA row would be a leak)
  select count(*) into c from docket.search_tasks(B, null, null, true, mB, G, 'zz vg private', null, 20) t where t.space_id in (PS, PA);
  out := out || '4:Bsearch=' || c || ' ';
  -- 5: task_cards for B: the PS task comes back id-only
  select visible into v from docket.task_cards(array[T1], B, null, null, true, mB, G);
  out := out || '5:Bcard=' || (case when v then 't' else 'f' end) || ' ';
  -- 6: the member's program list is the PS row
  select string_agg(case t.space_id when PS then 'PS' when PA then 'PA' else 'G' end, ',') into agg
    from docket.list_tasks_by_program(A, null, null, false, mA, G, X) t;
  out := out || '6:Aprog=' || coalesce(agg, '') || ' ';
  select visible into v from docket.task_cards(array[T1], A, null, null, false, mA, G);
  out := out || '7:Acard=' || (case when v then 't' else 'f' end);
  raise exception 'RESULT %', out;
end $$;
