-- F9 R6b — the founders' top 5 (spec §8.6; table docket.founder_focus from 0024).
-- docket.founder_focus_set(p_actor, p_week_end, p_items) REPLACES one founder's top 5 for one week in a single
-- transaction: validate every item, delete the actor's rows for that week, insert the new ones, return them.
-- Any refusal raises, so nothing is half-written. items '[]' clears the week.
-- Refusals (check_violation, message = the code the worker passes through):
--   bad_week       p_week_end is not a week-ending date (no docket.weeks row and not on week_end_dow)
--   week_closed    the week has closed (docket.weeks.closed_at) or is already over — a record, not a draft
--   too_many       more than 5 items
--   bad_rank       a rank that is not a whole number 1–5, or a repeated rank
--   bad_item       not an object, both plan_item_id and task_id, a malformed id, or neither an id nor a note
--   note_too_long  a note over 500 characters (after trimming)
--   not_found      a plan_item_id / task_id that does not exist
-- WHO may call it (plan admins) and what they may point at (an item they see, a task they can open) is the
-- worker's gate (setFounderFocus); this re-checks everything about the rows themselves.
-- Additive + idempotent. service_role only, like every docket RPC.

create or replace function docket.founder_focus_set(p_actor uuid, p_week_end date, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_it jsonb; v_rank int; v_ranks int[] := '{}'; v_pid uuid; v_tid uuid; v_note text;
begin
  if p_actor is null then raise exception 'actor_required' using errcode = 'check_violation'; end if;
  if p_week_end is null
     or (not exists (select 1 from docket.weeks w where w.week_end = p_week_end)
         and p_week_end <> docket.week_end_of(p_week_end, docket.week_end_dow())) then
    raise exception 'bad_week' using errcode = 'check_violation';
  end if;
  if exists (select 1 from docket.weeks w where w.week_end = p_week_end and w.closed_at is not null)
     or p_week_end < docket.week_end_at(now()) then
    raise exception 'week_closed' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(v_items) <> 'array' then raise exception 'bad_item' using errcode = 'check_violation'; end if;
  if jsonb_array_length(v_items) > 5 then raise exception 'too_many' using errcode = 'check_violation'; end if;

  -- One save per founder per week at a time (two tabs saving at once must not interleave delete/insert).
  perform pg_advisory_xact_lock(hashtext('docket.founder_focus:' || p_actor::text || ':' || p_week_end::text));
  delete from docket.founder_focus where week_end = p_week_end and founder_user_id = p_actor;

  for v_it in select e from jsonb_array_elements(v_items) e loop
    if jsonb_typeof(v_it) <> 'object' then raise exception 'bad_item' using errcode = 'check_violation'; end if;
    if jsonb_typeof(v_it->'rank') is distinct from 'number' or (v_it->>'rank') !~ '^[1-5]$' then
      raise exception 'bad_rank' using errcode = 'check_violation';
    end if;
    v_rank := (v_it->>'rank')::int;
    if v_rank = any(v_ranks) then raise exception 'bad_rank' using errcode = 'check_violation'; end if;
    v_ranks := v_ranks || v_rank;
    begin
      v_pid := nullif(v_it->>'plan_item_id', '')::uuid;
      v_tid := nullif(v_it->>'task_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'bad_item' using errcode = 'check_violation';
    end;
    if v_it ? 'note' and jsonb_typeof(v_it->'note') not in ('string', 'null') then
      raise exception 'bad_item' using errcode = 'check_violation';
    end if;
    v_note := nullif(btrim(coalesce(v_it->>'note', '')), '');
    if v_pid is not null and v_tid is not null then raise exception 'bad_item' using errcode = 'check_violation'; end if;
    if v_pid is null and v_tid is null and v_note is null then raise exception 'bad_item' using errcode = 'check_violation'; end if;
    if v_note is not null and length(v_note) > 500 then raise exception 'note_too_long' using errcode = 'check_violation'; end if;
    if v_pid is not null and not exists (select 1 from docket.plan_items i where i.id = v_pid) then
      raise exception 'not_found' using errcode = 'check_violation';
    end if;
    if v_tid is not null and not exists (select 1 from docket.tasks t where t.id = v_tid) then
      raise exception 'not_found' using errcode = 'check_violation';
    end if;
    insert into docket.founder_focus (week_end, founder_user_id, rank, plan_item_id, task_id, note, updated_at)
    values (p_week_end, p_actor, v_rank, v_pid, v_tid, v_note, now());
  end loop;

  return coalesce((select jsonb_agg(jsonb_build_object('rank', f.rank, 'plan_item_id', f.plan_item_id, 'task_id', f.task_id,
                                                       'note', f.note, 'updated_at', f.updated_at) order by f.rank)
                     from docket.founder_focus f where f.week_end = p_week_end and f.founder_user_id = p_actor), '[]'::jsonb);
end $$;

revoke all on function docket.founder_focus_set(uuid, date, jsonb) from public, anon, authenticated;
grant execute on function docket.founder_focus_set(uuid, date, jsonb) to service_role;
