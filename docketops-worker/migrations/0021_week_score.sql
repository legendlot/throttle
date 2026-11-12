-- F9 R5 — the score (spec docs/superpowers/specs/2026-11-11-docket-plan-layer.md §8.2, §6).
--
-- 1. Deadlines change in ONE transactional path: docket.task_set_deadline (first set → `deadline`, the
--    immutable original; afterwards → `revised_deadline`, reason required). An AFTER trigger writes the
--    task_history row in the same transaction (it used to be a second call whose failure was ignored).
--    INSERT keeps the worker's own history rows. 0023 adds the BEFORE guard that refuses every other
--    UPDATE of either column — applied AFTER the worker that calls the RPC is live.
-- 2. docket.weeks + docket.week_commitments — the frozen weekly cohort. Opened at week start (S 00:00 IST)
--    with every top-level, non-recurring, open, non-archived task whose effective deadline is in the week;
--    a task enters mid-week only when its FIRST deadline is set inside the current week. Re-dating never
--    enters or removes a task. Team + owner are frozen at entry.
-- 3. Closed at E+1 00:00 IST: each row's outcome is frozen (on_time = done AND completed_at ≤ the committed
--    deadline; everything else a miss: open / done_late / abandoned).
-- 4. docket.week_tick() opens the current week and closes finished ones; pg_cron runs it every 5 minutes
--    (silent — no Slack, no email; docketops keeps no cron of its own, decisions 2026-08-25).
-- 5. docket.week_score(date) — the score for the week holding that date: final once closed, provisional
--    (on time / missed so far / still due) while open.

-- ── week math (the SQL twin of docketops-worker/src/weeks-core.mjs) ───────────────────────────────────
create or replace function docket.week_end_dow() returns int
language sql stable set search_path to 'docket', 'public' as $$
  select coalesce((select case when jsonb_typeof(value) = 'number' and (value #>> '{}')::numeric in (1,2,3,4,5,6,7)
                               then (value #>> '{}')::int end
                     from docket.settings where key = 'week_end_dow'), 7)
$$;

-- The week-ending date of the week holding date d (d itself when it falls on the week-end day).
create or replace function docket.week_end_of(p_d date, p_dow int) returns date
language sql immutable as $$
  select p_d + ((p_dow - extract(isodow from p_d)::int + 7) % 7)
$$;

-- The week-ending date holding a timestamp's IST date, at the current setting.
create or replace function docket.week_end_at(p_ts timestamptz) returns date
language sql stable set search_path to 'docket', 'public' as $$
  select docket.week_end_of((p_ts at time zone 'Asia/Kolkata')::date, docket.week_end_dow())
$$;

-- 00:00 IST of a date.
create or replace function docket.ist_midnight(p_d date) returns timestamptz
language sql immutable as $$
  select p_d::timestamp at time zone 'Asia/Kolkata'
$$;

-- ── the ledger ────────────────────────────────────────────────────────────────────────────────────────
create table if not exists docket.weeks (
  week_end        date primary key,
  week_start      date not null,
  week_end_dow    int  not null check (week_end_dow between 1 and 7),
  starts_at       timestamptz not null,
  cutoff_at       timestamptz not null,
  opened_at       timestamptz not null default now(),
  opened_late     boolean not null,            -- opened more than an hour after S 00:00 (cohort "as of" then)
  closed_at       timestamptz,
  scoring_version int not null default 1,
  check (week_start = week_end - 6),
  check (closed_at is null or closed_at >= cutoff_at)
);

create table if not exists docket.week_commitments (
  week_end           date not null references docket.weeks(week_end),
  task_id            uuid not null references docket.tasks(id),
  committed_deadline timestamptz not null,
  department_id      uuid,
  owner_employee_id  uuid,
  entered_at         timestamptz not null default now(),
  entry_reason       text not null check (entry_reason in ('week_start', 'first_commitment')),
  outcome            text check (outcome in ('on_time', 'miss')),
  miss_reason        text check (miss_reason in ('open', 'done_late', 'abandoned')),
  primary key (week_end, task_id),
  constraint week_commitments_outcome_shape check (
    (outcome is null and miss_reason is null) or (outcome = 'on_time' and miss_reason is null)
    or (outcome = 'miss' and miss_reason is not null))
);
create index if not exists week_commitments_task_idx on docket.week_commitments (task_id);

-- Frozen means frozen: once a week is closed its rows never change (the score is a ledger, §2.4).
create or replace function docket.week_commitments_frozen() returns trigger
language plpgsql set search_path to 'docket', 'public' as $$
declare v_closed timestamptz;
begin
  select closed_at into v_closed from docket.weeks where week_end = coalesce(OLD.week_end, NEW.week_end);
  if v_closed is not null then
    raise exception 'week_closed' using errcode = 'check_violation';
  end if;
  return coalesce(NEW, OLD);
end $$;
drop trigger if exists week_commitments_frozen on docket.week_commitments;
create trigger week_commitments_frozen before insert or update or delete on docket.week_commitments
  for each row execute function docket.week_commitments_frozen();

alter table docket.weeks enable row level security;
alter table docket.week_commitments enable row level security;
revoke all on docket.weeks, docket.week_commitments from public, anon, authenticated;
grant all on docket.weeks, docket.week_commitments to service_role;

-- ── open / close / tick ───────────────────────────────────────────────────────────────────────────────
-- Opens the week holding p_date (any date in it), snapshotting the cohort as of NOW. Idempotent: a week
-- already open returns 0. A week that hasn't started yet is refused. Returns the rows inserted.
create or replace function docket.week_open(p_date date) returns int
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare
  v_dow int := docket.week_end_dow();
  v_end date := docket.week_end_of(p_date, v_dow);
  v_start timestamptz := docket.ist_midnight(v_end - 6);
  v_cut timestamptz := docket.ist_midnight(v_end + 1);
  v_got date; n int;
begin
  if p_date is null then raise exception 'date_required' using errcode = 'check_violation'; end if;
  if v_start > now() then raise exception 'week_not_started' using errcode = 'check_violation'; end if;
  insert into docket.weeks (week_end, week_start, week_end_dow, starts_at, cutoff_at, opened_at, opened_late)
  values (v_end, v_end - 6, v_dow, v_start, v_cut, now(), now() > v_start + interval '1 hour')
  on conflict (week_end) do nothing
  returning week_end into v_got;
  if v_got is null then return 0; end if;
  insert into docket.week_commitments (week_end, task_id, committed_deadline, department_id, owner_employee_id, entered_at, entry_reason)
  select v_end, t.id, coalesce(t.revised_deadline, t.deadline), t.department_id, t.owner_employee_id, now(), 'week_start'
    from docket.tasks t
    left join docket.spaces s on s.id = t.space_id
   where t.parent_task_id is null and not coalesce(t.is_recurring, false)
     and t.status in ('not_started', 'in_progress', 'blocked')
     and t.archived_at is null and s.archived_at is null
     and coalesce(t.revised_deadline, t.deadline) >= v_start
     and coalesce(t.revised_deadline, t.deadline) <  v_cut
  on conflict (week_end, task_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Freezes the outcome of every row of a finished week. Idempotent (a closed week returns 0); a week still
-- running is refused. Reads the task as it stands at close (the tick runs every 5 minutes).
create or replace function docket.week_close(p_week_end date) returns int
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare w docket.weeks; n int;
begin
  select * into w from docket.weeks where week_end = p_week_end for update;
  if not found then raise exception 'week_not_open' using errcode = 'check_violation'; end if;
  if w.closed_at is not null then return 0; end if;
  if now() < w.cutoff_at then raise exception 'week_not_over' using errcode = 'check_violation'; end if;
  update docket.week_commitments c
     set outcome = case when t.status = 'done' and t.completed_at <= c.committed_deadline then 'on_time' else 'miss' end,
         miss_reason = case when t.status = 'done' and t.completed_at <= c.committed_deadline then null
                            when t.status = 'abandoned' then 'abandoned'
                            when t.status = 'done' then 'done_late'
                            else 'open' end
    from docket.tasks t
   where t.id = c.task_id and c.week_end = p_week_end;
  get diagnostics n = row_count;
  update docket.weeks set closed_at = now() where week_end = p_week_end;
  return n;
end $$;

create or replace function docket.week_tick() returns jsonb
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date; v_opened int; v_closed jsonb := '[]'::jsonb; w record;
begin
  v_opened := docket.week_open(v_today);
  for w in select week_end from docket.weeks where closed_at is null and cutoff_at <= now() order by week_end loop
    perform docket.week_close(w.week_end);
    v_closed := v_closed || to_jsonb(w.week_end);
  end loop;
  return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end $$;

-- ── deadlines: one transactional path ─────────────────────────────────────────────────────────────────
-- For each id: no deadline at all → `deadline` (the first, immutable); otherwise → `revised_deadline`
-- (reason required). Already at p_value / abandoned → untouched. The caller (docketops) has already
-- checked edit rights. Returns { first: [ids], revised: [ids] }.
create or replace function docket.task_set_deadline(p_actor uuid, p_ids uuid[], p_value timestamptz, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_first uuid[]; v_rev uuid[];
begin
  if p_value is null then raise exception 'value_required' using errcode = 'check_violation'; end if;
  if p_reason is not null and length(p_reason) > 2000 then raise exception 'reason_too_long' using errcode = 'check_violation'; end if;
  perform 1 from docket.tasks where id = any(p_ids) order by id for update;
  select coalesce(array_agg(id) filter (where deadline is null and revised_deadline is null), '{}'),
         coalesce(array_agg(id) filter (where coalesce(revised_deadline, deadline) is not null
                                          and coalesce(revised_deadline, deadline) <> p_value), '{}')
    into v_first, v_rev
    from docket.tasks where id = any(p_ids) and status <> 'abandoned';
  if cardinality(v_rev) > 0 and v_reason is null then
    raise exception 'reason_required' using errcode = 'check_violation';
  end if;
  perform set_config('docket.deadline_rpc', 'on', true);
  perform set_config('docket.deadline_reason', coalesce(v_reason, ''), true);
  update docket.tasks set deadline = p_value, updated_by = p_actor, updated_at = now() where id = any(v_first);
  update docket.tasks set revised_deadline = p_value, updated_by = p_actor, updated_at = now() where id = any(v_rev);
  perform set_config('docket.deadline_rpc', '', true);
  perform set_config('docket.deadline_reason', '', true);
  return jsonb_build_object('first', to_jsonb(v_first), 'revised', to_jsonb(v_rev));
end $$;

create or replace function docket.iso_utc(p_ts timestamptz) returns text
language sql immutable as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function docket.tasks_deadline_after() returns trigger
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare
  v_old timestamptz; v_new timestamptz := coalesce(NEW.revised_deadline, NEW.deadline);
  v_reason text := nullif(current_setting('docket.deadline_reason', true), '');
  v_week date;
begin
  if TG_OP = 'UPDATE' then
    v_old := coalesce(OLD.revised_deadline, OLD.deadline);
    -- History only for writes through task_set_deadline (0023's guard makes that the only path).
    if not coalesce(NEW.is_recurring, false) and coalesce(current_setting('docket.deadline_rpc', true), '') = 'on' then
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
      perform docket.week_open((now() at time zone 'Asia/Kolkata')::date);   -- no-op unless the tick hasn't run yet
      insert into docket.week_commitments (week_end, task_id, committed_deadline, department_id, owner_employee_id, entered_at, entry_reason)
      values (v_week, NEW.id, v_new, NEW.department_id, NEW.owner_employee_id, now(), 'first_commitment')
      on conflict (week_end, task_id) do update set entry_reason = 'first_commitment'
        where docket.week_commitments.entry_reason = 'week_start' and docket.week_commitments.entered_at = now();
    end if;
  end if;
  return null;
end $$;
drop trigger if exists tasks_deadline_after on docket.tasks;
create trigger tasks_deadline_after after insert or update of deadline, revised_deadline on docket.tasks
  for each row execute function docket.tasks_deadline_after();

-- ── the score ─────────────────────────────────────────────────────────────────────────────────────────
-- The week holding p_date. Final (frozen outcomes) once closed; otherwise provisional: on_time (done by
-- the committed deadline), miss (abandoned, done late, or the committed deadline has passed), due (still
-- ahead). pct: final = on_time ÷ cohort; provisional = on_time ÷ (on_time + miss), with `due` beside it.
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
    select c.task_id, t.task_no, t.title, c.department_id, c.owner_employee_id, c.committed_deadline, c.entry_reason,
           c.entered_at, t.status, t.completed_at, coalesce(t.revised_deadline, t.deadline) as effective_deadline,
           case when v_final then c.outcome
                when t.status = 'done' and t.completed_at <= c.committed_deadline then 'on_time'
                when t.status in ('done', 'abandoned') or c.committed_deadline < now() then 'miss'
                else 'due' end as outcome,
           case when v_final then c.miss_reason
                when t.status = 'done' and t.completed_at <= c.committed_deadline then null
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

-- Adds `pct` (one decimal) to a {cohort, on_time, miss, due} block.
create or replace function docket.score_pct(p jsonb, p_final boolean) returns jsonb
language sql immutable as $$
  select p || jsonb_build_object('pct', case
    when p_final and (p->>'cohort')::int > 0 then round(100.0 * (p->>'on_time')::int / (p->>'cohort')::int, 1)
    when not p_final and (p->>'on_time')::int + (p->>'miss')::int > 0
      then round(100.0 * (p->>'on_time')::int / ((p->>'on_time')::int + (p->>'miss')::int), 1)
    else null end)
$$;

revoke all on function docket.week_open(date), docket.week_close(date), docket.week_tick(),
  docket.task_set_deadline(uuid, uuid[], timestamptz, text), docket.week_score(date)
  from public, anon, authenticated;
grant execute on function docket.week_open(date), docket.week_close(date), docket.week_tick(),
  docket.task_set_deadline(uuid, uuid[], timestamptz, text), docket.week_score(date) to service_role;

-- Open the current week now (late — it started before this release; weeks from the next are exact).
select docket.week_tick();

-- Every 5 minutes: open the current week at S 00:00 IST, close finished ones at E+1 00:00 IST.
select cron.schedule('docket-week-tick', '*/5 * * * *', $$select docket.week_tick()$$);
