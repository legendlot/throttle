-- F9 R2 (migration 0018) — task links, the Founders' space and plan_links_for, run against the LIVE
-- database in one DO block that always rolls back (it ends by raising RESULT …). Run via execute_sql
-- AFTER 0018 is applied; every token must match EXPECT. Leaves 0 rows. Same people as plan-access.sql:
-- A = super (Afshaan) · M = Mohit (plain admin, owns m1) · S = Shashwat (owns r1 + m2)
-- EXPECT: founders:1 1:ok 2:ok 3:plan_item_closed 4:plan_item_closed 5:check_violation
--   6:restricted_needs_founders_space 7:ok 8:restricted_needs_founders_space 9:ok
--   10:restricted_needs_founders_space 11:restricted_needs_founders_space 12:restricted_tasks_outside: ZZT-1
--   13:not-restricted 14:ok 15:restricted_tasks_outside: ZZT-9
--   16:[t/F,m1/F,r1/F,mr/F] 17:[t/T,m1/O,r1/O,m2/L,mr/none] 18:[t/T,m1/L,r1/O,m2/O,mr/none]
--   19:L-redacted 20:none-empty 21:theme-T-ok 22:4
do $$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c'; AE uuid := 'a3df2c9c-f413-4747-b2a8-7d49785096f1';
  M uuid := '9a718d49-dee5-41b5-b8d0-8281edb0dbcb'; ME uuid := 'ac12a3b0-5f06-4db7-81f2-8ee0030ae2a5';
  S uuid := 'd798bcd0-20b5-405c-8645-179f51908c50'; SE uuid := '11cb3e0b-057d-47b6-8457-ccaf07c28e57';
  G uuid := 'be65c92f-8896-42fa-b251-6da9f1af521a';   -- General
  FS uuid;                                             -- the Founders' space
  t uuid; tr uuid; m1 uuid; m2 uuid; mp uuid; md uuid; mr uuid; r1 uuid; r2 uuid;
  k1 uuid; kf uuid; ks uuid; j jsonb; out text := ''; c int; agg text; rec record;
begin
  select count(*) into c from docket.spaces where is_founders; out := out || 'founders:' || c || ' ';
  select id into FS from docket.spaces where is_founders;

  -- the plan: theme t (open) → m1 (Mohit, agreed) → r1 (Shashwat, agreed), r2 (done); m2 (Shashwat, agreed);
  -- mp (proposed); md (dropped). Restricted theme tr → mr.
  j := docket.plan_create(A, AE, true, '{"kind":"theme","title":"ZZ link theme"}'); t := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, '{"kind":"theme","title":"ZZ link restricted","restricted":true}'); tr := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',t,'title','ZZ m1','owner_employee_id',ME,
       'state','agreed','due_date','2026-12-31','done_when','x')); m1 := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',t,'title','ZZ m2','owner_employee_id',SE,
       'state','agreed','due_date','2026-12-31','done_when','x')); m2 := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',t,'title','ZZ mp','owner_employee_id',ME)); mp := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',t,'title','ZZ md','owner_employee_id',ME)); md := (j->>'id')::uuid;
  j := docket.plan_act(A, AE, true, md, 'drop', '{"reason":"x"}');
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','result','parent_id',m1,'title','ZZ r1','owner_employee_id',SE,
       'due_date','2026-12-20','done_when','x')); r1 := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','result','parent_id',m1,'title','ZZ r2','owner_employee_id',SE,
       'due_date','2026-12-20','done_when','x')); r2 := (j->>'id')::uuid;
  j := docket.plan_act(A, AE, true, r2, 'done', '{"evidence":"x"}');
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',tr,'title','ZZ mr','owner_employee_id',ME)); mr := (j->>'id')::uuid;

  -- 1-2: link to agreed and to proposed
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-1', 'zz', A, G, m1) returning id into k1;
  out := out || '1:ok ';
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-2', 'zz', A, G, mp);
  out := out || '2:ok ';
  -- 3-4: a done result, a dropped milestone
  begin insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-3', 'zz', A, G, r2); out := out || '3:LINKED ';
  exception when check_violation then out := out || '3:' || sqlerrm || ' '; end;
  begin update docket.tasks set plan_item_id = md where id = k1; out := out || '4:LINKED ';
  exception when check_violation then out := out || '4:' || sqlerrm || ' '; end;
  -- 5: a sub-task never carries its own link
  begin insert into docket.tasks (task_no, title, created_by_user_id, space_id, parent_task_id, plan_item_id) values ('ZZT-5', 'zz', A, G, k1, m1); out := out || '5:LINKED ';
  exception when check_violation then out := out || '5:check_violation '; end;
  -- 6: restricted link from General
  begin insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-6', 'zz', A, G, mr); out := out || '6:LINKED ';
  exception when check_violation then out := out || '6:' || sqlerrm || ' '; end;
  -- 7: restricted link inside the Founders' space, with a sub-task
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-7', 'zz', A, FS, mr) returning id into kf;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, parent_task_id) values ('ZZT-8', 'zz', A, FS, kf) returning id into ks;
  out := out || '7:ok ';
  -- 8: moving it out
  begin update docket.tasks set space_id = G where id = kf; out := out || '8:MOVED ';
  exception when check_violation then out := out || '8:' || sqlerrm || ' '; end;
  -- 9: unlinking first, then the sub-tasks + parent move out (the moveTask / bulkMoveTasks order since
  --    review R2 #10: `parent_task_id = …` first, then the parent) — the trigger must not break it
  update docket.tasks set plan_item_id = null where id = kf;
  update docket.tasks set space_id = G where parent_task_id = kf;
  update docket.tasks set space_id = G where id = kf;
  select count(*) into c from docket.tasks where id in (kf, ks) and space_id = G; out := out || '9:' || case when c = 2 then 'ok' else 'c=' || c end || ' ';
  -- 10: re-linking that General parent to a restricted item
  begin update docket.tasks set plan_item_id = mr where id = kf; out := out || '10:LINKED ';
  exception when check_violation then out := out || '10:' || sqlerrm || ' '; end;
  -- 11: a sub-task of a restricted-linked Founders' task moved out alone
  update docket.tasks set space_id = FS where id = kf; update docket.tasks set space_id = FS where parent_task_id = kf;
  update docket.tasks set plan_item_id = mr where id = kf;
  begin update docket.tasks set space_id = G where id = ks; out := out || '11:MOVED ';
  exception when check_violation then out := out || '11:' || sqlerrm || ' '; end;
  -- 12: making theme t restricted while ZZT-1 (→ m1) and ZZT-2 (→ mp) sit in General — through plan_update
  begin j := docket.plan_update(A, AE, true, t, '{"restricted":true}'); out := out || '12:' || coalesce(j->>'code', j->>'ok') || ' ';
  exception when check_violation then out := out || '12:' || split_part(sqlerrm, ',', 1) || ' '; end;
  out := out || '13:' || case when (select restricted from docket.plan_items where id = t) then 'RESTRICTED' else 'not-restricted' end || ' ';
  -- 14-15: a theme with no outside links can become restricted; one with a result-linked task can't
  j := docket.plan_create(A, AE, true, '{"kind":"theme","title":"ZZ quiet theme"}');
  j := docket.plan_update(A, AE, true, (j->>'id')::uuid, '{"restricted":true}'); out := out || '14:' || case when (j->>'ok')::boolean then 'ok' else j::text end || ' ';
  update docket.tasks set plan_item_id = null where task_no in ('ZZT-1', 'ZZT-2');
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-9', 'zz', A, G, r1);
  begin j := docket.plan_update(A, AE, true, t, '{"restricted":true}'); out := out || '15:' || coalesce(j->>'code', j->>'ok') || ' ';
  exception when check_violation then out := out || '15:' || sqlerrm || ' '; end;

  -- 16-18: the levels
  select string_agg(n || '/' || l.level, ',' order by o) into agg
    from docket.plan_links_for(AE, true, array[t, m1, r1, mr]) l
    join (values (t, 't', 1), (m1, 'm1', 2), (r1, 'r1', 3), (mr, 'mr', 4)) v(id, n, o) on v.id = l.id;
  out := out || '16:[' || agg || '] ';
  select string_agg(n || '/' || l.level, ',' order by o) into agg
    from docket.plan_links_for(ME, false, array[t, m1, r1, m2, mr]) l
    join (values (t, 't', 1), (m1, 'm1', 2), (r1, 'r1', 3), (m2, 'm2', 4), (mr, 'mr', 5)) v(id, n, o) on v.id = l.id;
  out := out || '17:[' || agg || '] ';
  select string_agg(n || '/' || l.level, ',' order by o) into agg
    from docket.plan_links_for(SE, false, array[t, m1, r1, m2, mr]) l
    join (values (t, 't', 1), (m1, 'm1', 2), (r1, 'r1', 3), (m2, 'm2', 4), (mr, 'mr', 5)) v(id, n, o) on v.id = l.id;
  out := out || '18:[' || agg || '] ';
  -- 19: L carries kind + theme only — no code, title or state
  select * into rec from docket.plan_links_for(ME, false, array[m2]);
  out := out || '19:' || case when rec.level = 'L' and rec.code is null and rec.title is null and rec.state is null
    and rec.kind = 'milestone' and rec.theme_title = 'ZZ link theme' and rec.theme_id = t then 'L-redacted' else 'LEAK' end || ' ';
  -- 20: none carries nothing past the id
  select * into rec from docket.plan_links_for(SE, false, array[mr]);
  out := out || '20:' || case when rec.level = 'none' and rec.kind is null and rec.code is null and rec.title is null
    and rec.theme_id is null and rec.theme_code is null and rec.theme_title is null then 'none-empty' else 'LEAK' end || ' ';
  -- 21: a theme at T: code + title, theme_* = itself
  select * into rec from docket.plan_links_for(SE, false, array[t]);
  out := out || '21:' || case when rec.level = 'T' and rec.title = 'ZZ link theme' and rec.theme_id = t then 'theme-T-ok' else 'BAD' end || ' ';
  -- 22: unknown / null ids are dropped, duplicates collapse
  select count(*) into c from docket.plan_links_for(SE, false, array[t, t, m1, r1, mr, null, gen_random_uuid()]);
  out := out || '22:' || c || ' ';

  raise exception 'RESULT %', out;   -- always roll back
end $$;
