-- podium_leave_v1 — Leave R1: apply, approve, balances (one ledger), holidays.
-- Plan: docs/superpowers/plans/2026-11-13-podium-leave-r1.md (D1–D15) · spec 2026-11-13-podium-leave-scope.md (L1–L10)
-- · depends on 0006 (touch_updated_at).
-- AUTHORIZATION STAYS IN THE WORKER (src/leave.js + index.js, as 0007–0015): these functions trust their caller
-- (service_role only). All tables RLS-on, no policies, service_role only (RULE-RLS-001 / RULE-PODIUM-002).
-- Live values checked 2026-11-13: employees has gender ('f'/'m'/null), date_joined, date_exited, status
-- (active|on_leave|notice|exited), manager_id, razorpayx_employee_id; legal_entity is NULL for everyone (not used).
-- 56 non-exited employees have a razorpayx_employee_id (the D1 seed). The employees_google_sync_upd trigger fires only
-- on UPDATE OF its own column list, so adding / seeding leave_policy dirties nothing in google_sync_state.
-- Test: test/leave.sql (rolls back) + test/leave.test.mjs.

-- ── D1: coverage ─────────────────────────────────────────────────────────────
alter table podium.employees add column leave_policy text check (leave_policy is null or leave_policy in ('fraternitas'));
-- Coverage history: the worker sets it to the 1st of the current IST month when HR turns coverage on (null → a policy)
-- and leaves it when coverage goes off; accrual starts at max(cutover, join month, this month). null = since the
-- cutover (the D1 seed below), so an off → on gap never back-fills.
alter table podium.employees add column leave_covered_from date;
update podium.employees set leave_policy = 'fraternitas'
 where status <> 'exited' and nullif(btrim(razorpayx_employee_id), '') is not null and leave_policy is null;

-- ── D4: settings singleton ───────────────────────────────────────────────────
create table podium.leave_settings (
  id int primary key default 1 check (id = 1),
  cutover_month text not null default '2026-12' check (cutover_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
insert into podium.leave_settings (id) values (1);

-- ── D13: holidays (date is the key; kind fixed = off for everyone, optional = one per person per year) ──
create table podium.holidays (
  date date primary key,
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null check (kind in ('fixed', 'optional')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 2026 from "LOT List of Holidays -2026" (dates per the plan; names are HR-editable). 2027 must be added before 1 Jan.
insert into podium.holidays (date, name, kind) values
  ('2026-01-01', 'New Year''s Day', 'fixed'),
  ('2026-01-26', 'Republic Day', 'fixed'),
  ('2026-03-20', 'Eid al-Fitr', 'fixed'),
  ('2026-05-01', 'Labour Day', 'fixed'),
  ('2026-08-15', 'Independence Day', 'fixed'),
  ('2026-09-14', 'Ganesh Chaturthi', 'fixed'),
  ('2026-10-02', 'Gandhi Jayanti', 'fixed'),
  ('2026-11-01', 'Kannada Rajyotsava', 'fixed'),
  ('2026-11-07', 'Diwali', 'fixed'),
  ('2026-12-25', 'Christmas', 'fixed'),
  ('2026-01-14', 'Makara Sankranti', 'optional'),
  ('2026-03-04', 'Holi', 'optional'),
  ('2026-03-31', 'Mahaveera Jayanti', 'optional'),
  ('2026-04-03', 'Good Friday', 'optional'),
  ('2026-05-28', 'Bakrid / Eid al-Adha (tentative)', 'optional'),
  ('2026-06-26', 'Last Day of Muharram (tentative)', 'optional'),
  ('2026-10-20', 'Dussehra', 'optional'),
  ('2026-11-09', 'Diwali Day 2', 'optional'),
  ('2026-12-24', 'Christmas Eve', 'optional');

-- ── D8: requests ─────────────────────────────────────────────────────────────
-- days is counted once at submit (work week + holidays at that moment) and frozen. borrowed_days / lop_days are the
-- D7 split, stored at submit and REWRITTEN at approval (leave_decide). A single day carries its half on both fields.
create table podium.leave_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references podium.employees(id),
  leave_type text not null check (leave_type in ('PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY')),
  start_date date not null,
  end_date date not null,
  start_half text not null default 'full',
  end_half text not null default 'full',
  days numeric(5,1) not null check (days > 0 and days <= 60 and days * 2 = trunc(days * 2)),
  borrowed_days numeric(5,1) not null default 0 check (borrowed_days >= 0 and borrowed_days * 2 = trunc(borrowed_days * 2)),
  lop_days numeric(5,1) not null default 0 check (lop_days >= 0 and lop_days * 2 = trunc(lop_days * 2)),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')),
  reason text check (reason is null or length(reason) <= 500),
  approver_employee_id uuid references podium.employees(id),   -- snapshot at submit; null = HR decides (D9)
  decided_by uuid,
  decided_by_employee_id uuid references podium.employees(id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_note text check (cancel_note is null or length(cancel_note) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (extract(year from start_date) = extract(year from end_date)),                  -- D6 crosses_year
  check ((start_date = end_date and start_half in ('full', 'first', 'second') and end_half = start_half)
      or (start_date < end_date and start_half in ('full', 'second') and end_half in ('full', 'first'))),
  check (borrowed_days + lop_days <= days),
  check (leave_type in ('PL', 'SL') or (borrowed_days = 0 and lop_days = 0)),
  check (leave_type <> 'PERIOD' or (start_date = end_date and days <= 1)),
  check (leave_type <> 'OPTIONAL_HOLIDAY' or (start_date = end_date and start_half = 'full')),
  constraint leave_requests_no_self_approval check (decided_by_employee_id is null or decided_by_employee_id <> employee_id),
  check ((status in ('pending', 'withdrawn')) = (decided_at is null)),
  check ((status in ('withdrawn', 'cancelled')) = (cancelled_at is not null)),
  check (status <> 'rejected' or decision_note is not null)
);
create index leave_requests_employee_idx on podium.leave_requests (employee_id, start_date);
create index leave_requests_pending_idx on podium.leave_requests (approver_employee_id) where status = 'pending';
create index leave_requests_dates_idx on podium.leave_requests (start_date, end_date) where status in ('pending', 'approved');
create trigger leave_requests_touch before update on podium.leave_requests for each row execute function podium.touch_updated_at();

-- ── D3: the ledger = the only balance (PL / SL). Balance(type) = Σ delta ──────
-- period: YYYY-MM for accrual, YYYY for carry_over / lapse, null otherwise. The unique (employee, type, kind, period)
-- constrains only the rows that HAVE a period (NULLs are distinct), i.e. accrual / carry_over / lapse — the D3 partial
-- unique, written as a plain constraint so the worker's lazy writer can use PostgREST on_conflict + ignore-duplicates.
-- delta may be 0 only on an opening row (an opening of 0 still records "opening set", L5).
create table podium.leave_ledger (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references podium.employees(id),
  leave_type text not null check (leave_type in ('PL', 'SL')),
  delta numeric(5,1) not null check (delta * 2 = trunc(delta * 2)),
  kind text not null check (kind in ('opening', 'accrual', 'taken', 'cancelled', 'carry_over', 'lapse', 'adjustment')),
  period text,
  effective_date date not null,
  request_id uuid references podium.leave_requests(id),
  note text check (note is null or length(note) <= 500),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (delta <> 0 or kind = 'opening'),
  check ((kind = 'accrual' and period is not null and period ~ '^\d{4}-(0[1-9]|1[0-2])$')
      or (kind in ('carry_over', 'lapse') and period is not null and period ~ '^\d{4}$')
      or (kind not in ('accrual', 'carry_over', 'lapse') and period is null)),
  check ((kind in ('taken', 'cancelled')) = (request_id is not null)),
  check (kind <> 'adjustment' or note is not null),
  check (kind <> 'taken' or delta < 0),
  check (kind <> 'cancelled' or delta > 0),
  check (kind <> 'accrual' or delta > 0),
  check (kind <> 'lapse' or delta < 0),
  constraint leave_ledger_period_unique unique (employee_id, leave_type, kind, period)
);
create unique index leave_ledger_opening_unique on podium.leave_ledger (employee_id, leave_type) where kind = 'opening';
-- One debit and one credit per request, ever (a double approve / double cancel cannot double-post).
create unique index leave_ledger_request_unique on podium.leave_ledger (request_id, kind) where request_id is not null;
create index leave_ledger_employee_idx on podium.leave_ledger (employee_id, leave_type, effective_date);

-- ── D5: year-close marker (delta must be ≠ 0, so "closed, nothing lapsed" lives here) ──
create table podium.leave_year_closes (
  employee_id uuid not null references podium.employees(id),
  year int not null check (year between 2000 and 2100),
  closed_at timestamptz not null default now(),
  primary key (employee_id, year)
);

-- ── D14: events (requests + every HR write). detail carries ids, types and counts — never the reason ──
create table podium.leave_events (
  id bigint generated always as identity primary key,
  employee_id uuid references podium.employees(id),
  request_id uuid references podium.leave_requests(id),
  actor_user_id uuid,
  actor_employee_id uuid,
  event_type text not null check (event_type in ('applied', 'approved', 'rejected', 'withdrawn', 'cancelled',
    'opening_set', 'adjusted', 'settings_changed', 'holiday_saved', 'holiday_deleted', 'coverage_changed', 'year_reclosed')),
  detail jsonb,
  created_at timestamptz not null default now()
);
create index leave_events_employee_idx on podium.leave_events (employee_id, created_at);
create index leave_events_request_idx on podium.leave_events (request_id);

create trigger holidays_touch before update on podium.holidays for each row execute function podium.touch_updated_at();
create trigger leave_settings_touch before update on podium.leave_settings for each row execute function podium.touch_updated_at();

-- ── RLS: on, no policies; service_role only ──────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['leave_settings', 'holidays', 'leave_requests', 'leave_ledger', 'leave_year_closes', 'leave_events'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- Per-employee advisory lock (transaction scope): apply / decide / cancel for one person run one at a time, so the
-- overlap, monthly / yearly limit and balance-snapshot checks below cannot race.
create or replace function podium.leave_lock(p_employee uuid) returns void language sql
set search_path to 'podium', 'public' as $$
  select pg_advisory_xact_lock(hashtextextended('podium.leave:' || p_employee::text, 0));
$$;

-- PL / SL: the balance the worker computed its split from must still hold — Σ ledger and the other pending requests'
-- debit Σ (days − lop_days). Anything else moved → 'balance_changed' (the UI reloads, D7).
create or replace function podium.leave_check_snapshot(p_employee uuid, p_type text, p_except uuid, p jsonb) returns void
language plpgsql set search_path to 'podium', 'public' as $$
declare
  v_bal numeric;
  v_pend numeric;
begin
  if p->>'expected_balance' is null or p->>'expected_pending' is null then raise exception 'balance_changed'; end if;
  select coalesce(sum(delta), 0) into v_bal from podium.leave_ledger where employee_id = p_employee and leave_type = p_type;
  select coalesce(sum(days - lop_days), 0) into v_pend from podium.leave_requests
   where employee_id = p_employee and leave_type = p_type and status = 'pending' and id is distinct from p_except;
  if v_bal <> (p->>'expected_balance')::numeric or v_pend <> (p->>'expected_pending')::numeric then
    raise exception 'balance_changed';
  end if;
end $$;

-- ── Re-close (D5) after a late change: approve / cancel of a PL / SL request whose year Y is already closed ──
-- For Y and each consecutive closed year after it (a later closing chains on Y's lapse): closing = Σ delta of the type
-- with effective_date ≤ Y-12-31 EXCLUDING Y's own lapse row; keep = 5 PL / 0 SL; the lapse row (period = Y) becomes
-- −(closing − keep) when closing > keep, else it is deleted (delta must stay ≠ 0). Each change → a 'year_reclosed'
-- event {year, leave_type, old, new}. Mirror: leave.js reclosePlan. Runs under the caller's per-employee lock.
create or replace function podium.leave_reclose(p_employee uuid, p_type text, p_year int, p_actor uuid, p_actor_emp uuid) returns void
language plpgsql set search_path to 'podium', 'public' as $$
declare
  y       int := p_year;
  v_keep  numeric := case when p_type = 'PL' then 5 else 0 end;
  v_close numeric;
  v_old   numeric;
  v_new   numeric;
  v_guard int := 0;
begin
  if p_type not in ('PL', 'SL') then return; end if;
  while v_guard < 100 and exists (select 1 from podium.leave_year_closes where employee_id = p_employee and year = y) loop
    v_old := null;
    select delta into v_old from podium.leave_ledger
     where employee_id = p_employee and leave_type = p_type and kind = 'lapse' and period = y::text;
    select coalesce(sum(delta), 0) into v_close from podium.leave_ledger
     where employee_id = p_employee and leave_type = p_type and effective_date <= make_date(y, 12, 31)
       and not (kind = 'lapse' and period = y::text);
    v_new := case when v_close > v_keep then -(v_close - v_keep) else null end;
    if v_new is distinct from v_old then
      if v_new is null then
        delete from podium.leave_ledger where employee_id = p_employee and leave_type = p_type and kind = 'lapse' and period = y::text;
      elsif v_old is null then
        insert into podium.leave_ledger (employee_id, leave_type, delta, kind, period, effective_date, created_by)
        values (p_employee, p_type, v_new, 'lapse', y::text, make_date(y, 12, 31), p_actor);
      else
        update podium.leave_ledger set delta = v_new
         where employee_id = p_employee and leave_type = p_type and kind = 'lapse' and period = y::text;
      end if;
      insert into podium.leave_events (employee_id, actor_user_id, actor_employee_id, event_type, detail)
      values (p_employee, p_actor, p_actor_emp, 'year_reclosed',
        jsonb_build_object('year', y, 'leave_type', p_type, 'old', v_old, 'new', v_new));
    end if;
    y := y + 1;
    v_guard := v_guard + 1;
  end loop;
end $$;

-- ── Apply: request pending + event, ONE transaction, under the per-employee lock ──
-- p = { employee_id, leave_type, start_date, end_date, start_half, end_half, days, borrowed_days, lop_days, reason,
--       approver_employee_id, expected_balance, expected_pending (PL/SL), actor_user_id, actor_employee_id }
-- The worker has validated the input (leave.js validateLeaveInput) and computed days + split. raise 'not_covered',
-- 'overlap' (any type, pending/approved, overlapping dates), 'period_used' (> 1 day in that month),
-- 'optional_used' (one per year), 'not_optional_holiday', 'balance_changed'.
create or replace function podium.leave_apply(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_emp       uuid := (p->>'employee_id')::uuid;
  v_type      text := p->>'leave_type';
  v_start     date := (p->>'start_date')::date;
  v_end       date := (p->>'end_date')::date;
  v_days      numeric := (p->>'days')::numeric;
  v_used      numeric;
  v_req       podium.leave_requests;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  perform podium.leave_lock(v_emp);
  if not exists (select 1 from podium.employees where id = v_emp and leave_policy is not null and status <> 'exited') then
    raise exception 'not_covered';
  end if;
  if exists (select 1 from podium.leave_requests where employee_id = v_emp and status in ('pending', 'approved')
              and start_date <= v_end and end_date >= v_start) then
    raise exception 'overlap';
  end if;
  if v_type = 'PERIOD' then
    select coalesce(sum(days), 0) into v_used from podium.leave_requests
     where employee_id = v_emp and leave_type = 'PERIOD' and status in ('pending', 'approved')
       and date_trunc('month', start_date) = date_trunc('month', v_start);
    if v_used + v_days > 1 then raise exception 'period_used'; end if;
  elsif v_type = 'OPTIONAL_HOLIDAY' then
    if not exists (select 1 from podium.holidays where date = v_start and kind = 'optional') then raise exception 'not_optional_holiday'; end if;
    if exists (select 1 from podium.leave_requests where employee_id = v_emp and leave_type = 'OPTIONAL_HOLIDAY'
                and status in ('pending', 'approved') and extract(year from start_date) = extract(year from v_start)) then
      raise exception 'optional_used';
    end if;
  elsif v_type in ('PL', 'SL') then
    perform podium.leave_check_snapshot(v_emp, v_type, null, p);
  end if;

  insert into podium.leave_requests (employee_id, leave_type, start_date, end_date, start_half, end_half, days,
    borrowed_days, lop_days, reason, approver_employee_id, created_by)
  values (v_emp, v_type, v_start, v_end, coalesce(p->>'start_half', 'full'), coalesce(p->>'end_half', 'full'), v_days,
    coalesce((p->>'borrowed_days')::numeric, 0), coalesce((p->>'lop_days')::numeric, 0),
    nullif(btrim(coalesce(p->>'reason', '')), ''), nullif(p->>'approver_employee_id', '')::uuid, v_actor)
  returning * into v_req;

  insert into podium.leave_events (employee_id, request_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_emp, v_req.id, v_actor, v_actor_emp, 'applied',
    jsonb_build_object('leave_type', v_type, 'days', v_days, 'borrowed_days', v_req.borrowed_days, 'lop_days', v_req.lop_days));
  return to_jsonb(v_req);
end $$;

-- ── Decide (D9): approve → request approved + ledger taken −(days − lop_days) for PL/SL (+ leave_reclose when the
-- request's year is already closed); reject → note required ──
-- p = { request_id, decision: approve|reject, note, borrowed_days, lop_days, expected_balance, expected_pending,
--       actor_user_id, actor_employee_id }
-- The worker checked who may decide and that the approver's expected_split equals the split it recomputed; the
-- balance snapshot is re-checked here under the lock. raise 'not_found', 'not_pending', 'no_self_approval',
-- 'note_required', 'bad_decision', 'balance_changed'.
create or replace function podium.leave_decide(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_id        uuid := (p->>'request_id')::uuid;
  v_emp       uuid;
  v_req       podium.leave_requests;
  v_dec       text := p->>'decision';
  v_note      text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_debit     numeric;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  if v_dec is null or v_dec not in ('approve', 'reject') then raise exception 'bad_decision'; end if;
  select employee_id into v_emp from podium.leave_requests where id = v_id;
  if not found then raise exception 'not_found'; end if;
  perform podium.leave_lock(v_emp);
  select * into v_req from podium.leave_requests where id = v_id for update;
  if v_req.status <> 'pending' then raise exception 'not_pending'; end if;
  if v_actor_emp is not null and v_actor_emp = v_req.employee_id then raise exception 'no_self_approval'; end if;

  if v_dec = 'reject' then
    if v_note is null then raise exception 'note_required'; end if;
    update podium.leave_requests set status = 'rejected', decided_by = v_actor, decided_by_employee_id = v_actor_emp,
        decided_at = now(), decision_note = v_note
     where id = v_id returning * into v_req;
  else
    if v_req.leave_type in ('PL', 'SL') then
      perform podium.leave_check_snapshot(v_req.employee_id, v_req.leave_type, v_req.id, p);
      update podium.leave_requests set status = 'approved', decided_by = v_actor, decided_by_employee_id = v_actor_emp,
          decided_at = now(), decision_note = v_note,
          borrowed_days = coalesce((p->>'borrowed_days')::numeric, 0), lop_days = coalesce((p->>'lop_days')::numeric, 0)
       where id = v_id returning * into v_req;
      v_debit := v_req.days - v_req.lop_days;
      if v_debit > 0 then
        insert into podium.leave_ledger (employee_id, leave_type, delta, kind, effective_date, request_id, created_by)
        values (v_req.employee_id, v_req.leave_type, -v_debit, 'taken', v_req.start_date, v_req.id, v_actor);
        perform podium.leave_reclose(v_req.employee_id, v_req.leave_type, extract(year from v_req.start_date)::int, v_actor, v_actor_emp);
      end if;
    else
      update podium.leave_requests set status = 'approved', decided_by = v_actor, decided_by_employee_id = v_actor_emp,
          decided_at = now(), decision_note = v_note
       where id = v_id returning * into v_req;
    end if;
  end if;

  insert into podium.leave_events (employee_id, request_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_req.employee_id, v_req.id, v_actor, v_actor_emp, case when v_dec = 'approve' then 'approved' else 'rejected' end,
    jsonb_build_object('leave_type', v_req.leave_type, 'days', v_req.days, 'borrowed_days', v_req.borrowed_days, 'lop_days', v_req.lop_days));
  return to_jsonb(v_req);
end $$;

-- ── Withdraw / cancel (D10) ──────────────────────────────────────────────────
-- p = { request_id, mode: withdraw|cancel, note, actor_user_id, actor_employee_id }
-- withdraw: pending → withdrawn. cancel: approved → cancelled + ledger cancelled +(days − lop_days) for PL/SL (dated
-- the leave's start_date, so it nets in the same year; leave_reclose when that year is already closed). The worker
-- checked who may. raise 'not_found', 'bad_mode',
-- 'not_pending', 'not_approved'.
create or replace function podium.leave_cancel(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_id        uuid := (p->>'request_id')::uuid;
  v_mode      text := p->>'mode';
  v_emp       uuid;
  v_req       podium.leave_requests;
  v_credit    numeric;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  if v_mode is null or v_mode not in ('withdraw', 'cancel') then raise exception 'bad_mode'; end if;
  select employee_id into v_emp from podium.leave_requests where id = v_id;
  if not found then raise exception 'not_found'; end if;
  perform podium.leave_lock(v_emp);
  select * into v_req from podium.leave_requests where id = v_id for update;
  if v_mode = 'withdraw' then
    if v_req.status <> 'pending' then raise exception 'not_pending'; end if;
    update podium.leave_requests set status = 'withdrawn', cancelled_by = v_actor, cancelled_at = now(),
        cancel_note = nullif(btrim(coalesce(p->>'note', '')), '')
     where id = v_id returning * into v_req;
  else
    if v_req.status <> 'approved' then raise exception 'not_approved'; end if;
    update podium.leave_requests set status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(),
        cancel_note = nullif(btrim(coalesce(p->>'note', '')), '')
     where id = v_id returning * into v_req;
    v_credit := v_req.days - v_req.lop_days;
    if v_req.leave_type in ('PL', 'SL') and v_credit > 0 then
      insert into podium.leave_ledger (employee_id, leave_type, delta, kind, effective_date, request_id, created_by)
      values (v_req.employee_id, v_req.leave_type, v_credit, 'cancelled', v_req.start_date, v_req.id, v_actor);
      perform podium.leave_reclose(v_req.employee_id, v_req.leave_type, extract(year from v_req.start_date)::int, v_actor, v_actor_emp);
    end if;
  end if;
  insert into podium.leave_events (employee_id, request_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_req.employee_id, v_req.id, v_actor, v_actor_emp, case when v_mode = 'withdraw' then 'withdrawn' else 'cancelled' end,
    jsonb_build_object('leave_type', v_req.leave_type, 'days', v_req.days));
  return to_jsonb(v_req);
end $$;

-- ── Grants: service_role only (Supabase's default privileges also grant anon/authenticated — revoke those too) ──
do $$
declare f text;
begin
  foreach f in array array['leave_apply(jsonb)', 'leave_decide(jsonb)', 'leave_cancel(jsonb)', 'leave_lock(uuid)',
                           'leave_check_snapshot(uuid, text, uuid, jsonb)', 'leave_reclose(uuid, text, int, uuid, uuid)'] loop
    execute format('revoke all on function podium.%s from public, anon, authenticated', f);
    execute format('grant execute on function podium.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
