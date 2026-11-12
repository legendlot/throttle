-- podium_google_field_sync_v1 — J1b: one-way Podium → Google Directory field sync.
-- Plan: docs/superpowers/plans/2026-11-12-podium-j1b-google-sync.md (D1–D11) · depends on 0009 (google_admin_log)
-- + 0010 (its action CHECK) + 0006 (touch_updated_at).
-- AUTHORIZATION STAYS IN THE WORKER (as 0007–0014): the functions trust their caller (service_role only).
-- Live values checked 2026-11-12: employees.status ∈ active|on_leave|notice|exited; employees had no org_unit_path;
-- the only employees trigger is trg_employees_link_auth (work_email / auth_user_id); google_admin_log_action_check =
-- the 0010 list.
--
-- ⭐ PUSH ONLY WHAT CHANGED. A save dirties only the fields whose columns changed (google_sync_state.dirty_fields);
-- drains push only those. Pushing picked / every field happens only through pushGoogleFields — HR's reviewed,
-- one-shot, preview-hash-bound push from the Google vs Podium tab (D11, google_sync_claim). So nothing here, and no later save, ever silently overwrites a Google value Podium
-- did not just change. Test: test/google-sync.sql (rolls back) + test/googlesync.test.mjs.

-- ── D5: Podium owns the org unit ─────────────────────────────────────────────
-- google_org_unit stays "what Google last said"; org_unit_path is what Podium wants. It starts NULL for everyone (no
-- seed: the google_org_unit baseline was last refreshed 2026-10-07 and is stale). NULL = "leave Google's OU alone"
-- (D3). It is backfilled from LIVE Google whenever the worker reads a user (google_sync_backfill_ou), without dirtying.
alter table podium.employees add column org_unit_path text check (org_unit_path is null or org_unit_path like '/%');

-- ── The push queue: one row per employee ─────────────────────────────────────
-- status: pending (has dirty fields to push) · ok (nothing left to push, last push succeeded) · failed (retried with
-- backoff 1/5/30 min, next_attempt_at) · skipped (out of scope, skip_reason).
-- dirty_fields: the SYNC_FIELDS (src/googlesync.js) still to push. Only real changes (the triggers) ever enter it —
-- an admin push is one-shot and adds nothing (R1) — so a page-view drain never pushes a field nobody changed.
-- claimed_fields: the claim's field scope. An admin push (google_sync_claim) pushes exactly these, one-shot and bound to
-- claimed_hash; a drain claims with NULL and pushes dirty_fields.
-- rev: bumped on every dirty-mark. A result removes the fields it pushed only while rev is still the claimed one.
-- attempt_id / attempt_started_at: the drain's claim (one push per person at a time, 2-minute lease, as J1).
-- last_pushed: what Google held for each field after Podium last pushed it (drives `changed_in_google`).
-- dirtied_by: who made the change (the X-Podium-Actor request header the worker sends; see gsync_actor). The audit
-- log's actor = dirtied_by, else the caller whose request ran the drain.
create table podium.google_sync_state (
  employee_id uuid primary key references podium.employees(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'ok', 'failed', 'skipped')),
  dirty_fields text[] not null default '{}'
    check (dirty_fields <@ array['name', 'title', 'department', 'manager', 'phone', 'employee_code', 'org_unit']::text[]),
  claimed_fields text[]
    check (claimed_fields is null or claimed_fields <@ array['name', 'title', 'department', 'manager', 'phone', 'employee_code', 'org_unit']::text[]),
  -- R1: an admin push's preview hash (the users.update body HR approved). Set only by google_sync_claim, cleared on
  -- every record / release, so a background drain never sees one.
  claimed_hash text,
  rev bigint not null default 1,
  dirty_at timestamptz not null default now(),
  dirtied_by uuid,
  attempts int not null default 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  last_pushed_at timestamptz,
  last_pushed jsonb,
  skip_reason text,
  attempt_id uuid,
  attempt_started_at timestamptz,
  updated_at timestamptz not null default now()
);
create index google_sync_state_due_idx on podium.google_sync_state (status, next_attempt_at, dirty_at)
  where status in ('pending', 'failed');
create trigger google_sync_state_touch before update on podium.google_sync_state
  for each row execute function podium.touch_updated_at();

-- ── Who made the change: the worker sends X-Podium-Actor: <auth user id> on the writes that can dirty a person ──
-- PostgREST exposes the request headers as the request.headers GUC (JSON, lower-cased names). Anything missing or
-- malformed → null (raw SQL, another client): the log then names the caller whose request ran the drain.
create or replace function podium.gsync_actor()
returns uuid language plpgsql stable set search_path to 'podium', 'public' as $$
declare h text;
begin
  h := nullif(current_setting('request.headers', true), '')::json->>'x-podium-actor';
  if h ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return h::uuid; end if;
  return null;
exception when others then
  return null;
end $$;

-- ── D6: dirty-marking in the database (every write path, no per-handler code) ──
-- Upsert to pending, UNION the fields. A re-dirty resets the retry state (new values deserve a fresh try) and bumps
-- rev, but never touches a live claim: the claiming drain sees the bumped rev when it records its result.
create or replace function podium.google_sync_mark(p_ids uuid[], p_fields text[], p_actor uuid)
returns void language plpgsql security definer set search_path to 'podium', 'public' as $$
begin
  if p_fields is null or cardinality(p_fields) = 0 then return; end if;
  -- Sorted, so two transactions marking overlapping people lock them in the same order (R4).
  insert into podium.google_sync_state as s (employee_id, dirty_fields, dirtied_by)
  select x, p_fields, p_actor from (select distinct x from unnest(p_ids) x where x is not null) d order by x
  on conflict (employee_id) do update set status = 'pending', rev = s.rev + 1, dirty_at = now(), attempts = 0,
    next_attempt_at = null, last_error = null, skip_reason = null, dirtied_by = excluded.dirtied_by,
    dirty_fields = array(select distinct f from unnest(s.dirty_fields || excluded.dirty_fields) f order by f);
end $$;

-- Which fields an employees write dirties (src/googlesync.js COLUMN_FIELD / dirtiedFields mirror this):
-- full_name→name · job_title→title · department_id→department · manager_id→manager · phone→phone ·
-- employee_code→employee_code · org_unit_path→org_unit. INSERT → every field except name + title (a new row's name
-- and title either came FROM Google (the import's create) or were just written TO Google by J1's account create),
-- and only those whose column holds a value (R3: a NULL org_unit_path / manager_id on a new row = leave Google alone).
-- A status change or a work_email change adds NO field on that person (no Google field changes; linking an
-- existing account is aligned through the reviewed Google vs Podium push, never silently), but it does bump rev and
-- revives the row to pending when fields are already dirty (R2: an in-flight push records nothing stale, a `skipped`
-- row gets another look). A work_email change dirties `manager` on the direct reports (Google's manager relation
-- holds the email). Review 2026-11-13.
-- Exited people are not marked (out of scope; X1 owns their Google account).
-- The org-unit backfill (google_sync_backfill_ou) sets podium.gsync_backfill = 'on' for its transaction: those
-- writes copy Google's own value and must dirty nothing.
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
    if nullif(btrim(coalesce(new.phone, '')), '') is not null then v_f := array_append(v_f, 'phone'); end if;
    if nullif(btrim(coalesce(new.employee_code, '')), '') is not null then v_f := array_append(v_f, 'employee_code'); end if;
    if nullif(btrim(coalesce(new.org_unit_path, '')), '') is not null then v_f := array_append(v_f, 'org_unit'); end if;
  else
    if old.full_name is distinct from new.full_name then v_f := array_append(v_f, 'name'); end if;
    if old.job_title is distinct from new.job_title then v_f := array_append(v_f, 'title'); end if;
    if old.department_id is distinct from new.department_id then v_f := array_append(v_f, 'department'); end if;
    if old.manager_id is distinct from new.manager_id then v_f := array_append(v_f, 'manager'); end if;
    if old.phone is distinct from new.phone then v_f := array_append(v_f, 'phone'); end if;
    if old.employee_code is distinct from new.employee_code then v_f := array_append(v_f, 'employee_code'); end if;
    if old.org_unit_path is distinct from new.org_unit_path then v_f := array_append(v_f, 'org_unit'); end if;
  end if;
  if new.status <> 'exited' then
    perform podium.google_sync_mark(array[new.id], v_f, v_actor);
  end if;
  -- R2: identity / eligibility changed → no new field, but rev moves (an in-flight push cannot record over it) and a
  -- row with dirty fields is due again (a `skipped` one revives).
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

create trigger employees_google_sync_ins after insert on podium.employees
  for each row execute function podium.employees_google_sync_dirty();
create trigger employees_google_sync_upd after update of
    full_name, job_title, department_id, manager_id, phone, employee_code, org_unit_path, work_email, status
  on podium.employees for each row
  when (old.full_name is distinct from new.full_name
     or old.job_title is distinct from new.job_title
     or old.department_id is distinct from new.department_id
     or old.manager_id is distinct from new.manager_id
     or old.phone is distinct from new.phone
     or old.employee_code is distinct from new.employee_code
     or old.org_unit_path is distinct from new.org_unit_path
     or old.work_email is distinct from new.work_email
     or old.status is distinct from new.status)
  execute function podium.employees_google_sync_dirty();

-- A department rename changes organizations[primary].department for its members: dirties `department` only.
create or replace function podium.departments_google_sync_dirty()
returns trigger language plpgsql security definer set search_path to 'podium', 'public' as $$
begin
  perform podium.google_sync_mark(array(select e.id from podium.employees e where e.department_id = new.id and e.status <> 'exited'),
    array['department'], podium.gsync_actor());
  return null;
end $$;
create trigger departments_google_sync after update of name on podium.departments
  for each row when (old.name is distinct from new.name) execute function podium.departments_google_sync_dirty();

-- ── Retry: make people's ALREADY-dirty fields due now (Google admin's Retry button) ──
-- p = { ids: [uuid], fields: [] }. Adds no field (R1: an admin push of picked fields is one-shot through
-- google_sync_claim, never queued); a non-empty `fields` is refused. Rows with nothing dirty are left as they are.
create or replace function podium.google_sync_queue(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_ids uuid[] := array(select (x)::uuid from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) x order by 1);
  v_n int;
begin
  if jsonb_array_length(coalesce(p->'fields', '[]'::jsonb)) > 0 then raise exception 'podium_fields_not_queueable'; end if;
  update podium.google_sync_state s set status = 'pending', next_attempt_at = null
   where s.employee_id = any(v_ids) and cardinality(s.dirty_fields) > 0;
  get diagnostics v_n = row_count;
  return jsonb_build_object('updated', v_n);
end $$;

-- ── R1: an admin push claims people ONE-SHOT, bound to the preview ──────────
-- p = { attempt_id, fields: [text] (the pick; every SYNC_FIELD for a full push), lease_ms,
--       items: [{ employee_id, hash }] (the preview's body hash per person) }
-- Creates the state row (status ok, nothing dirty) for someone who never had one, then claims each person whose
-- lease is free — backoff and status are ignored (an admin push is explicit). Returns the claimed rows. Adds nothing
-- to dirty_fields: the push PUTs only if the recomputed body hashes to claimed_hash, and every outcome but `ok`
-- just releases the claim (google_sync_record 'release').
create or replace function podium.google_sync_claim(p jsonb)
returns setof podium.google_sync_state language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_attempt uuid := (p->>'attempt_id')::uuid;
  v_f text[] := array(select distinct x from jsonb_array_elements_text(coalesce(p->'fields', '[]'::jsonb)) x order by x);
  v_stale timestamptz := now() - make_interval(secs => coalesce((p->>'lease_ms')::numeric, 120000) / 1000);
begin
  if v_attempt is null or cardinality(v_f) = 0 then raise exception 'podium_bad_claim'; end if;
  insert into podium.google_sync_state (employee_id, status)
  select i.id, 'ok' from (select distinct (x->>'employee_id')::uuid as id from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) x) i
   where exists (select 1 from podium.employees e where e.id = i.id)
   order by i.id
  on conflict (employee_id) do nothing;
  return query
  update podium.google_sync_state s set attempt_id = v_attempt, attempt_started_at = now(), claimed_fields = v_f, claimed_hash = i.hash
    from (select (x->>'employee_id')::uuid as id, nullif(x->>'hash', '') as hash
            from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) x) i
   where s.employee_id = i.id and i.hash is not null
     and (s.attempt_started_at is null or s.attempt_started_at < v_stale)
  returning s.*;
end $$;

-- ── D5 backfill: org_unit_path from LIVE Google, only where it is NULL, without dirtying anyone ──
-- p = { items: [{ employee_id, ou }] }. Also refreshes google_org_unit (it IS what Google said just now).
-- podium.gsync_backfill is transaction-local (set_config … true); the AFTER ROW triggers fire at the end of the
-- UPDATE statement, before it is cleared.
create or replace function podium.google_sync_backfill_ou(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare v_n int;
begin
  perform set_config('podium.gsync_backfill', 'on', true);
  update podium.employees e set org_unit_path = i.ou, google_org_unit = i.ou
    from (select (x->>'employee_id')::uuid as id, nullif(btrim(x->>'ou'), '') as ou
            from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) x) i
   where e.id = i.id and e.org_unit_path is null and e.status <> 'exited' and i.ou like '/%';
  get diagnostics v_n = row_count;
  perform set_config('podium.gsync_backfill', '', true);
  return jsonb_build_object('backfilled', v_n);
end $$;

-- ── Recording an attempt's results (one call per drain / push, ≤ 8 rows) ─────
-- p = { attempt_id, results: [{ employee_id, rev, outcome: ok|failed|skipped|release, done_fields?, error?, skip_reason?,
--       next_attempt_at?, last_pushed?, google_org_unit?, google_manager_email?, google_user_id?, backfill_ou? }] }
-- R4 — OWNERSHIP BEFORE BASELINES, SORTED LOCK ORDER. Results are processed in employee_id order; for each one the
-- employees row is locked, then the state row WHERE attempt_id is ours. Not ours any more → skip BOTH (a stale
-- attempt never writes a baseline over a newer one). Then the employee's baselines (D9: what Google holds now after
-- a PUT; google_user_id backfilled when empty; the D5 OU backfill), then the state.
-- Lock order = the dirty trigger's (employees row, then its state row). The remaining deadlock risk (e.g. a
-- multi-row fan-out vs. a record holding a different person) is Postgres-detected: 40P01 aborts one transaction,
-- nothing hangs; the drain's rows stay claimed until the lease ends and a later drain redoes them.
-- State, as src/googlesync.js afterAttempt: ok removes the pushed / already-equal fields (only while rev is
-- unchanged) and is `ok` only when nothing is left; release (an admin push that did not PUT) frees the claim and
-- changes nothing else. claimed_fields / claimed_hash are cleared in every branch.
create or replace function podium.google_sync_record(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_attempt uuid := (p->>'attempt_id')::uuid;
  r jsonb;
  v_id uuid;
  v_row podium.google_sync_state;
  v_same boolean;
  v_left text[];
  v_n int := 0;
begin
  for r in select x from jsonb_array_elements(coalesce(p->'results', '[]'::jsonb)) x order by (x->>'employee_id')::uuid loop
    v_id := (r->>'employee_id')::uuid;
    perform 1 from podium.employees where id = v_id for update;
    select * into v_row from podium.google_sync_state where employee_id = v_id and attempt_id = v_attempt for update;
    if not found then continue; end if;

    if r->>'outcome' = 'ok' then
      update podium.employees e set
          google_org_unit = coalesce(nullif(r->>'google_org_unit', ''), e.google_org_unit),
          google_manager_email = case when r ? 'google_manager_email' then nullif(lower(btrim(coalesce(r->>'google_manager_email', ''))), '')
                                      else e.google_manager_email end,
          google_user_id = coalesce(e.google_user_id, nullif(r->>'google_user_id', ''))
       where e.id = v_id;
    end if;
    if nullif(r->>'backfill_ou', '') is not null then
      perform podium.google_sync_backfill_ou(jsonb_build_object('items', jsonb_build_array(
        jsonb_build_object('employee_id', v_id, 'ou', r->>'backfill_ou'))));
    end if;

    v_same := v_row.rev = (r->>'rev')::bigint;
    if r->>'outcome' = 'ok' then
      v_left := case when v_same then array(select f from unnest(v_row.dirty_fields) f
                                             where f not in (select jsonb_array_elements_text(coalesce(r->'done_fields', '[]'::jsonb))) order by f)
                     else v_row.dirty_fields end;
      update podium.google_sync_state set
        status = case when v_same and cardinality(v_left) = 0 then 'ok' else 'pending' end,
        dirty_fields = v_left,
        attempts = 0, last_attempt_at = now(), next_attempt_at = null, last_error = null,
        skip_reason = nullif(left(coalesce(r->>'skip_reason', ''), 100), ''),   -- R6: a field-only skip (org_unit:…)
        last_pushed_at = now(), last_pushed = coalesce(r->'last_pushed', last_pushed),
        attempt_id = null, attempt_started_at = null, claimed_fields = null, claimed_hash = null
       where employee_id = v_id;
    elsif r->>'outcome' = 'failed' then
      update podium.google_sync_state set
        status = case when v_same then 'failed' else 'pending' end,
        attempts = case when v_same then attempts + 1 else attempts end,
        last_attempt_at = now(), last_error = left(coalesce(r->>'error', 'failed'), 500),
        next_attempt_at = case when v_same then (r->>'next_attempt_at')::timestamptz else null end,
        attempt_id = null, attempt_started_at = null, claimed_fields = null, claimed_hash = null
       where employee_id = v_id;
    elsif r->>'outcome' = 'skipped' then
      update podium.google_sync_state set
        status = case when v_same then 'skipped' else 'pending' end,
        last_attempt_at = now(), skip_reason = left(coalesce(r->>'skip_reason', 'out_of_scope'), 100), last_error = null,
        next_attempt_at = null, attempt_id = null, attempt_started_at = null, claimed_fields = null, claimed_hash = null
       where employee_id = v_id;
    else
      -- 'release' (or anything else): free the claim, leave the row exactly as it was
      update podium.google_sync_state set attempt_id = null, attempt_started_at = null, claimed_fields = null, claimed_hash = null
       where employee_id = v_id;
    end if;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('recorded', v_n);
end $$;

-- ── google_admin_log: + the J1b actions ──────────────────────────────────────
-- One row per push that reached Google. actor = dirtied_by (who made the change) else the drain's caller;
-- `request` = { trigger: save|drain|push|retry, caller, body: the merged users.update body }.
alter table podium.google_admin_log drop constraint google_admin_log_action_check;
alter table podium.google_admin_log add constraint google_admin_log_action_check
  check (action in ('create_user', 'link_existing', 'suspend_user', 'reset_password', 'suspend_exited', 'drive_transfer',
    'keep_active', 'transfer_checked', 'account_gone', 'sync_fields', 'sync_fields_failed'));

-- ── RLS: on, no policies; service_role only (as 0009) ────────────────────────
alter table podium.google_sync_state enable row level security;
revoke all on podium.google_sync_state from anon, authenticated;
grant all on podium.google_sync_state to service_role;

do $$
declare f text;
begin
  foreach f in array array['google_sync_mark(uuid[], text[], uuid)', 'google_sync_queue(jsonb)', 'google_sync_claim(jsonb)', 'google_sync_backfill_ou(jsonb)',
                           'google_sync_record(jsonb)', 'employees_google_sync_dirty()', 'departments_google_sync_dirty()',
                           'gsync_actor()'] loop
    execute format('revoke all on function podium.%s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function podium.google_sync_record(jsonb) to service_role;
grant execute on function podium.google_sync_queue(jsonb) to service_role;
grant execute on function podium.google_sync_claim(jsonb) to service_role;
grant execute on function podium.google_sync_backfill_ou(jsonb) to service_role;

notify pgrst, 'reload schema';
