-- F9 R5 part 2 — hostile-review fixes to 0021 (applied before the worker that reads `space_id` deploys).
-- #1 week_score returns each row's space_id so docketops can gate titles by space (RULE-DOCKET-003).
-- #3 a task CREATED already done with a deadline inside the current week enters as `created_done` and is
--    on time if it is still done at close (spec §8.2), whatever its deadline vs completed_at.
-- #5 history is written for recurring tasks too (only the cohort skips them).
-- #7 week_end_dow accepts a numeric string like the worker's Number() (weeks-core normalizeWeekSettings).
-- Known, accepted: the cohort is snapshotted / scored when the 5-minute tick runs, not at the exact
-- S 00:00 / E+1 00:00 IST instant; opened_late flags a gap over an hour.

create or replace function docket.week_end_dow() returns int
language sql stable set search_path to 'docket', 'public' as $$
  select coalesce((select case when jsonb_typeof(value) in ('number', 'string') and btrim(value #>> '{}') ~ '^[1-7](\.0*)?$'
                               then (btrim(value #>> '{}'))::numeric::int end
                     from docket.settings where key = 'week_end_dow'), 7)
$$;

alter table docket.week_commitments drop constraint if exists week_commitments_entry_reason_check;
alter table docket.week_commitments add constraint week_commitments_entry_reason_check
  check (entry_reason in ('week_start', 'first_commitment', 'created_done'));

create or replace function docket.tasks_deadline_after() returns trigger
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare
  v_old timestamptz; v_new timestamptz := coalesce(NEW.revised_deadline, NEW.deadline);
  v_reason text := nullif(current_setting('docket.deadline_reason', true), '');
  v_week date; v_entry text;
begin
  if TG_OP = 'UPDATE' then
    v_old := coalesce(OLD.revised_deadline, OLD.deadline);
    -- History only for writes through task_set_deadline (0023's guard makes that the only path).
    if coalesce(current_setting('docket.deadline_rpc', true), '') = 'on' then
      if NEW.deadline is distinct from OLD.deadline then
        insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value)
        values (NEW.id, NEW.updated_by, 'deadline_set', 'deadline', docket.iso_utc(NEW.deadline));
      end if;
      if NEW.revised_deadline is distinct from OLD.revised_deadline then
        insert into docket.task_history (task_id, actor_user_id, event_type, field, old_value, new_value, note)
        values (NEW.id, NEW.updated_by, 'deadline_revised', 'revised_deadline', docket.iso_utc(v_old),
                docket.iso_utc(NEW.revised_deadline), v_reason);
      end if;
    end if;
  end if;
  -- The cohort: a FIRST commitment inside the current week enters it (§8.2). Re-dating never does.
  if v_old is null and v_new is not null and NEW.parent_task_id is null and not coalesce(NEW.is_recurring, false)
     and NEW.status <> 'abandoned' and NEW.archived_at is null
     and not exists (select 1 from docket.spaces s where s.id = NEW.space_id and s.archived_at is not null) then
    v_week := docket.week_end_at(now());
    if docket.week_end_at(v_new) = v_week then
      v_entry := case when TG_OP = 'INSERT' and NEW.status = 'done' then 'created_done' else 'first_commitment' end;
      perform docket.week_open((now() at time zone 'Asia/Kolkata')::date);   -- no-op unless the tick hasn't run yet
      insert into docket.week_commitments (week_end, task_id, committed_deadline, department_id, owner_employee_id, entered_at, entry_reason)
      values (v_week, NEW.id, v_new, NEW.department_id, NEW.owner_employee_id, now(), v_entry)
      on conflict (week_end, task_id) do update set entry_reason = excluded.entry_reason
        where docket.week_commitments.entry_reason = 'week_start' and docket.week_commitments.entered_at = now();
    end if;
  end if;
  return null;
end $$;

-- on_time: done at close AND (completed_at ≤ committed deadline OR it was created already done).
create or replace function docket.week_close(p_week_end date) returns int
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare w docket.weeks; n int;
begin
  select * into w from docket.weeks where week_end = p_week_end for update;
  if not found then raise exception 'week_not_open' using errcode = 'check_violation'; end if;
  if w.closed_at is not null then return 0; end if;
  if now() < w.cutoff_at then raise exception 'week_not_over' using errcode = 'check_violation'; end if;
  update docket.week_commitments c
     set outcome = case when t.status = 'done' and (t.completed_at <= c.committed_deadline or c.entry_reason = 'created_done')
                        then 'on_time' else 'miss' end,
         miss_reason = case when t.status = 'done' and (t.completed_at <= c.committed_deadline or c.entry_reason = 'created_done') then null
                            when t.status = 'abandoned' then 'abandoned'
                            when t.status = 'done' then 'done_late'
                            else 'open' end
    from docket.tasks t
   where t.id = c.task_id and c.week_end = p_week_end;
  get diagnostics n = row_count;
  update docket.weeks set closed_at = now() where week_end = p_week_end;
  return n;
end $$;

create or replace function docket.week_score(p_date date) returns jsonb
language plpgsql stable security definer set search_path to 'docket', 'public' as $$
declare w docket.weeks; v_end date; v_final boolean; v_rows jsonb; v_tot jsonb; v_teams jsonb; v_people jsonb;
begin
  if p_date is null then raise exception 'date_required' using errcode = 'check_violation'; end if;
  select * into w from docket.weeks where p_date between week_start and week_end order by week_end desc limit 1;
  if not found then
    v_end := docket.week_end_of(p_date, docket.week_end_dow());
    return jsonb_build_object('week_end', v_end, 'week_start', v_end - 6, 'opened', false, 'final', false,
      'as_of', now(), 'totals', jsonb_build_object('cohort', 0, 'on_time', 0, 'miss', 0, 'due', 0, 'pct', null),
      'teams', '[]'::jsonb, 'people', '[]'::jsonb, 'tasks', '[]'::jsonb);
  end if;
  v_final := w.closed_at is not null;
  with r as (
    select c.task_id, t.task_no, t.title, t.space_id, c.department_id, c.owner_employee_id, c.committed_deadline, c.entry_reason,
           c.entered_at, t.status, t.completed_at, coalesce(t.revised_deadline, t.deadline) as effective_deadline,
           case when v_final then c.outcome
                when t.status = 'done' and (t.completed_at <= c.committed_deadline or c.entry_reason = 'created_done') then 'on_time'
                when t.status in ('done', 'abandoned') or c.committed_deadline < now() then 'miss'
                else 'due' end as outcome,
           case when v_final then c.miss_reason
                when t.status = 'done' and (t.completed_at <= c.committed_deadline or c.entry_reason = 'created_done') then null
                when t.status = 'abandoned' then 'abandoned'
                when t.status = 'done' then 'done_late'
                when c.committed_deadline < now() then 'open'
                else null end as miss_reason
      from docket.week_commitments c join docket.tasks t on t.id = c.task_id
     where c.week_end = w.week_end
  ), agg as (
    select department_id, owner_employee_id, outcome from r
  )
  select
    coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('redated', r.effective_deadline is distinct from r.committed_deadline)
                               order by r.department_id nulls last, r.committed_deadline, r.task_no) from r), '[]'::jsonb),
    (select jsonb_build_object('cohort', count(*), 'on_time', count(*) filter (where outcome = 'on_time'),
            'miss', count(*) filter (where outcome = 'miss'), 'due', count(*) filter (where outcome = 'due')) from agg),
    coalesce((select jsonb_agg(x order by x->>'department_id' nulls last) from (
       select jsonb_build_object('department_id', department_id, 'cohort', count(*),
              'on_time', count(*) filter (where outcome = 'on_time'), 'miss', count(*) filter (where outcome = 'miss'),
              'due', count(*) filter (where outcome = 'due')) x
         from agg group by department_id) s), '[]'::jsonb),
    coalesce((select jsonb_agg(x order by x->>'owner_employee_id' nulls last) from (
       select jsonb_build_object('owner_employee_id', owner_employee_id, 'cohort', count(*),
              'on_time', count(*) filter (where outcome = 'on_time'), 'miss', count(*) filter (where outcome = 'miss'),
              'due', count(*) filter (where outcome = 'due')) x
         from agg group by owner_employee_id) s), '[]'::jsonb)
  into v_rows, v_tot, v_teams, v_people;
  return jsonb_build_object(
    'week_end', w.week_end, 'week_start', w.week_start, 'week_end_dow', w.week_end_dow,
    'starts_at', w.starts_at, 'cutoff_at', w.cutoff_at, 'opened', true, 'opened_at', w.opened_at,
    'opened_late', w.opened_late, 'closed_at', w.closed_at, 'final', v_final, 'scoring_version', w.scoring_version,
    'as_of', now(), 'totals', docket.score_pct(v_tot, v_final),
    'teams', (select coalesce(jsonb_agg(docket.score_pct(e, v_final)), '[]'::jsonb) from jsonb_array_elements(v_teams) e),
    'people', (select coalesce(jsonb_agg(docket.score_pct(e, v_final)), '[]'::jsonb) from jsonb_array_elements(v_people) e),
    'tasks', v_rows);
end $$;

revoke all on function docket.week_score(date), docket.week_close(date) from public, anon, authenticated;
grant execute on function docket.week_score(date), docket.week_close(date) to service_role;
