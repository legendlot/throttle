-- F9 R6c — level R (spec §5.3, Q7 default): the Founders' Associates (`docket_review`) see every
-- UNRESTRICTED theme, milestone and result in full — code, title, owner, dates, state, done-when, measure,
-- history — but never `target_text`, never the `restricted` flag, never a restricted subtree.
-- Backward compatible: each projection function gains `p_is_review boolean default false`, so the
-- deployed worker's two-argument calls resolve to the same rows they did before.
-- Level order: F (super) → nothing in a restricted subtree → O (own milestone / results under it, so an
-- Associate who owns an item keeps the owner's view) → R (review) → T (any unrestricted theme).

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

-- History: F whole; O and R with target_text + restricted stripped (an edit that only touched those
-- disappears); T and below nothing.
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

-- Linked-task chips: F / O / R / T show code + title + state; L and none as in 0018.
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
