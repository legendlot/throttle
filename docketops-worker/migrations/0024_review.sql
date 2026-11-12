-- F9 R6a — the review pack's storage (spec §8.3, §8.5, §8.6).
-- 1. task_history.source (app | connector | slack | system): an update made through the connector counts as
--    a qualifying update but is shown as such. docketops stamps it from the gateway's X-LOT-Source header;
--    task_set_deadline gains p_source and its trigger stamps the row it writes.
-- 2. docket.review_snapshots — `final` written by week_close (the frozen week_score payload, whole org);
--    `provisional` stored by the Friday "held" button. Payloads are full; reads re-project for the viewer.
-- 3. docket.founder_focus — each founder's top 5 for a week (§8.6), set in the app or by their Claude.

alter table docket.task_history add column if not exists source text not null default 'app';
alter table docket.task_history drop constraint if exists task_history_source_check;
alter table docket.task_history add constraint task_history_source_check
  check (source in ('app', 'connector', 'slack', 'system'));

-- ── deadline RPC: + p_source ──────────────────────────────────────────────────────────────────────────
drop function if exists docket.task_set_deadline(uuid, uuid[], timestamptz, text);
create or replace function docket.task_set_deadline(p_actor uuid, p_ids uuid[], p_value timestamptz, p_reason text default null,
                                                    p_source text default 'app')
returns jsonb
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_first uuid[]; v_rev uuid[];
begin
  if p_value is null then raise exception 'value_required' using errcode = 'check_violation'; end if;
  if p_reason is not null and length(p_reason) > 2000 then raise exception 'reason_too_long' using errcode = 'check_violation'; end if;
  if coalesce(p_source, 'app') not in ('app', 'connector', 'slack', 'system') then
    raise exception 'bad_source' using errcode = 'check_violation';
  end if;
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
  perform set_config('docket.source', coalesce(p_source, 'app'), true);
  update docket.tasks set deadline = p_value, updated_by = p_actor, updated_at = now() where id = any(v_first);
  update docket.tasks set revised_deadline = p_value, updated_by = p_actor, updated_at = now() where id = any(v_rev);
  perform set_config('docket.deadline_rpc', '', true);
  perform set_config('docket.deadline_reason', '', true);
  perform set_config('docket.source', '', true);
  return jsonb_build_object('first', to_jsonb(v_first), 'revised', to_jsonb(v_rev));
end $$;
revoke all on function docket.task_set_deadline(uuid, uuid[], timestamptz, text, text) from public, anon, authenticated;
grant execute on function docket.task_set_deadline(uuid, uuid[], timestamptz, text, text) to service_role;

create or replace function docket.tasks_deadline_after() returns trigger
language plpgsql security definer set search_path to 'docket', 'public' as $$
declare
  v_old timestamptz; v_new timestamptz := coalesce(NEW.revised_deadline, NEW.deadline);
  v_reason text := nullif(current_setting('docket.deadline_reason', true), '');
  v_source text := coalesce(nullif(current_setting('docket.source', true), ''), 'app');
  v_week date; v_entry text;
begin
  if TG_OP = 'UPDATE' then
    v_old := coalesce(OLD.revised_deadline, OLD.deadline);
    -- History only for writes through task_set_deadline (0023's guard makes that the only path).
    if coalesce(current_setting('docket.deadline_rpc', true), '') = 'on' then
      if NEW.deadline is distinct from OLD.deadline then
        insert into docket.task_history (task_id, actor_user_id, event_type, field, new_value, source)
        values (NEW.id, NEW.updated_by, 'deadline_set', 'deadline', docket.iso_utc(NEW.deadline), v_source);
      end if;
      if NEW.revised_deadline is distinct from OLD.revised_deadline then
        insert into docket.task_history (task_id, actor_user_id, event_type, field, old_value, new_value, note, source)
        values (NEW.id, NEW.updated_by, 'deadline_revised', 'revised_deadline', docket.iso_utc(v_old),
                docket.iso_utc(NEW.revised_deadline), v_reason, v_source);
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

-- ── snapshots ─────────────────────────────────────────────────────────────────────────────────────────
create table if not exists docket.review_snapshots (
  id              uuid primary key default gen_random_uuid(),
  week_end        date not null references docket.weeks(week_end),
  kind            text not null check (kind in ('provisional', 'final')),
  department_id   uuid,                       -- null = the whole org
  payload         jsonb not null,
  scoring_version int not null,
  week_end_dow    int not null,
  cutoff_at       timestamptz not null,
  created_at      timestamptz not null default now(),
  created_by      uuid                        -- null = the system (week_close)
);
create unique index if not exists review_snapshots_one_final on docket.review_snapshots (week_end) where kind = 'final' and department_id is null;
create index if not exists review_snapshots_week_idx on docket.review_snapshots (week_end, kind, created_at desc);
-- A snapshot is a record: never edited, never deleted.
create or replace function docket.review_snapshots_immutable() returns trigger
language plpgsql set search_path to 'docket', 'public' as $$
begin raise exception 'snapshot_immutable' using errcode = 'check_violation'; end $$;
drop trigger if exists review_snapshots_immutable on docket.review_snapshots;
create trigger review_snapshots_immutable before update or delete on docket.review_snapshots
  for each row execute function docket.review_snapshots_immutable();
alter table docket.review_snapshots enable row level security;
revoke all on docket.review_snapshots from public, anon, authenticated;
grant all on docket.review_snapshots to service_role;

-- week_close as in 0022, + the final snapshot (the frozen score, whole org) in the same transaction.
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
  insert into docket.review_snapshots (week_end, kind, department_id, payload, scoring_version, week_end_dow, cutoff_at, created_by)
  values (p_week_end, 'final', null, docket.week_score(p_week_end), w.scoring_version, w.week_end_dow, w.cutoff_at, null);
  return n;
end $$;
revoke all on function docket.week_close(date) from public, anon, authenticated;
grant execute on function docket.week_close(date) to service_role;

-- ── the founders' top 5 ───────────────────────────────────────────────────────────────────────────────
create table if not exists docket.founder_focus (
  week_end        date not null,
  founder_user_id uuid not null,
  rank            int  not null check (rank between 1 and 5),
  plan_item_id    uuid references docket.plan_items(id),
  task_id         uuid references docket.tasks(id),
  note            text check (note is null or length(note) <= 500),
  updated_at      timestamptz not null default now(),
  primary key (week_end, founder_user_id, rank),
  check (num_nonnulls(plan_item_id, task_id) <= 1),
  check (plan_item_id is not null or task_id is not null or nullif(btrim(note), '') is not null)
);
alter table docket.founder_focus enable row level security;
revoke all on docket.founder_focus from public, anon, authenticated;
grant all on docket.founder_focus to service_role;
