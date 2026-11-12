-- F9 R6b (migration 0026) — docket.founder_focus_set. One DO block that always rolls back (ends by raising
-- RESULT …). Run via execute_sql AFTER 0026 is applied (before: RESULT skipped). Fixtures: a throwaway actor
-- uuid (founder_user_id has no FK), the first plan item and task by id, the current week (week_end_at(now())).
-- EXPECT: 1:[1,2] 2:[1] 3:too_many/kept 4:bad_rank/kept 5:bad_rank 6:bad_item 7:bad_item 8:note_too_long
--         9:not_found 10:week_closed 11:bad_week 12:bad_item 13:[]/0
do $$
declare
  A uuid := gen_random_uuid();
  W date := docket.week_end_at(now());
  P uuid := (select id from docket.plan_items order by id limit 1);
  T uuid := (select id from docket.tasks order by id limit 1);
  out text := ''; j jsonb; c int; agg text;
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'docket' and p.proname = 'founder_focus_set') then
    raise exception 'RESULT skipped: 0026 not applied';
  end if;

  -- 1: two items (out of order) → stored by rank
  j := docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 2, 'task_id', T),
                                                       jsonb_build_object('rank', 1, 'plan_item_id', P, 'note', ' zz ')));
  select string_agg((e->>'rank'), ',' order by (e->>'rank')::int) into agg from jsonb_array_elements(j) e;
  out := out || '1:[' || coalesce(agg, '') || '] ';
  -- 2: a save REPLACES the week (delete + insert)
  perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 1, 'note', 'zz only')));
  select string_agg(rank::text, ',' order by rank) into agg from docket.founder_focus where founder_user_id = A and week_end = W;
  out := out || '2:[' || coalesce(agg, '') || '] ';
  -- 3: six items → refused, the stored row untouched
  begin
    perform docket.founder_focus_set(A, W, (select jsonb_agg(jsonb_build_object('rank', least(g, 5), 'note', 'zz')) from generate_series(1, 6) g));
    out := out || '3:no-error ';
  exception when others then
    select count(*) into c from docket.founder_focus where founder_user_id = A and week_end = W;
    out := out || '3:' || sqlerrm || case when c = 1 then '/kept ' else '/c=' || c || ' ' end;
  end;
  -- 4: a repeated rank AFTER a good item → refused, and the good item's insert rolled back with it
  begin
    perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 1, 'note', 'zz a'), jsonb_build_object('rank', 1, 'note', 'zz b')));
    out := out || '4:no-error ';
  exception when others then
    select count(*) into c from docket.founder_focus where founder_user_id = A and week_end = W and note = 'zz only';
    out := out || '4:' || sqlerrm || case when c = 1 then '/kept ' else '/lost ' end;
  end;
  -- 5: rank out of range
  begin perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 6, 'note', 'zz')));
    out := out || '5:no-error '; exception when others then out := out || '5:' || sqlerrm || ' '; end;
  -- 6: both a plan item and a task
  begin perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 1, 'plan_item_id', P, 'task_id', T)));
    out := out || '6:no-error '; exception when others then out := out || '6:' || sqlerrm || ' '; end;
  -- 7: neither an id nor a non-blank note
  begin perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 1, 'note', '   ')));
    out := out || '7:no-error '; exception when others then out := out || '7:' || sqlerrm || ' '; end;
  -- 8: a 501-character note
  begin perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 1, 'note', repeat('z', 501))));
    out := out || '8:no-error '; exception when others then out := out || '8:' || sqlerrm || ' '; end;
  -- 9: an item id that doesn't exist
  begin perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 1, 'plan_item_id', gen_random_uuid())));
    out := out || '9:no-error '; exception when others then out := out || '9:' || sqlerrm || ' '; end;
  -- 10: last week (over) → a record
  begin perform docket.founder_focus_set(A, W - 7, jsonb_build_array(jsonb_build_object('rank', 1, 'note', 'zz')));
    out := out || '10:no-error '; exception when others then out := out || '10:' || sqlerrm || ' '; end;
  -- 11: not a week-ending date
  begin perform docket.founder_focus_set(A, W + 1, jsonb_build_array(jsonb_build_object('rank', 1, 'note', 'zz')));
    out := out || '11:no-error '; exception when others then out := out || '11:' || sqlerrm || ' '; end;
  -- 12: a malformed id
  begin perform docket.founder_focus_set(A, W, jsonb_build_array(jsonb_build_object('rank', 1, 'task_id', 'nope')));
    out := out || '12:no-error '; exception when others then out := out || '12:' || sqlerrm || ' '; end;
  -- 13: [] clears the week
  j := docket.founder_focus_set(A, W, '[]'::jsonb);
  select count(*) into c from docket.founder_focus where founder_user_id = A and week_end = W;
  out := out || '13:' || j::text || '/' || c;
  raise exception 'RESULT %', out;
end $$;
