-- Podium J1b changes, Afshaan 2026-11-13. Applied as `podium_google_sync_no_phone_bulk_pause_v1`.
--  1. "don't push phone numbers to google, let them be in podium": phone is no longer a sync field. A phone edit
--     dirties nothing, the state CHECKs no longer accept it, and Google's phones are never sent (src/googlesync.js).
--  2. "we need to pause bulk update first. I need to see if information is correct on podium first": the reviewed
--     bulk push (pushGoogleFields, not dry-run) is refused while settings.google_bulk_push_paused is true. Preview
--     still works. A per-person save still pushes the fields that save changed. Lifting the pause is Afshaan's call
--     (one UPDATE, no UI on purpose).
-- google_sync_state held 0 rows when this was written (nothing queued, nothing pushed yet).

-- ── 1. phone out of the sync ──
-- A row whose only dirty field was the phone has nothing left to push → ok (only the rows this touches).
update podium.google_sync_state
   set dirty_fields = array_remove(dirty_fields, 'phone'),
       claimed_fields = case when claimed_fields is null then null else array_remove(claimed_fields, 'phone') end,
       last_pushed = case when last_pushed is null then null else last_pushed - 'phone' end,
       status = case when 'phone' = any(dirty_fields) and cardinality(array_remove(dirty_fields, 'phone')) = 0
                      and status in ('pending', 'failed') then 'ok' else status end,
       next_attempt_at = case when 'phone' = any(dirty_fields) and cardinality(array_remove(dirty_fields, 'phone')) = 0
                      and status in ('pending', 'failed') then null else next_attempt_at end
 where 'phone' = any(dirty_fields) or 'phone' = any(coalesce(claimed_fields, '{}')) or coalesce(last_pushed ? 'phone', false);

alter table podium.google_sync_state drop constraint if exists google_sync_state_dirty_fields_check;
alter table podium.google_sync_state add constraint google_sync_state_dirty_fields_check
  check (dirty_fields <@ array['name', 'title', 'department', 'manager', 'employee_code', 'org_unit']::text[]);
alter table podium.google_sync_state drop constraint if exists google_sync_state_claimed_fields_check;
alter table podium.google_sync_state add constraint google_sync_state_claimed_fields_check
  check (claimed_fields is null or claimed_fields <@ array['name', 'title', 'department', 'manager', 'employee_code', 'org_unit']::text[]);

-- The 0015 trigger function, minus the two phone lines (everything else unchanged).
create or replace function podium.employees_google_sync_dirty()
returns trigger language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_f text[] := '{}';
  v_actor uuid := podium.gsync_actor();
begin
  if coalesce(current_setting('podium.gsync_backfill', true), '') = 'on' then return null; end if;
  if tg_op = 'INSERT' then
    if new.department_id is not null then v_f := array_append(v_f, 'department'); end if;
    if new.manager_id is not null then v_f := array_append(v_f, 'manager'); end if;
    if nullif(btrim(coalesce(new.employee_code, '')), '') is not null then v_f := array_append(v_f, 'employee_code'); end if;
    if nullif(btrim(coalesce(new.org_unit_path, '')), '') is not null then v_f := array_append(v_f, 'org_unit'); end if;
  else
    if old.full_name is distinct from new.full_name then v_f := array_append(v_f, 'name'); end if;
    if old.job_title is distinct from new.job_title then v_f := array_append(v_f, 'title'); end if;
    if old.department_id is distinct from new.department_id then v_f := array_append(v_f, 'department'); end if;
    if old.manager_id is distinct from new.manager_id then v_f := array_append(v_f, 'manager'); end if;
    if old.employee_code is distinct from new.employee_code then v_f := array_append(v_f, 'employee_code'); end if;
    if old.org_unit_path is distinct from new.org_unit_path then v_f := array_append(v_f, 'org_unit'); end if;
  end if;
  if new.status <> 'exited' then
    perform podium.google_sync_mark(array[new.id], v_f, v_actor);
  end if;
  if tg_op = 'UPDATE' and (old.status is distinct from new.status or old.work_email is distinct from new.work_email) then
    update podium.google_sync_state set rev = rev + 1,
        status = case when cardinality(dirty_fields) > 0 then 'pending' else status end,
        next_attempt_at = case when cardinality(dirty_fields) > 0 then null else next_attempt_at end
     where employee_id = new.id;
  end if;
  if tg_op = 'UPDATE' and old.work_email is distinct from new.work_email then
    perform podium.google_sync_mark(array(select e.id from podium.employees e where e.manager_id = new.id and e.status <> 'exited'),
      array['manager'], v_actor);
  end if;
  return null;
end $$;

drop trigger if exists employees_google_sync_upd on podium.employees;
create trigger employees_google_sync_upd after update of
    full_name, job_title, department_id, manager_id, employee_code, org_unit_path, work_email, status
  on podium.employees for each row
  when (old.full_name is distinct from new.full_name
     or old.job_title is distinct from new.job_title
     or old.department_id is distinct from new.department_id
     or old.manager_id is distinct from new.manager_id
     or old.employee_code is distinct from new.employee_code
     or old.org_unit_path is distinct from new.org_unit_path
     or old.work_email is distinct from new.work_email
     or old.status is distinct from new.status)
  execute function podium.employees_google_sync_dirty();

-- ── 2. the bulk-push pause ──
alter table podium.settings add column if not exists google_bulk_push_paused boolean not null default true;
comment on column podium.settings.google_bulk_push_paused is
  'J1b: true = the reviewed bulk Google push (pushGoogleFields) is refused; preview + per-save pushes still run. Paused by Afshaan 2026-11-13 until he has checked Podium data.';
