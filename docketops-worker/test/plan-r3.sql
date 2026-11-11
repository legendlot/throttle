-- F9 R3 (migration 0019) — split, the matrix's new cell and proposals, run against the LIVE database in one
-- DO block that always rolls back (it ends by raising RESULT …). Run via execute_sql AFTER 0019 is applied;
-- every token must match EXPECT. Leaves 0 rows. Same people as plan-access.sql:
-- A = super (Afshaan) · M = Mohit (plain admin, owns m1) · S = Shashwat (owns r1 + r2)
-- EXPECT: 0:bad_children 1:unmapped_results/2 2:unmapped_tasks/2 3:not_found 4:bad_tasks 5:ok/2/relinked=2
--   6:children-agreed-siblings 7:split 8:r1-moved/r2-dropped/r3-moved 9:t1-child0/t3-r1/t2-untouched
--   10:hist-ok 11:task-hist-ok 12:bad_state/bad_state/bad_state/theme-bad_state 13:result-split-ok 14:bad_results
--   15:ok 16:theme-ignored 17:why_required 18:mine=3/theme=ZZ r3 theme 19:queue=3 20:shashwat=0
--   21:not_found 22:note_required 23:accepted/agreed/linked 24:mohit-sees-code 25:theme_required
--   26:accepted 27:mohit-no-code 28:already_decided 29:declined/reason-shown 30:outsider=0
do $$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c'; AE uuid := 'a3df2c9c-f413-4747-b2a8-7d49785096f1';
  M uuid := '9a718d49-dee5-41b5-b8d0-8281edb0dbcb'; ME uuid := 'ac12a3b0-5f06-4db7-81f2-8ee0030ae2a5';
  S uuid := 'd798bcd0-20b5-405c-8645-179f51908c50'; SE uuid := '11cb3e0b-057d-47b6-8457-ccaf07c28e57';
  G uuid := 'be65c92f-8896-42fa-b251-6da9f1af521a';   -- General
  t uuid; tr uuid; m1 uuid; r1 uuid; r2 uuid; r3 uuid; c0 uuid; c1 uuid; k1 uuid; k2 uuid; k3 uuid;
  p1 uuid; p2 uuid; p3 uuid; v_item uuid;
  j jsonb; ch jsonb; out text := ''; c int; rec record; m1code text;
begin
  -- the plan: theme t → m1 (Mohit, agreed) → r1, r2 (Shashwat, agreed), r3 (done). Restricted theme tr.
  j := docket.plan_create(A, AE, true, '{"kind":"theme","title":"ZZ r3 theme"}'); t := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, '{"kind":"theme","title":"ZZ r3 restricted","restricted":true}'); tr := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',t,'title','ZZ m1','owner_employee_id',ME,
       'state','agreed','due_date','2026-12-31','done_when','x')); m1 := (j->>'id')::uuid; m1code := j->>'code';
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','result','parent_id',m1,'title','ZZ r1','owner_employee_id',SE,
       'due_date','2026-12-20','done_when','x')); r1 := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','result','parent_id',m1,'title','ZZ r2','owner_employee_id',SE,
       'due_date','2026-12-20','done_when','x')); r2 := (j->>'id')::uuid;
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','result','parent_id',m1,'title','ZZ r3','owner_employee_id',SE,
       'due_date','2026-12-20','done_when','x')); r3 := (j->>'id')::uuid;
  j := docket.plan_act(A, AE, true, r3, 'done', '{"evidence":"x"}');
  -- tasks in General: ZZT-1 open → m1, ZZT-2 done → m1, ZZT-3 open → r2 (the result about to be dropped)
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-1', 'zz', A, G, m1) returning id into k1;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id, status) values ('ZZT-2', 'zz', A, G, m1, 'done') returning id into k2;
  insert into docket.tasks (task_no, title, created_by_user_id, space_id, plan_item_id) values ('ZZT-3', 'zz', A, G, r2) returning id into k3;

  ch := jsonb_build_array(
    jsonb_build_object('title','ZZ m1a','owner_employee_id',ME,'due_date','2026-12-15','done_when','a'),
    jsonb_build_object('title','ZZ m1b','owner_employee_id',SE,'due_date','2027-01-15','done_when','b'));
  -- 0: one child is not a split
  j := docket.plan_split(A, AE, true, m1, jsonb_build_object('reason','r','children', jsonb_build_array(ch->0)));
  out := out || '0:' || (j->>'code') || ' ';
  -- 1: r2 (live) and r3 (done, no tasks_default to fall back on) unmapped
  j := docket.plan_split(A, AE, true, m1, jsonb_build_object('reason','r','children',ch,'results',jsonb_build_object(r1, 0)));
  out := out || '1:' || (j->>'code') || '/' || jsonb_array_length(j->'ids') || ' ';
  -- 2: results covered, but ZZT-1 + ZZT-3 have no target and there is no default
  j := docket.plan_split(A, AE, true, m1, jsonb_build_object('reason','r','children',ch,
       'results',jsonb_build_object(r1, 1, r2, 'drop', r3, 0),'result_drop_reason','not needed'));
  out := out || '2:' || (j->>'code') || '/' || (j->>'count') || ' ';
  -- 3: not a super admin — even the milestone's owner — sees nothing
  j := docket.plan_split(M, ME, false, m1, jsonb_build_object('reason','r','children',ch,'tasks_default',0));
  out := out || '3:' || (j->>'code') || ' ';
  -- 4: a task may not be pointed at the result being dropped
  j := docket.plan_split(A, AE, true, m1, jsonb_build_object('reason','r','children',ch,
       'results',jsonb_build_object(r1, 1, r2, 'drop'),'result_drop_reason','not needed','tasks_default',0,
       'tasks',jsonb_build_object(k3, r2)));
  out := out || '4:' || (j->>'code') || ' ';
  -- 5: the split — r1 → child 1, r2 dropped, r3 (done) falls back to child 0; ZZT-3 → r1, ZZT-1 → default child 0
  j := docket.plan_split(A, AE, true, m1, jsonb_build_object('reason','two teams','children',ch,
       'results',jsonb_build_object(r1, 1, r2, 'drop'),'result_drop_reason','not needed','tasks_default',0,
       'tasks',jsonb_build_object(k3, r1)));
  out := out || '5:' || case when (j->>'ok')::boolean then 'ok' else j::text end || '/' || jsonb_array_length(j->'children')
             || '/relinked=' || (j->>'relinked') || ' ';
  c0 := (j->'children'->0->>'id')::uuid; c1 := (j->'children'->1->>'id')::uuid;
  -- 6: the children: agreed siblings under the theme, split_from = m1, auto milestone codes
  select count(*) into c from docket.plan_items
   where split_from_id = m1 and state = 'agreed' and parent_id = t and kind = 'milestone' and code ~ '^M[0-9]+$' and code <> m1code;
  out := out || '6:' || case when c = 2 then 'children-agreed-siblings' else 'c=' || c end || ' ';
  out := out || '7:' || (select state from docket.plan_items where id = m1) || ' ';
  out := out || '8:' || case when (select parent_id from docket.plan_items where id = r1) = c1 then 'r1-moved' else 'r1-BAD' end
             || '/' || case when (select state from docket.plan_items where id = r2) = 'dropped' then 'r2-dropped' else 'r2-BAD' end
             || '/' || case when (select parent_id from docket.plan_items where id = r3) = c0 then 'r3-moved' else 'r3-BAD' end || ' ';
  out := out || '9:' || case when (select plan_item_id from docket.tasks where id = k1) = c0 then 't1-child0' else 't1-BAD' end
             || '/' || case when (select plan_item_id from docket.tasks where id = k3) = r1 then 't3-r1' else 't3-BAD' end
             || '/' || case when (select plan_item_id from docket.tasks where id = k2) = m1 then 't2-untouched' else 't2-BAD' end || ' ';
  -- 10: plan history — split on m1 (child codes in `new`, reason as note), created ×2 (split from), moved ×2, dropped
  select count(*) into c from docket.plan_item_history h where
       (h.item_id = m1 and h.event = 'split' and h.note = 'two teams'
          and h.new->'split_into' = (select jsonb_agg(code order by sort) from docket.plan_items where split_from_id = m1))
    or (h.item_id in (c0, c1) and h.event = 'created' and h.note = 'split from ' || m1code)
    or (h.item_id in (r1, r3) and h.event = 'moved' and h.old->>'parent_id' = m1::text)
    or (h.item_id = r2 and h.event = 'dropped' and h.note = 'not needed');
  out := out || '10:' || case when c = 6 then 'hist-ok' else 'c=' || c end || ' ';
  -- 11: task history — one row per re-linked task, ids only
  select count(*) into c from docket.task_history h
   where h.field = 'plan_item_id' and h.event_type = 'plan_item_id_changed' and h.actor_user_id = A
     and ((h.task_id = k1 and h.old_value = m1::text and h.new_value = c0::text)
       or (h.task_id = k3 and h.old_value = r2::text and h.new_value = r1::text));
  select c + count(*) * 100 into c from docket.task_history h where h.task_id = k2 and h.field = 'plan_item_id';
  out := out || '11:' || case when c = 2 then 'task-hist-ok' else 'c=' || c end || ' ';
  -- 12: split is terminal and read-only — edit, act, split again; a theme never splits
  j := docket.plan_update(A, AE, true, m1, '{"title":"x"}'); out := out || '12:' || (j->>'code');
  j := docket.plan_act(A, AE, true, m1, 'reopen', '{"reason":"x"}'); out := out || '/' || (j->>'code');
  j := docket.plan_split(A, AE, true, m1, jsonb_build_object('reason','r','children',ch,'tasks_default',0)); out := out || '/' || (j->>'code');
  j := docket.plan_split(A, AE, true, t, jsonb_build_object('reason','r','children',ch,'tasks_default',0)); out := out || '/theme-' || (j->>'code') || ' ';
  -- 13: a result splits into results under the same milestone (r1 now sits under c1)
  j := docket.plan_split(A, AE, true, r1, jsonb_build_object('reason','r','tasks_default',0,'children', jsonb_build_array(
       jsonb_build_object('title','ZZ r1a','owner_employee_id',SE,'due_date','2026-12-10','done_when','a'),
       jsonb_build_object('title','ZZ r1b','owner_employee_id',SE,'due_date','2026-12-11','done_when','b','measure',jsonb_build_object('system','manual','metric','manual')))));
  select count(*) into c from docket.plan_items where split_from_id = r1 and parent_id = c1 and kind = 'result' and code like (select code from docket.plan_items where id = c1) || '.R%';
  out := out || '13:' || case when (j->>'ok')::boolean and c = 2 and (select plan_item_id from docket.tasks where id = k3) = (j->'children'->0->>'id')::uuid
                              then 'result-split-ok' else j::text || c end || ' ';
  -- 14: a result split takes no results map
  j := docket.plan_split(A, AE, true, (j->'children'->0->>'id')::uuid, jsonb_build_object('reason','r','children',ch,'results',jsonb_build_object(r3, 0)));
  out := out || '14:' || (j->>'code') || ' ';

  -- proposals
  j := docket.plan_propose(M, false, jsonb_build_object('title','ZZ prop 1','why','because','suggested_theme_id',t)); p1 := (j->>'id')::uuid;
  out := out || '15:' || case when (j->>'ok')::boolean then 'ok' else j::text end || ' ';
  j := docket.plan_propose(M, false, jsonb_build_object('title','ZZ prop 2','why','because','suggested_theme_id',tr)); p2 := (j->>'id')::uuid;
  out := out || '16:' || case when (select suggested_theme_id from docket.plan_proposals where id = p2) is null then 'theme-ignored' else 'LEAK' end || ' ';
  j := docket.plan_propose(M, false, '{"title":"x","why":"  "}'); out := out || '17:' || (j->>'code') || ' ';
  j := docket.plan_propose(M, false, '{"title":"ZZ prop 3","why":"risk","kind_hint":"risk"}'); p3 := (j->>'id')::uuid;
  select count(*) into c from docket.plan_proposals_for(M, ME, false) x where x.id in (p1, p2, p3) and x.mine;
  select x.suggested_theme_title into rec from docket.plan_proposals_for(M, ME, false) x where x.id = p1;
  out := out || '18:mine=' || c || '/theme=' || coalesce(rec.suggested_theme_title, '-') || ' ';
  select count(*) into c from docket.plan_proposals_for(A, AE, true) x where x.id in (p1, p2, p3) and x.proposer_user_id = M;
  out := out || '19:queue=' || c || ' ';
  select count(*) into c from docket.plan_proposals_for(S, SE, false) x where x.id in (p1, p2, p3);
  out := out || '20:shashwat=' || c || ' ';
  j := docket.plan_proposal_decide(M, ME, false, p1, '{"decision":"accept"}'); out := out || '21:' || (j->>'code') || ' ';
  j := docket.plan_proposal_decide(A, AE, true, p1, '{"decision":"decline"}'); out := out || '22:' || (j->>'code') || ' ';
  j := docket.plan_proposal_decide(A, AE, true, p1, jsonb_build_object('decision','accept','owner_employee_id',ME,'state','agreed',
       'due_date','2027-02-01','done_when','shipped'));
  v_item := (j->>'item_id')::uuid;
  out := out || '23:' || (j->>'status') || '/' || (select state from docket.plan_items where id = v_item)
             || '/' || case when (select accepted_item_id from docket.plan_proposals where id = p1) = v_item
                             and (select parent_id from docket.plan_items where id = v_item) = t then 'linked' else 'BAD' end || ' ';
  select * into rec from docket.plan_proposals_for(M, ME, false) x where x.id = p1;
  out := out || '24:' || case when rec.status = 'accepted' and rec.accepted_item_code is not null and rec.accepted_item_title = 'ZZ prop 1'
                              and rec.decided_by is null then 'mohit-sees-code' else 'BAD' end || ' ';
  j := docket.plan_proposal_decide(A, AE, true, p2, jsonb_build_object('decision','accept','owner_employee_id',SE));
  out := out || '25:' || (j->>'code') || ' ';
  j := docket.plan_proposal_decide(A, AE, true, p2, jsonb_build_object('decision','accept','owner_employee_id',SE,'theme_id',t));
  out := out || '26:' || (j->>'status') || ' ';
  select * into rec from docket.plan_proposals_for(M, ME, false) x where x.id = p2;
  out := out || '27:' || case when rec.status = 'accepted' and rec.accepted_item_id is null and rec.accepted_item_code is null
                              and rec.accepted_item_title is null then 'mohit-no-code' else 'LEAK' end || ' ';
  j := docket.plan_proposal_decide(A, AE, true, p1, '{"decision":"decline","note":"x"}'); out := out || '28:' || (j->>'code') || ' ';
  j := docket.plan_proposal_decide(A, AE, true, p3, '{"decision":"decline","note":"already covered"}');
  select * into rec from docket.plan_proposals_for(M, ME, false) x where x.id = p3;
  out := out || '29:' || rec.status || '/' || case when rec.decision_note = 'already covered' then 'reason-shown' else 'BAD' end || ' ';
  select count(*) into c from docket.plan_proposals_for(null, null, false) x where x.id in (p1, p2, p3);
  out := out || '30:outsider=' || c || ' ';

  raise exception 'RESULT %', out;   -- always roll back
end $$;
