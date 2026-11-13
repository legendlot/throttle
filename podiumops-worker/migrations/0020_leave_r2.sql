-- 0020_leave_r2.sql — Podium Leave R2. Applied as `podium_leave_r2_v1`.
-- Plan: docs/superpowers/plans/2026-11-13-podium-leave-r2.md (E1–E5) · R1: 0016 (podium_leave_v1) + 0017 (podium_leave_v2)
-- · X1 exits: 0010.
-- 1. leave_requests: types MATERNITY / PATERNITY (HR grants, E3) + WFH (applied, E4); the days cap is 182 for MATERNITY;
--    the crosses-year check is relaxed for MATERNITY / PATERNITY only; grants are full days and never pending.
--    Ledger-free types keep borrowed / lop = 0 — leave_requests_check4 (0016) already covers every non-PL/SL type.
-- 2. podium.leave_grant — HR inserts an APPROVED MATERNITY / PATERNITY request (lock, covered, gender, overlap).
-- 3. podium.leave_lop_exports — the E1 payroll snapshots (one row per "Mark exported").
-- 4. employee_exits.leave_* — the E2 snapshot written when HR ticks "Leave balance confirmed".
-- 5. exit auto_source + 'leave_ledger'; the template line + any OPEN exit's open item move to it; exit_update_item
--    refuses that line's Done while a request is pending / ends after the LWD, and writes / clears the snapshot.
-- 6. exit_close (review A): a DONE leave line must still hold at the close — the LWD it was confirmed for, the ledger
--    sums it saw, no pending request, no open request after the LWD — else 'podium_leave_changed'.
-- Lock order (review B): podium.leave_lock(person) is taken BEFORE `employees … for update` in exit_update_item (leave
-- line) and exit_close (exit with a leave line): the leave RPCs take leave_lock first and then a KEY SHARE on the
-- employees row (FK), so the opposite order could deadlock.
-- Live state read 2026-11-13 (read-only SQL): the constraint names below are the live ones; leave_decide (0017 body) and
-- leave_cancel (0016 body) write ledger rows ONLY inside `leave_type in ('PL', 'SL')` branches, and leave_reclose
-- returns early for any other type — so a WFH / MATERNITY / PATERNITY approve or cancel never touches the ledger and
-- neither function needs a change here. leave_apply runs leave_check_snapshot only for PL / SL (WFH skips it).
-- exit_update_item below = the live 0010 body + the leave_ledger block (marked). No exit has a leave_balance item yet.
-- AUTHORIZATION STAYS IN THE WORKER (src/leave.js + index.js); these functions trust their caller (service_role only).
-- Test: test/leave.test.mjs (pure rules).

-- ── 1. leave_requests ────────────────────────────────────────────────────────
alter table podium.leave_requests drop constraint leave_requests_leave_type_check;
alter table podium.leave_requests add constraint leave_requests_leave_type_check
  check (leave_type in ('PL', 'SL', 'PERIOD', 'OPTIONAL_HOLIDAY', 'MATERNITY', 'PATERNITY', 'WFH'));

alter table podium.leave_requests drop constraint leave_requests_days_check;
alter table podium.leave_requests add constraint leave_requests_days_check
  check (days > 0 and days <= case when leave_type = 'MATERNITY' then 182 else 60 end and days * 2 = trunc(days * 2));

-- D6 crosses_year: MATERNITY / PATERNITY may cross 31 Dec (no ledger, so no year split is needed).
alter table podium.leave_requests drop constraint leave_requests_check1;
alter table podium.leave_requests add constraint leave_requests_check1
  check (leave_type in ('MATERNITY', 'PATERNITY') or extract(year from start_date) = extract(year from end_date));

-- E3: a grant is full days, approved when written (leave_grant), and only ever cancelled after that. MATERNITY is at most
-- 182 calendar days (days = the calendar days in the range); PATERNITY at most 15 working days. "At most" so a person
-- returning early is recorded as cancel + grant again with the actual end date (review C).
alter table podium.leave_requests add constraint leave_requests_grant_shape
  check (leave_type not in ('MATERNITY', 'PATERNITY')
      or (start_half = 'full' and end_half = 'full' and status in ('approved', 'cancelled')));
alter table podium.leave_requests add constraint leave_requests_maternity_span
  check (leave_type <> 'MATERNITY' or (end_date - start_date <= 181 and days = end_date - start_date + 1));
alter table podium.leave_requests add constraint leave_requests_paternity_days
  check (leave_type <> 'PATERNITY' or days <= 15);

alter table podium.leave_events drop constraint leave_events_event_type_check;
alter table podium.leave_events add constraint leave_events_event_type_check
  check (event_type in ('applied', 'approved', 'rejected', 'withdrawn', 'cancelled', 'opening_set', 'adjusted',
    'settings_changed', 'holiday_saved', 'holiday_deleted', 'coverage_changed', 'year_reclosed', 'granted', 'lop_exported'));

-- ── 2. Grant (E3): HR inserts an approved MATERNITY / PATERNITY request, ONE transaction, under the lock ──
-- p = { employee_id, leave_type, start_date, end_date, days, note, actor_user_id, actor_employee_id }
-- The worker computed end_date / days (leave.js grantPlan) and checked isHr. raise 'bad_type', 'no_self_approval',
-- 'not_covered', 'note_required' (MATERNITY), 'gender_unknown', 'maternity_not_eligible', 'paternity_not_eligible',
-- 'overlap'. decided_* = the HR caller; approver_employee_id stays null (HR decides, D9).
create or replace function podium.leave_grant(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_emp       uuid := (p->>'employee_id')::uuid;
  v_type      text := p->>'leave_type';
  v_start     date := (p->>'start_date')::date;
  v_end       date := (p->>'end_date')::date;
  v_days      numeric := (p->>'days')::numeric;
  v_note      text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_gender    text;
  v_req       podium.leave_requests;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  if v_type is null or v_type not in ('MATERNITY', 'PATERNITY') then raise exception 'bad_type'; end if;
  perform podium.leave_lock(v_emp);
  if v_actor_emp is not null and v_actor_emp = v_emp then raise exception 'no_self_approval'; end if;
  if v_actor is not null and exists (select 1 from podium.employees where id = v_emp and auth_user_id = v_actor) then
    raise exception 'no_self_approval';
  end if;
  select gender into v_gender from podium.employees where id = v_emp and leave_policy is not null and status <> 'exited';
  if not found then raise exception 'not_covered'; end if;
  if v_type = 'MATERNITY' and v_note is null then raise exception 'note_required'; end if;
  if v_gender is null then raise exception 'gender_unknown'; end if;
  if v_type = 'MATERNITY' and v_gender <> 'f' then raise exception 'maternity_not_eligible'; end if;
  if v_type = 'PATERNITY' and v_gender <> 'm' then raise exception 'paternity_not_eligible'; end if;
  if exists (select 1 from podium.leave_requests where employee_id = v_emp and status in ('pending', 'approved')
              and start_date <= v_end and end_date >= v_start) then
    raise exception 'overlap';
  end if;

  insert into podium.leave_requests (employee_id, leave_type, start_date, end_date, start_half, end_half, days,
    status, approver_employee_id, decided_by, decided_by_employee_id, decided_at, decision_note, created_by)
  values (v_emp, v_type, v_start, v_end, 'full', 'full', v_days,
    'approved', null, v_actor, v_actor_emp, now(), v_note, v_actor)
  returning * into v_req;

  insert into podium.leave_events (employee_id, request_id, actor_user_id, actor_employee_id, event_type, detail)
  values (v_emp, v_req.id, v_actor, v_actor_emp, 'granted',
    jsonb_build_object('leave_type', v_type, 'days', v_days, 'start_date', v_start, 'end_date', v_end));
  return to_jsonb(v_req);
end $$;

-- ── 3. E1 payroll export snapshots (a new row per "Mark exported"; the report diffs against the latest) ──
-- rows = the report rows at that moment: [{employee_id, employee_code, full_name, razorpayx_employee_id, lop_days, dates}]
create table podium.leave_lop_exports (
  id uuid primary key default gen_random_uuid(),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  rows jsonb not null check (jsonb_typeof(rows) = 'array'),
  exported_by uuid,
  exported_by_employee_id uuid references podium.employees(id),
  exported_at timestamptz not null default now()
);
create index leave_lop_exports_month_idx on podium.leave_lop_exports (month, exported_at desc);
alter table podium.leave_lop_exports enable row level security;
revoke all on podium.leave_lop_exports from anon, authenticated;
grant all on podium.leave_lop_exports to service_role;

-- ── 4. E2 exit snapshot (written by exit_update_item when HR ticks the leave line Done; cleared on re-open) ──
alter table podium.employee_exits
  add column leave_pl_balance numeric(6,1) check (leave_pl_balance is null or leave_pl_balance * 2 = trunc(leave_pl_balance * 2)),
  add column leave_sl_balance numeric(6,1) check (leave_sl_balance is null or leave_sl_balance * 2 = trunc(leave_sl_balance * 2)),
  add column leave_lop_days numeric(6,1) check (leave_lop_days is null or (leave_lop_days >= 0 and leave_lop_days * 2 = trunc(leave_lop_days * 2))),
  add column leave_confirmed_at timestamptz,
  add column leave_confirmed_by uuid,
  -- review A: what the confirmation was computed for — the LWD and the raw Σ ledger per type at that moment.
  add column leave_as_at date,
  add column leave_ledger_pl numeric(6,1),
  add column leave_ledger_sl numeric(6,1);
alter table podium.employee_exits add constraint employee_exits_leave_snapshot_whole
  check ((leave_confirmed_at is null) = (leave_pl_balance is null)
     and (leave_confirmed_at is null) = (leave_sl_balance is null)
     and (leave_confirmed_at is null) = (leave_lop_days is null)
     and (leave_confirmed_at is null) = (leave_as_at is null)
     and (leave_confirmed_at is null) = (leave_ledger_pl is null)
     and (leave_confirmed_at is null) = (leave_ledger_sl is null));

-- ── 5. Exit auto source 'leave_ledger' ───────────────────────────────────────
alter table podium.exit_checklist_lines drop constraint exit_checklist_lines_auto_source_check;
alter table podium.exit_checklist_lines add constraint exit_checklist_lines_auto_source_check
  check (auto_source in ('snorkel_assets', 'open_work', 'payment_requests', 'lot_access', 'leave_ledger'));
alter table podium.exit_checklist_items drop constraint exit_checklist_items_auto_source_check;
alter table podium.exit_checklist_items add constraint exit_checklist_items_auto_source_check
  check (auto_source in ('snorkel_assets', 'open_work', 'payment_requests', 'lot_access', 'leave_ledger'));

update podium.exit_checklist_lines set auto_source = 'leave_ledger', updated_at = now()
 where key = 'leave_balance' and auto_source is null;
update podium.exit_checklist_items i set auto_source = 'leave_ledger'
  from podium.employee_exits x
 where x.id = i.exit_id and x.status = 'open' and i.line_key = 'leave_balance' and i.status = 'open' and i.auto_source is null;

-- exit_update_item = the live 0010 body + the leave_ledger block (and, for that line, the leave lock taken before the
-- employees row lock — review B). p adds, for that line's Done (computed by the worker,
-- leave.js exitLeaveFigures): leave = { pl_balance, sl_balance, lop_days, expected_pl, expected_sl } — expected_* = the
-- raw Σ ledger the figures were computed from; anything else under the leave lock → 'podium_leave_changed'.
-- No leave object (the person is not covered) → the line ticks with no snapshot.
create or replace function podium.exit_update_item(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_it       podium.exit_checklist_items;
  v_x        podium.employee_exits;
  v_e        podium.employees;
  v_status   text := p->>'status';
  v_role     text := p->>'role';
  v_note     text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_actor    uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_doc      uuid := nullif(p->>'document_id', '')::uuid;
  v_exit_id  uuid;
  v_emp_id   uuid;
  v_n        int;
  v_leave    jsonb := p->'leave';
  v_src      text;
  v_pl       numeric;
  v_sl       numeric;
begin
  select exit_id, auto_source into v_exit_id, v_src from podium.exit_checklist_items where id = (p->>'item_id')::uuid;
  if not found then raise exception 'podium_item_not_found'; end if;
  select employee_id into v_emp_id from podium.employee_exits where id = v_exit_id;
  -- R2 review B: the leave lock first (the leave RPCs' order), then the row locks.
  if v_src = 'leave_ledger' then perform podium.leave_lock(v_emp_id); end if;
  select * into v_e from podium.employees where id = v_emp_id for update;
  select * into v_x from podium.employee_exits where id = v_exit_id for update;
  if v_x.status <> 'open' then raise exception 'podium_exit_not_open'; end if;
  select * into v_it from podium.exit_checklist_items where id = (p->>'item_id')::uuid for update;
  if v_status is null or v_status not in ('open', 'done', 'na') then raise exception 'podium_bad_item_status'; end if;
  if v_it.auto_source = 'lot_access' then raise exception 'podium_set_by_close'; end if;
  if v_role is null or v_role not in ('hr', 'manager') or (v_role = 'manager' and v_it.owner <> 'manager') then
    raise exception 'podium_forbidden_item';
  end if;
  if v_status = 'na' and not v_it.allow_na then raise exception 'podium_na_not_allowed'; end if;
  if v_status = 'na' and v_note is null then raise exception 'podium_na_note_required'; end if;
  if v_status = 'done' and v_it.auto_source = 'snorkel_assets' then
    if v_e.auth_user_id is not null then
      select count(*) into v_n from store.assets where custodian_user_id = v_e.auth_user_id and status <> 'retired';
      if v_n > 0 then raise exception 'podium_assets_outstanding' using detail = v_n::text; end if;
    end if;
    select count(*) into v_n from store.assets
     where custodian_user_id is null and status <> 'retired'
       and lower(btrim(coalesce(custodian_name, ''))) = lower(btrim(v_e.full_name));
    if (v_e.auth_user_id is null or v_n > 0) and (v_role <> 'hr' or v_note is null) then
      raise exception 'podium_assets_unverifiable' using detail = v_n::text;
    end if;
  end if;
  if v_status = 'done' and v_it.auto_source = 'open_work' then
    select count(*) into v_n from docket.tasks
     where (assignee_employee_id = v_e.id or owner_employee_id = v_e.id)
       and status not in ('done', 'abandoned') and archived_at is null;
    if v_n > 0 then raise exception 'podium_open_work' using detail = v_n::text; end if;
  end if;
  -- ── R2 E2: leave_ledger (under the person's leave lock, taken above, so no apply / decide / cancel lands mid-check) ──
  if v_it.auto_source = 'leave_ledger' then
    if v_src is distinct from 'leave_ledger' then raise exception 'podium_leave_changed'; end if;   -- changed under us
    if v_status = 'done' then
      select count(*) into v_n from podium.leave_requests
       where employee_id = v_e.id and status in ('pending', 'approved') and end_date > v_x.lwd;
      if v_n > 0 then raise exception 'podium_leave_after_lwd' using detail = v_n::text; end if;
      select count(*) into v_n from podium.leave_requests where employee_id = v_e.id and status = 'pending';
      if v_n > 0 then raise exception 'podium_leave_pending' using detail = v_n::text; end if;
      if v_leave is not null and jsonb_typeof(v_leave) = 'object' then
        select coalesce(sum(delta), 0) into v_pl from podium.leave_ledger where employee_id = v_e.id and leave_type = 'PL';
        select coalesce(sum(delta), 0) into v_sl from podium.leave_ledger where employee_id = v_e.id and leave_type = 'SL';
        if v_pl is distinct from (v_leave->>'expected_pl')::numeric or v_sl is distinct from (v_leave->>'expected_sl')::numeric
           or (v_leave->>'as_at') is distinct from v_x.lwd::text then
          raise exception 'podium_leave_changed';
        end if;
        update podium.employee_exits set leave_pl_balance = (v_leave->>'pl_balance')::numeric,
            leave_sl_balance = (v_leave->>'sl_balance')::numeric, leave_lop_days = (v_leave->>'lop_days')::numeric,
            leave_confirmed_at = now(), leave_confirmed_by = v_actor,
            leave_as_at = v_x.lwd, leave_ledger_pl = v_pl, leave_ledger_sl = v_sl
         where id = v_x.id;
      end if;
    else
      update podium.employee_exits set leave_pl_balance = null, leave_sl_balance = null, leave_lop_days = null,
          leave_confirmed_at = null, leave_confirmed_by = null, leave_as_at = null, leave_ledger_pl = null, leave_ledger_sl = null
       where id = v_x.id;
    end if;
  end if;
  -- ── end R2
  if p ? 'document_id' and v_doc is not null
     and not exists (select 1 from podium.documents where id = v_doc and employee_id = v_e.id) then
    raise exception 'podium_bad_document';
  end if;
  update podium.exit_checklist_items set
    status = v_status, note = v_note,
    done_by = case when v_status = 'open' then null else v_actor end,
    done_at = case when v_status = 'open' then null else now() end,
    document_id = case when p ? 'document_id' then v_doc else document_id end
   where id = v_it.id
  returning * into v_it;
  return to_jsonb(v_it);
end $$;

-- ── 6. exit_close = the live body (pg_get_functiondef, 2026-11-13) + the R2 leave block (marked) ──
-- The leave line, when DONE, must still hold: leave_as_at = the LWD, Σ ledger PL / SL = the saved sums (when a snapshot
-- was saved — a person not covered has none), no pending request, no pending / approved request ending after the LWD.
-- Else 'podium_leave_changed' (HR re-opens and confirms again). The leave lock comes before the employees row lock (B).
create or replace function podium.exit_close(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_x       podium.employee_exits;
  v_e       podium.employees;
  v_actor   uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_open    text;
  v_assets  int := 0;
  v_tasks   int := 0;
  v_profile int := 0;
  v_roles   int := 0;
  v_comp    int := 0;
  v_gadmin  int := 0;
  v_gitem   uuid;
  v_emp_id  uuid;
  v_leave   boolean := false;
begin
  select employee_id into v_emp_id from podium.employee_exits where id = (p->>'exit_id')::uuid;
  if not found then raise exception 'podium_exit_not_found'; end if;
  -- R2 review B: the leave lock before the row locks when the exit has a leave line.
  v_leave := exists (select 1 from podium.exit_checklist_items where exit_id = (p->>'exit_id')::uuid and auto_source = 'leave_ledger');
  if v_leave then perform podium.leave_lock(v_emp_id); end if;
  select * into v_e from podium.employees where id = v_emp_id for update;
  select * into v_x from podium.employee_exits where id = (p->>'exit_id')::uuid for update;
  if v_x.status <> 'open' then raise exception 'podium_exit_not_open'; end if;
  if v_e.status = 'exited' then raise exception 'podium_already_exited'; end if;
  if v_today < v_x.lwd then raise exception 'podium_before_lwd' using detail = v_x.lwd::text; end if;
  select string_agg(line_key, ',' order by sort) into v_open from podium.exit_checklist_items
   where exit_id = v_x.id and required and coalesce(auto_source, '') <> 'lot_access'
     and not (status = 'done' or (status = 'na' and allow_na));
  if v_open is not null then raise exception 'podium_checklist_incomplete' using detail = v_open; end if;
  -- ── R2 review A: the confirmed leave line still holds ──
  if v_leave and exists (select 1 from podium.exit_checklist_items where exit_id = v_x.id and auto_source = 'leave_ledger' and status = 'done') then
    if exists (select 1 from podium.leave_requests where employee_id = v_e.id
                and (status = 'pending' or (status = 'approved' and end_date > v_x.lwd))) then
      raise exception 'podium_leave_changed';
    end if;
    -- Re-verify A': a covered person's done line with no snapshot fails closed (a confirm that landed between
    -- updateExit's re-open and its clear); not covered = no snapshot by design.
    if v_e.leave_policy is not null and (v_x.leave_confirmed_at is null or v_x.leave_as_at is null) then
      raise exception 'podium_leave_changed';
    end if;
    if v_x.leave_confirmed_at is not null and (
         v_x.leave_as_at is distinct from v_x.lwd
         or v_x.leave_ledger_pl is distinct from (select coalesce(sum(delta), 0) from podium.leave_ledger where employee_id = v_e.id and leave_type = 'PL')
         or v_x.leave_ledger_sl is distinct from (select coalesce(sum(delta), 0) from podium.leave_ledger where employee_id = v_e.id and leave_type = 'SL')) then
      raise exception 'podium_leave_changed';
    end if;
  end if;
  -- ── end R2
  if v_e.auth_user_id is not null then
    select count(*) into v_assets from store.assets
     where custodian_user_id = v_e.auth_user_id and status <> 'retired';
  end if;
  if v_assets > 0 then raise exception 'podium_assets_outstanding' using detail = v_assets::text; end if;
  select count(*) into v_tasks from docket.tasks
   where (assignee_employee_id = v_e.id or owner_employee_id = v_e.id)
     and status not in ('done', 'abandoned') and archived_at is null;
  if v_tasks > 0 then raise exception 'podium_open_work' using detail = v_tasks::text; end if;
  update podium.employees set status = 'exited', date_exited = v_x.lwd, exit_reason = v_x.reason_code, updated_at = now()
   where id = v_e.id;
  update podium.employee_exits set status = 'closed', closed_at = now(), closed_by = v_actor where id = v_x.id;
  update podium.exit_checklist_items set status = 'done', done_at = now(), done_by = v_actor,
         note = coalesce(note, 'Completed by the exit close')
   where exit_id = v_x.id and auto_source = 'lot_access' and status = 'open';
  if v_e.auth_user_id is not null then
    update store.users_profile set active = false where id = v_e.auth_user_id and active;
    get diagnostics v_profile = row_count;
    delete from store.podium_user_roles where user_id = v_e.auth_user_id;
    get diagnostics v_roles = row_count;
    delete from podium.comp_access where auth_user_id = v_e.auth_user_id;
    get diagnostics v_comp = row_count;
    delete from podium.google_admin_access where auth_user_id = v_e.auth_user_id;
    get diagnostics v_gadmin = row_count;
  end if;
  if v_e.work_email is not null
     and not exists (select 1 from podium.google_exit_items where employee_id = v_e.id
                       and status in ('open', 'kept', 'transfer_pending')) then
    insert into podium.google_exit_items (employee_id, exit_id, work_email, google_user_id)
    values (v_e.id, v_x.id, lower(v_e.work_email), v_e.google_user_id)
    returning id into v_gitem;
  end if;
  return jsonb_build_object('exit_id', v_x.id, 'employee_id', v_e.id, 'date_exited', v_x.lwd,
    'exit_reason', v_x.reason_code, 'login_deactivated', v_profile > 0, 'podium_roles_removed', v_roles,
    'comp_access_removed', v_comp > 0, 'google_admin_removed', v_gadmin > 0, 'google_exit_item_id', v_gitem);
end $$;

-- ── Grants: service_role only ────────────────────────────────────────────────
revoke all on function podium.leave_grant(jsonb) from public, anon, authenticated;
grant execute on function podium.leave_grant(jsonb) to service_role;
revoke all on function podium.exit_update_item(jsonb) from public, anon, authenticated;
grant execute on function podium.exit_update_item(jsonb) to service_role;
revoke all on function podium.exit_close(jsonb) from public, anon, authenticated;
grant execute on function podium.exit_close(jsonb) to service_role;

notify pgrst, 'reload schema';
