-- 0033 (2026-11-13) — two small Docket fixes found by the F9 reviews.
-- (1) add_task_link / remove_task_link / log_unblocked wrote task_history without a source, so the column
--     default 'app' was stored even for a connector or Slack call and the review pack's by_source.connector
--     undercounted. Each now takes p_source (default 'app', so a caller that doesn't pass it still works).
-- (2) plan_proposals_for ignored the review reader (R level): an Associate's accepted proposal came back as
--     a bare 'accepted' even when plan_items_for shows them the item. It now takes p_is_review (default false)
--     and passes it through; an item seen at level R is named too.
-- Signatures change, so each is dropped and recreated in this one transaction; grants re-stated (service_role).

drop function if exists docket.add_task_link(uuid, uuid, text, uuid);
create function docket.add_task_link(p_task uuid, p_other uuid, p_kind text, p_user uuid, p_source text default 'app')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'docket', 'public'
as $function$
declare
  t docket.tasks; o docket.tasks;
  v_kind text; v_from uuid; v_to uuid; v_id uuid;
  v_phrase_t text; v_phrase_o text;
  v_src text := coalesce(p_source, 'app');
begin
  if p_kind not in ('waiting_on', 'blocks', 'relates') then return jsonb_build_object('ok', false, 'code', 'bad_kind'); end if;
  if p_task = p_other then return jsonb_build_object('ok', false, 'code', 'self_link'); end if;
  select * into t from docket.tasks where id = p_task;
  select * into o from docket.tasks where id = p_other;
  if t.id is null or o.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if t.is_recurring or o.is_recurring then return jsonb_build_object('ok', false, 'code', 'recurring_task'); end if;
  if t.archived_at is not null or o.archived_at is not null then return jsonb_build_object('ok', false, 'code', 'archived_task'); end if;
  if t.status = 'abandoned' then return jsonb_build_object('ok', false, 'code', 'abandoned_read_only'); end if;
  if o.status = 'abandoned' then return jsonb_build_object('ok', false, 'code', 'other_abandoned'); end if;

  if p_kind = 'waiting_on' then v_kind := 'blocks';  v_from := p_other; v_to := p_task;  v_phrase_t := 'waiting on'; v_phrase_o := 'blocks';
  elsif p_kind = 'blocks'  then v_kind := 'blocks';  v_from := p_task;  v_to := p_other; v_phrase_t := 'blocks';     v_phrase_o := 'waiting on';
  else v_kind := 'relates'; v_from := least(p_task, p_other); v_to := greatest(p_task, p_other); v_phrase_t := 'related to'; v_phrase_o := 'related to';
  end if;

  perform pg_advisory_xact_lock(hashtext('docket.task_links'));

  if exists (select 1 from docket.task_links l
             where (l.from_task_id = p_task and l.to_task_id = p_other) or (l.from_task_id = p_other and l.to_task_id = p_task)) then
    return jsonb_build_object('ok', false, 'code', 'already_linked');
  end if;

  if v_kind = 'blocks' and exists (
    with recursive walk(id) as (
      select v_to
      union
      select l.to_task_id from docket.task_links l join walk w on l.from_task_id = w.id where l.kind = 'blocks'
    ) select 1 from walk where id = v_from
  ) then
    return jsonb_build_object('ok', false, 'code', 'cycle');
  end if;

  insert into docket.task_links (kind, from_task_id, to_task_id, created_by_user_id)
  values (v_kind, v_from, v_to, p_user) returning id into v_id;

  insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value, note, source) values
    (p_task,  p_user, 'link_added', 'dependency', p_other::text, v_phrase_t, v_src),
    (p_other, p_user, 'link_added', 'dependency', p_task::text,  v_phrase_o, v_src);

  return jsonb_build_object('ok', true, 'link_id', v_id);
end;
$function$;

drop function if exists docket.remove_task_link(uuid, uuid);
create function docket.remove_task_link(p_link_id uuid, p_user uuid, p_source text default 'app')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'docket', 'public'
as $function$
declare l docket.task_links; v_src text := coalesce(p_source, 'app');
begin
  delete from docket.task_links where id = p_link_id returning * into l;
  if l.id is null then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  insert into docket.task_history (task_id, actor_user_id, event_type, field, old_value, note, source) values
    (l.from_task_id, p_user, 'link_removed', 'dependency', l.to_task_id::text,
       case when l.kind = 'blocks' then 'blocks' else 'related to' end, v_src),
    (l.to_task_id,   p_user, 'link_removed', 'dependency', l.from_task_id::text,
       case when l.kind = 'blocks' then 'waiting on' else 'related to' end, v_src);
  return jsonb_build_object('ok', true);
end;
$function$;

drop function if exists docket.log_unblocked(uuid[], uuid);
create function docket.log_unblocked(p_closed_ids uuid[], p_actor uuid, p_source text default 'app')
 returns integer
 language sql
 security definer
 set search_path to 'docket', 'public'
as $function$
  with cand as (
    select distinct on (l.to_task_id) l.to_task_id as waiting_id, l.from_task_id as blocker_id, b.status as blocker_status
    from docket.task_links l
    join docket.tasks b on b.id = l.from_task_id and b.status in ('done', 'abandoned')
    join docket.tasks w on w.id = l.to_task_id and w.status not in ('done', 'abandoned')
    where l.kind = 'blocks' and l.from_task_id = any(p_closed_ids)
      and not exists (select 1 from docket.task_links l2 join docket.tasks b2 on b2.id = l2.from_task_id
                      where l2.kind = 'blocks' and l2.to_task_id = l.to_task_id and b2.status not in ('done', 'abandoned'))
    order by l.to_task_id, l.created_at
  ), ins as (
    insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value, note, source)
    select waiting_id, p_actor, 'unblocked', 'dependency', blocker_id::text, blocker_status, coalesce(p_source, 'app') from cand
    returning 1
  )
  select count(*)::int from ins;
$function$;

drop function if exists docket.plan_proposals_for(uuid, uuid, boolean);
create function docket.plan_proposals_for(p_actor uuid, p_actor_employee uuid, p_is_super boolean, p_is_review boolean default false)
 returns table(id uuid, mine boolean, proposer_user_id uuid, title text, why text, kind_hint text, suggested_theme_id uuid,
   suggested_theme_code text, suggested_theme_title text, suggested_owner_employee_id uuid, suggested_date date, status text,
   decision_note text, decided_by uuid, decided_at timestamp with time zone, accepted_item_id uuid, accepted_item_code text,
   accepted_item_title text, created_at timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'docket', 'public'
as $function$
  with pf as (
    select p.id, p.kind, p.code, p.title, p.level
    from docket.plan_items_for(p_actor_employee, coalesce(p_is_super, false), coalesce(p_is_review, false)) p
  ), rows as (
    select x.* from docket.plan_proposals x
    where case when coalesce(p_is_super, false)
               then x.status = 'submitted' or x.decided_at > now() - interval '30 days' or x.proposer_user_id = p_actor
               else p_actor is not null and x.proposer_user_id = p_actor end
  )
  select r.id, r.proposer_user_id = p_actor,
         case when coalesce(p_is_super, false) then r.proposer_user_id end,
         r.title, r.why, r.kind_hint,
         th.id, th.code, th.title,
         r.suggested_owner_employee_id, r.suggested_date, r.status,
         case when coalesce(p_is_super, false) or r.status = 'declined' then r.decision_note end,
         case when coalesce(p_is_super, false) then r.decided_by end,
         r.decided_at,
         ai.id, ai.code, ai.title,
         r.created_at
  from rows r
  left join pf th on th.id = r.suggested_theme_id and th.kind = 'theme'
  left join pf ai on ai.id = r.accepted_item_id and ai.level in ('F', 'O', 'R')
  order by (r.status = 'submitted') desc, coalesce(r.decided_at, r.created_at) desc, r.id;
$function$;

revoke all on function docket.add_task_link(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function docket.remove_task_link(uuid, uuid, text) from public, anon, authenticated;
revoke all on function docket.log_unblocked(uuid[], uuid, text) from public, anon, authenticated;
revoke all on function docket.plan_proposals_for(uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function docket.add_task_link(uuid, uuid, text, uuid, text) to service_role;
grant execute on function docket.remove_task_link(uuid, uuid, text) to service_role;
grant execute on function docket.log_unblocked(uuid[], uuid, text) to service_role;
grant execute on function docket.plan_proposals_for(uuid, uuid, boolean, boolean) to service_role;
