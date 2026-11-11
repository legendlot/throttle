-- F9 R1 permission matrix, run against the LIVE functions in one DO block that always rolls back
-- (it ends by raising RESULT …). Run via execute_sql; every line must match EXPECT. Leaves 0 rows.
-- A = super (Afshaan) · M = milestone owner, plain admin (Mohit) · S = unrelated / result owner (Shashwat)
-- EXPECT: theme:T01 rtheme:true 1:forbidden 2:parent_not_found 3:M01 4:parent_not_agreed
--   5:["due_date","done_when"] 6:agreed 7:locked_field 8:locked_field 9:forbidden 10:forbidden 11:M01.R1
--   12:parent_not_found 13:forbidden_field 14:forbidden 15:reason_required 16:true 17:forbidden
--   18-20:live_children 21:not_found 22:0 23:[milestone/O/tgt=-,result/O/tgt=-,theme/T] 24:[result/O,theme/T]
--   25:5 26:0 27:0 28:done 29:done 30:parent_not_agreed 31:hist-append-only
do $$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c'; AE uuid := 'a3df2c9c-f413-4747-b2a8-7d49785096f1';
  M uuid := '9a718d49-dee5-41b5-b8d0-8281edb0dbcb'; ME uuid := 'ac12a3b0-5f06-4db7-81f2-8ee0030ae2a5';
  S uuid := 'd798bcd0-20b5-405c-8645-179f51908c50'; SE uuid := '11cb3e0b-057d-47b6-8457-ccaf07c28e57';
  t uuid; tr uuid; m1 uuid; mr uuid; r1 uuid; j jsonb; out text := ''; c int; agg text;
begin
  j := docket.plan_create(A, AE, true, '{"kind":"theme","title":"ZZ test theme","target_text":"secret"}'); t := (j->>'id')::uuid; out := out || 'theme:' || (j->>'code') || ' ';
  j := docket.plan_create(A, AE, true, '{"kind":"theme","title":"ZZ restricted","restricted":true}'); tr := (j->>'id')::uuid; out := out || 'rtheme:' || (j->>'ok') || ' ';
  j := docket.plan_create(M, ME, false, '{"kind":"theme","title":"x"}'); out := out || '1:' || (j->>'code') || ' ';
  j := docket.plan_create(M, ME, false, jsonb_build_object('kind','milestone','parent_id',t,'title','x','owner_employee_id',ME)); out := out || '2:' || (j->>'code') || ' ';
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',t,'title','ZZ ms','owner_employee_id',ME,'target_text','tgt')); m1 := (j->>'id')::uuid; out := out || '3:' || (j->>'code') || ' ';
  j := docket.plan_create(M, ME, false, jsonb_build_object('kind','result','parent_id',m1,'title','r','owner_employee_id',SE,'due_date','2026-12-31','done_when','x')); out := out || '4:' || (j->>'code') || ' ';
  j := docket.plan_act(A, AE, true, m1, 'agree', '{}'); out := out || '5:' || (j->>'fields') || ' ';
  j := docket.plan_act(A, AE, true, m1, 'agree', '{"due_date":"2026-12-31","done_when":"shipped"}'); out := out || '6:' || (j->>'state') || ' ';
  j := docket.plan_update(M, ME, false, m1, '{"due_date":"2027-01-31"}'); out := out || '7:' || (j->>'code') || ' ';
  j := docket.plan_update(A, AE, true, m1, '{"due_date":"2027-01-31"}'); out := out || '8:' || (j->>'code') || ' ';
  j := docket.plan_update(M, ME, false, m1, '{"target_text":"x"}'); out := out || '9:' || (j->>'code') || ' ';
  j := docket.plan_update(M, ME, false, m1, '{"title":"x"}'); out := out || '10:' || (j->>'code') || ' ';
  j := docket.plan_create(M, ME, false, jsonb_build_object('kind','result','parent_id',m1,'title','ZZ r','owner_employee_id',SE,'due_date','2026-12-20','done_when','x')); r1 := (j->>'id')::uuid; out := out || '11:' || coalesce(j->>'code','?') || ' ';
  j := docket.plan_create(S, SE, false, jsonb_build_object('kind','result','parent_id',m1,'title','r','owner_employee_id',SE,'due_date','2026-12-20','done_when','x')); out := out || '12:' || (j->>'code') || ' ';
  j := docket.plan_create(M, ME, false, jsonb_build_object('kind','result','parent_id',m1,'title','r','owner_employee_id',SE,'due_date','2026-12-20','done_when','x','code','HACK')); out := out || '13:' || (j->>'code') || ' ';
  j := docket.plan_act(S, SE, false, r1, 'redate', '{"due_date":"2027-01-05","reason":"x"}'); out := out || '14:' || (j->>'code') || ' ';
  j := docket.plan_act(M, ME, false, r1, 'redate', '{"due_date":"2027-01-05"}'); out := out || '15:' || (j->>'code') || ' ';
  j := docket.plan_act(M, ME, false, r1, 'redate', '{"due_date":"2027-01-05","reason":"slip"}'); out := out || '16:' || (j->>'ok') || ' ';
  j := docket.plan_act(M, ME, false, r1, 'drop', '{"reason":"x"}'); out := out || '17:' || (j->>'code') || ' ';
  j := docket.plan_act(A, AE, true, m1, 'drop', '{"reason":"x"}'); out := out || '18:' || (j->>'code') || ' ';
  j := docket.plan_act(A, AE, true, m1, 'done', '{"evidence":"x"}'); out := out || '19:' || (j->>'code') || ' ';
  j := docket.plan_act(A, AE, true, t, 'drop', '{"reason":"x"}'); out := out || '20:' || (j->>'code') || ' ';
  j := docket.plan_create(A, AE, true, jsonb_build_object('kind','milestone','parent_id',tr,'title','ZZ hidden','owner_employee_id',ME)); mr := (j->>'id')::uuid;
  j := docket.plan_update(M, ME, false, mr, '{"title":"x"}'); out := out || '21:' || (j->>'code') || ' ';
  select count(*) into c from docket.plan_items_for(ME, false) where id in (tr, mr); out := out || '22:' || c || ' ';
  select string_agg(p.kind||'/'||p.level||'/tgt='||coalesce(p.target_text,'-'), ',' order by p.kind) into agg from docket.plan_items_for(ME, false) p; out := out || '23:[' || agg || '] ';
  select string_agg(p.kind||'/'||p.level, ',' order by p.kind) into agg from docket.plan_items_for(SE, false) p; out := out || '24:[' || agg || '] ';
  select count(*) into c from docket.plan_items_for(AE, true); out := out || '25:' || c || ' ';
  select count(*) into c from docket.plan_history_for(ME, false, m1) h where h.new ? 'target_text'; out := out || '26:' || c || ' ';
  select count(*) into c from docket.plan_history_for(SE, false, m1); out := out || '27:' || c || ' ';
  j := docket.plan_act(M, ME, false, r1, 'done', '{"evidence":"proof"}'); out := out || '28:' || (j->>'state') || ' ';
  j := docket.plan_act(A, AE, true, m1, 'done', '{"evidence":"x"}'); out := out || '29:' || (j->>'state') || ' ';
  j := docket.plan_act(A, AE, true, r1, 'reopen', '{"reason":"x"}'); out := out || '30:' || (j->>'code') || ' ';
  begin update docket.plan_item_history set note='x' where item_id=m1; out := out || '31:hist-MUTABLE ';
  exception when insufficient_privilege then out := out || '31:hist-append-only ';
  end;
  raise exception 'RESULT %', out;   -- always roll back
end $$;
