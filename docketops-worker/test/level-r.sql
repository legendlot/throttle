-- F9 R6c (migration 0025) — level R. One DO block that always rolls back (ends by raising RESULT …).
-- Before 0025 is applied it captures the OLD projection on fixtures, runs 0025 inside the block and proves
-- the non-review output is identical; after, it checks the expectations only. Run via execute_sql.
-- EXPECT: eq:same(N)|skipped  1:super-F5 2:[T1/T,M1/O,R1/O] 3:[T1/T,R1/O] 4:[T1/T] 5:[T1/R,M1/R,R1/R] 6:no-target
--         7:[T1/R,M1/O,R1/O] 8:[M1/R/ok,M2/none] 9:hist-stripped 10:hist-none-T
do $$
declare
  A uuid := '107ea993-f5ed-4221-ba97-b08e38dcd00c';
  E1 uuid := (select id from podium.employees order by id limit 1);
  E2 uuid := (select id from podium.employees order by id offset 1 limit 1);
  E3 uuid := (select id from podium.employees order by id offset 2 limit 1);
  t1 uuid; t2 uuid; m1 uuid; m2 uuid; r1 uuid; out text := ''; agg text; c int; j jsonb;
  pre boolean := not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'docket' and p.proname = 'plan_items_for' and p.pronargs = 3);
begin
  insert into docket.plan_items (kind, code, title, state, target_text) values ('theme', 'ZZT1', 'zz', 'agreed', 'secret') returning id into t1;
  insert into docket.plan_items (kind, code, title, state, restricted) values ('theme', 'ZZT2', 'zz', 'agreed', true) returning id into t2;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when)
  values ('milestone', 'ZZT1.M1', t1, 'zz', E1, 'agreed', current_date + 30, 'zz') returning id into m1;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when)
  values ('milestone', 'ZZT2.M2', t2, 'zz', E1, 'agreed', current_date + 30, 'zz') returning id into m2;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when)
  values ('result', 'ZZT1.M1.R1', m1, 'zz', E2, 'agreed', current_date + 20, 'zz') returning id into r1;
  insert into docket.plan_item_history (item_id, event, old, new, note, actor_user_id, source)
  values (m1, 'field_changed', '{"title":"a"}', '{"title":"b","target_text":"secret"}', 'zz', A, 'app');

  if pre then
    create temp table zz_old on commit drop as
      select v.who, p.* from (values ('S', null::uuid, true), ('1', E1, false), ('2', E2, false), ('3', E3, false)) v(who, emp, sup),
           lateral docket.plan_items_for(v.emp, v.sup) p where p.code like 'ZZ%' or true;
    execute $mig$
drop function if exists docket.plan_history_for(uuid, boolean, uuid);
drop function if exists docket.plan_links_for(uuid, boolean, uuid[]);
drop function if exists docket.plan_items_for(uuid, boolean);

create or replace function docket.plan_items_for(p_actor_employee uuid, p_is_super boolean, p_is_review boolean default false)
returns table(id uuid, kind text, code text, parent_id uuid, title text, owner_employee_id uuid, department_id uuid,
              target_text text, done_when text, measure jsonb, due_date date, revised_due_date date, state text,
              split_from_id uuid, restricted boolean, sort int, created_at timestamptz, updated_at timestamptz,
              agreed_at timestamptz, done_at timestamptz, done_evidence text, dropped_at timestamptz,
              drop_reason text, level text)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  with tree as (
    select i.*, m.owner_employee_id as parent_owner,
           case i.kind when 'theme' then i.id when 'milestone' then i.parent_id else m.parent_id end as theme_id
    from docket.plan_items i
    left join docket.plan_items m on m.id = i.parent_id
  ), lv as (
    select t.*, case
      when coalesce(p_is_super, false) then 'F'
      when th.restricted then null
      when t.kind <> 'theme' and p_actor_employee is not null and (t.owner_employee_id = p_actor_employee
           or (t.kind = 'result' and t.parent_owner = p_actor_employee)) then 'O'
      when coalesce(p_is_review, false) then 'R'
      when t.kind = 'theme' then 'T'
    end as lvl
    from tree t
    join docket.plan_items th on th.id = t.theme_id
  )
  select lv.id, lv.kind, lv.code,
         case when lv.lvl = 'T' then null else lv.parent_id end,
         lv.title,
         case when lv.lvl = 'T' then null else lv.owner_employee_id end,
         case when lv.lvl = 'T' then null else lv.department_id end,
         case when lv.lvl = 'F' then lv.target_text end,
         case when lv.lvl = 'T' then null else lv.done_when end,
         case when lv.lvl = 'T' then null else lv.measure end,
         case when lv.lvl = 'T' then null else lv.due_date end,
         case when lv.lvl = 'T' then null else lv.revised_due_date end,
         lv.state,
         case when lv.lvl = 'T' then null else lv.split_from_id end,
         case when lv.lvl = 'F' then lv.restricted end,
         lv.sort,
         case when lv.lvl = 'T' then null else lv.created_at end,
         case when lv.lvl = 'T' then null else lv.updated_at end,
         case when lv.lvl = 'T' then null else lv.agreed_at end,
         case when lv.lvl = 'T' then null else lv.done_at end,
         case when lv.lvl = 'T' then null else lv.done_evidence end,
         case when lv.lvl = 'T' then null else lv.dropped_at end,
         case when lv.lvl = 'T' then null else lv.drop_reason end,
         lv.lvl
  from lv
  where lv.lvl is not null;
$function$;

create or replace function docket.plan_history_for(p_actor_employee uuid, p_is_super boolean, p_id uuid, p_is_review boolean default false)
returns table(id bigint, item_id uuid, event text, old jsonb, new jsonb, note text, actor_user_id uuid, source text, at timestamptz)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  with v as (
    select p.level from docket.plan_items_for(p_actor_employee, p_is_super, p_is_review) p where p.id = p_id
  ), h as (
    select x.id, x.item_id, x.event,
           case when (select level from v) = 'F' then x.old else x.old - 'target_text' - 'restricted' end as old,
           case when (select level from v) = 'F' then x.new else x.new - 'target_text' - 'restricted' end as new,
           x.note, x.actor_user_id, x.source, x.at
    from docket.plan_item_history x
    where x.item_id = p_id and (select level from v) in ('F', 'O', 'R')
  )
  select h.id, h.item_id, h.event, h.old, h.new, h.note, h.actor_user_id, h.source, h.at
  from h
  where not (h.event = 'field_changed' and coalesce(h.new, '{}'::jsonb) = '{}'::jsonb)
  order by h.at desc, h.id desc;
$function$;

create or replace function docket.plan_links_for(p_actor_employee uuid, p_is_super boolean, p_ids uuid[], p_is_review boolean default false)
returns table(id uuid, level text, kind text, code text, title text, state text,
              theme_id uuid, theme_code text, theme_title text)
language sql stable security definer
set search_path to 'docket', 'public'
as $function$
  with want as (
    select distinct x as id from unnest(coalesce(p_ids, '{}'::uuid[])) as x where x is not null
  ), pf as (
    select p.id, p.kind, p.code, p.title, p.state, p.level
    from docket.plan_items_for(p_actor_employee, p_is_super, p_is_review) p
  ), tr as (
    select i.id, i.kind,
           case i.kind when 'theme' then i.id when 'milestone' then i.parent_id else m.parent_id end as theme_id
    from want w
    join docket.plan_items i on i.id = w.id
    left join docket.plan_items m on m.id = i.parent_id
  ), lv as (
    select tr.*, v.code, v.title, v.state,
           coalesce(v.level, case when docket.plan_restricted(tr.id) then 'none' else 'L' end) as lvl
    from tr
    left join pf v on v.id = tr.id
  )
  select lv.id, lv.lvl,
         case when lv.lvl = 'none' then null else lv.kind end,
         case when lv.lvl in ('F', 'O', 'R', 'T') then lv.code end,
         case when lv.lvl in ('F', 'O', 'R', 'T') then lv.title end,
         case when lv.lvl in ('F', 'O', 'R', 'T') then lv.state end,
         case when lv.lvl = 'none' then null else lv.theme_id end,
         case when lv.lvl = 'none' then null else th.code end,
         case when lv.lvl = 'none' then null else th.title end
  from lv
  left join pf th on th.id = lv.theme_id;
$function$;

revoke all on function docket.plan_items_for(uuid, boolean, boolean) from public, anon, authenticated;
revoke all on function docket.plan_history_for(uuid, boolean, uuid, boolean) from public, anon, authenticated;
revoke all on function docket.plan_links_for(uuid, boolean, uuid[], boolean) from public, anon, authenticated;
grant execute on function docket.plan_items_for(uuid, boolean, boolean) to service_role;
grant execute on function docket.plan_history_for(uuid, boolean, uuid, boolean) to service_role;
grant execute on function docket.plan_links_for(uuid, boolean, uuid[], boolean) to service_role;
$mig$;
    select count(*) into c from (
      (select * from zz_old except
       select v.who, p.* from (values ('S', null::uuid, true), ('1', E1, false), ('2', E2, false), ('3', E3, false)) v(who, emp, sup),
              lateral docket.plan_items_for(v.emp, v.sup, false) p)
      union all
      (select v.who, p.* from (values ('S', null::uuid, true), ('1', E1, false), ('2', E2, false), ('3', E3, false)) v(who, emp, sup),
              lateral docket.plan_items_for(v.emp, v.sup, false) p
       except select * from zz_old)) d;
    out := out || 'eq:' || case when c = 0 then 'same' else 'DIFF=' || c end || ' ';
  else out := out || 'eq:skipped '; end if;

  select count(*) into c from docket.plan_items_for(null, true, false) p where p.code like 'ZZT%' and p.level = 'F';
  out := out || '1:' || case when c = 5 then 'super-F5' else 'c=' || c end || ' ';
  select string_agg(split_part(p.code, '.', -1) || '/' || p.level, ',' order by p.code) into agg
    from docket.plan_items_for(E1, false, false) p where p.code like 'ZZT%';
  out := out || '2:[' || replace(replace(coalesce(agg, ''), 'ZZT1/', 'T1/'), 'ZZT2/', 'T2/') || '] ';
  select string_agg(split_part(p.code, '.', -1) || '/' || p.level, ',' order by p.code) into agg
    from docket.plan_items_for(E2, false, false) p where p.code like 'ZZT%';
  out := out || '3:[' || replace(coalesce(agg, ''), 'ZZT1/', 'T1/') || '] ';
  select string_agg(split_part(p.code, '.', -1) || '/' || p.level, ',' order by p.code) into agg
    from docket.plan_items_for(E3, false, false) p where p.code like 'ZZT%';
  out := out || '4:[' || replace(coalesce(agg, ''), 'ZZT1/', 'T1/') || '] ';
  select string_agg(split_part(p.code, '.', -1) || '/' || p.level, ',' order by p.code) into agg
    from docket.plan_items_for(E3, false, true) p where p.code like 'ZZT%';
  out := out || '5:[' || replace(coalesce(agg, ''), 'ZZT1/', 'T1/') || '] ';
  select count(*) into c from docket.plan_items_for(E3, false, true) p
   where p.code like 'ZZT%' and (p.target_text is not null or p.restricted is not null or (p.kind <> 'theme' and p.owner_employee_id is null));
  out := out || '6:' || case when c = 0 then 'no-target' else 'c=' || c end || ' ';
  select string_agg(split_part(p.code, '.', -1) || '/' || p.level, ',' order by p.code) into agg
    from docket.plan_items_for(E1, false, true) p where p.code like 'ZZT%';
  out := out || '7:[' || replace(coalesce(agg, ''), 'ZZT1/', 'T1/') || '] ';
  select string_agg(case when l.id = m1 then 'M1' else 'M2' end || '/' || l.level
                    || case when l.level = 'R' and l.title = 'zz' and l.theme_code = 'ZZT1' then '/ok' else '' end, ',' order by l.code nulls last) into agg
    from docket.plan_links_for(E3, false, array[m1, m2], true) l;
  out := out || '8:[' || coalesce(agg, '') || '] ';
  select jsonb_agg(h.new) into j from docket.plan_history_for(E3, false, m1, true) h;
  out := out || '9:' || case when jsonb_array_length(j) = 1 and j->0 = '{"title":"b"}'::jsonb then 'hist-stripped' else coalesce(j::text, 'null') end || ' ';
  select count(*) into c from docket.plan_history_for(E3, false, m1, false) h;
  out := out || '10:' || case when c = 0 then 'hist-none-T' else 'c=' || c end;
  raise exception 'RESULT %', out;
end $$;
