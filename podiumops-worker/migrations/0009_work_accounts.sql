-- podium_work_accounts_v1 — Hiring J1: Podium creates the Google work account, then confirms joining.
-- Plan: docs/superpowers/plans/2026-11-11-podium-j1-work-accounts.md · depends on 0006 + 0007 + 0008.
-- AUTHORIZATION STAYS IN THE WORKER (as 0007/0008): the function trusts its caller (service_role only).
-- The temp password is never written anywhere in the database — not in work_accounts, not in the log.

-- ── Google admins: a per-PERSON allow-list (L3), not a role ──────────────────
-- The Podium `admin` role is also held by someone outside L3, so this cannot key on a role.
create table podium.google_admin_access (
  auth_user_id uuid primary key,
  added_by uuid,
  note text,
  added_at timestamptz not null default now()
);
insert into podium.google_admin_access (auth_user_id, note)
select e.auth_user_id, 'seeded by podium_work_accounts_v1 (L3)'
  from podium.employees e
 where e.work_email in ('afshaan@legendoftoys.com', 'vinay@legendoftoys.com', 'mohit@legendoftoys.com')
   and e.auth_user_id is not null
on conflict do nothing;

-- ── Work accounts: one row per account Podium creates (or tries to) ──────────
-- application_id null = an override ("Create account without hiring"), which must say why.
-- employee_id is allocated by the worker on the first confirm attempt and reused on retry, so the
-- copied document paths (<employee_id>/hiring/…) and the employee row always agree.
create table podium.work_accounts (
  id uuid primary key default gen_random_uuid(),
  application_id uuid unique references podium.applications(id),
  candidate_id uuid references podium.candidates(id),
  email text not null check (email = lower(email) and email like '%@legendoftoys.com'),
  given_name text not null check (length(btrim(given_name)) between 1 and 60),
  family_name text not null check (length(btrim(family_name)) between 1 and 60),
  org_unit_path text not null check (org_unit_path like '/%'),
  status text not null default 'pending' check (status in ('pending', 'created', 'failed', 'suspended')),
  google_user_id text,
  employee_id uuid,
  override_reason text,
  last_error text,
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  suspended_at timestamptz,
  suspended_by uuid,
  -- One create attempt at a time: the worker claims the row (fresh attempt_id) only when no other attempt
  -- started in the last 2 minutes, and every later write is guarded on (attempt_id, status = 'pending').
  attempt_id uuid,
  attempt_started_at timestamptz,
  check (application_id is not null or length(btrim(coalesce(override_reason, ''))) >= 10),
  check (status not in ('created', 'suspended') or google_user_id is not null)
);
-- One live claim per address; a failed attempt frees it.
create unique index work_accounts_email_live on podium.work_accounts (lower(email)) where status <> 'failed';
create trigger work_accounts_touch before update on podium.work_accounts for each row execute function podium.touch_updated_at();

-- ── Google admin log: every Google write Podium makes (append-only) ──────────
-- `request` is the call minus the password. Never the password.
create table podium.google_admin_log (
  id bigint generated always as identity primary key,
  actor uuid not null,
  actor_email text,
  action text not null check (action in ('create_user', 'link_existing', 'suspend_user', 'reset_password')),
  target_email text not null,
  google_user_id text,
  work_account_id uuid references podium.work_accounts(id),
  request jsonb,
  ok boolean not null,
  error text,
  created_at timestamptz not null default now()
);
create index google_admin_log_wa_idx on podium.google_admin_log (work_account_id, created_at desc);
-- Reuses the application_events refuser (its message names application_events; the effect is the same).
create trigger google_admin_log_no_update before update or delete on podium.google_admin_log
  for each row execute function podium.refuse_event_mutation();

-- ── RLS: on, no policies; service_role only (as comp_access) ─────────────────
do $$
declare t text;
begin
  foreach t in array array['google_admin_access', 'work_accounts', 'google_admin_log'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── Confirm joining: employee + candidate link + initial comp + documents + joined + filled ──
-- p = { application_id, employee_id (= work_accounts.employee_id, allocated by the worker), start_date,
--       offer_id + terms_hash (the revision the worker built components / documents from),
--       components (componentsContract(annexure, offer)), documents: [{storage_path, doc_type, title, file_name,
--       mime_type, file_size}] (objects already copied under <employee_id>/), actor_user_id, actor_employee_id }
-- Raises podium_<code>: application_not_found · not_accepted · offer_not_accepted · offer_not_latest ·
-- offer_changed · no_work_account · rehire_not_supported_yet · employee_id_mismatch · email_taken ·
-- opening_closed · headcount_full · bad_start_date · bad_document_path.
-- Idempotent: an application already `joined` whose work account carries an existing employee returns it.
-- The opening becomes `filled` only when headcount is reached AND nobody else is active on it; otherwise the
-- result says opening_needs_resolution (src/workaccount.js openingAfterJoin mirrors this).
create or replace function podium.hiring_confirm_joining(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_app       podium.applications;
  v_wa        podium.work_accounts;
  v_off       podium.offers;
  v_c         podium.candidates;
  v_op        podium.openings;
  v_e         podium.employees;
  v_emp_id    uuid := nullif(p->>'employee_id', '')::uuid;
  v_start     date;
  v_n         bigint;
  v_vault     boolean;
  v_joined    int;
  v_active    int;
  v_filled    boolean := false;
  v_resolve   boolean := false;
  v_doc       jsonb;
  v_actor     uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_actor_emp uuid := nullif(p->>'actor_employee_id', '')::uuid;
begin
  select * into v_app from podium.applications where id = (p->>'application_id')::uuid for update;
  if not found then raise exception 'podium_application_not_found'; end if;
  select * into v_wa from podium.work_accounts where application_id = v_app.id for update;

  if v_app.status = 'joined' then
    select * into v_e from podium.employees where id = v_wa.employee_id;
    if found then
      return jsonb_build_object('employee_id', v_e.id, 'employee_code', v_e.employee_code, 'already_joined', true,
        'opening_filled', false, 'opening_needs_resolution', false);
    end if;
    raise exception 'podium_not_accepted';
  end if;
  if v_app.status <> 'accepted' then raise exception 'podium_not_accepted'; end if;

  -- The accepted revision, unless a NEWER revision is still live (in flight or accepted). Newer declined /
  -- expired / withdrawn / superseded revisions are history (src/workaccount.js joiningOffer mirrors this).
  select * into v_off from podium.offers where application_id = v_app.id and status = 'accepted'
   order by revision desc limit 1;
  if not found then raise exception 'podium_offer_not_accepted'; end if;
  if exists (select 1 from podium.offers x where x.application_id = v_app.id and x.id <> v_off.id
               and x.revision > v_off.revision
               and x.status in ('draft', 'pending_approval', 'approved', 'approval_rejected', 'ready', 'sent', 'accepted')) then
    raise exception 'podium_offer_not_latest';
  end if;
  -- The worker built the comp components and the document list from one revision; under this lock it must
  -- still be the joining offer, with the same terms.
  if v_off.id is distinct from nullif(p->>'offer_id', '')::uuid
     or v_off.terms_hash is distinct from nullif(p->>'terms_hash', '') then
    raise exception 'podium_offer_changed';
  end if;

  if v_wa.id is null or v_wa.status <> 'created' then raise exception 'podium_no_work_account'; end if;
  if v_emp_id is null or v_wa.employee_id is distinct from v_emp_id then raise exception 'podium_employee_id_mismatch'; end if;

  select * into v_c from podium.candidates where id = v_app.candidate_id for update;
  -- A rehire needs X1's employment periods; overwriting date_joined would erase the earlier employment.
  if v_c.employee_id is not null then raise exception 'podium_rehire_not_supported_yet'; end if;
  -- Someone already holds this address in Podium (e.g. added by hand or by the sync in the meantime).
  if exists (select 1 from podium.employees e where lower(e.work_email) = lower(v_wa.email)) then
    raise exception 'podium_email_taken';
  end if;

  begin
    v_start := (p->>'start_date')::date;
  exception when others then raise exception 'podium_bad_start_date';
  end;
  if v_start is null then raise exception 'podium_bad_start_date'; end if;

  -- The opening lock serialises joins on one opening, so the headcount check below cannot be raced.
  select * into v_op from podium.openings where id = v_app.opening_id for update;
  if v_op.status = 'cancelled' then raise exception 'podium_opening_closed'; end if;
  select count(*) into v_joined from podium.applications where opening_id = v_op.id and status = 'joined';
  if v_joined >= v_op.headcount then raise exception 'podium_headcount_full'; end if;

  v_n := podium.next_employee_seq();
  insert into podium.employees (id, employee_code, full_name, personal_email, phone, work_email, google_user_id,
    google_org_unit, department_id, job_role_id, manager_id, employment_type, legal_entity, job_title, work_location,
    date_joined, probation_end_date, status, synced_from_google_at, created_by)
  values (v_emp_id, 'EMP-' || lpad(v_n::text, greatest(3, length(v_n::text)), '0'), v_c.full_name, v_c.email, v_c.phone,
    v_wa.email, v_wa.google_user_id, v_wa.org_unit_path, v_op.department_id, v_op.job_role_id,
    v_op.reporting_manager_employee_id, v_op.employment_type, v_op.legal_entity, v_off.designation,
    coalesce(nullif(btrim(coalesce(v_off.location, '')), ''), v_op.location_city), v_start,
    case when coalesce(v_off.probation_months, 0) > 0 then (v_start + make_interval(months => v_off.probation_months))::date end,
    'active', null, v_actor)
  returning * into v_e;

  update podium.candidates set employee_id = v_e.id where id = v_c.id;

  -- Mirrors addCompensationEvent: with the vault off, the figures are not stored.
  select coalesce(comp_vault_enabled, false) into v_vault from podium.settings where id = 1;
  insert into podium.compensation_events (employee_id, event_type, effective_date, new_ctc, components, currency, reason,
    approved_by, created_by)
  values (v_e.id, 'initial', v_start,
    case when v_vault then v_off.total_ctc end,
    case when v_vault then p->'components' end,
    'INR', 'offer ' || v_off.offer_ref || ' r' || v_off.revision, v_actor, v_actor);

  for v_doc in select value from jsonb_array_elements(coalesce(p->'documents', '[]'::jsonb)) loop
    if position((v_e.id::text || '/') in coalesce(v_doc->>'storage_path', '')) <> 1
       or (v_doc->>'storage_path') like '%..%' then
      raise exception 'podium_bad_document_path';
    end if;
    insert into podium.documents (employee_id, doc_type, title, storage_path, file_name, mime_type, file_size, uploaded_by)
    values (v_e.id, v_doc->>'doc_type', v_doc->>'title', v_doc->>'storage_path', v_doc->>'file_name',
      v_doc->>'mime_type', nullif(v_doc->>'file_size', '')::bigint, v_actor);
  end loop;

  update podium.applications set status = 'joined', closed_at = now() where id = v_app.id;
  insert into podium.application_events (candidate_id, opening_id, application_id, actor_user_id, actor_employee_id,
    event_type, from_status, to_status, detail)
  values (v_app.candidate_id, v_app.opening_id, v_app.id, v_actor, v_actor_emp, 'status_changed', 'accepted', 'joined',
    jsonb_build_object('employee_id', v_e.id, 'employee_code', v_e.employee_code, 'offer_ref', v_off.offer_ref,
      'revision', v_off.revision));

  v_joined := v_joined + 1;
  select count(*) into v_active from podium.applications where opening_id = v_op.id and id <> v_app.id
     and status in ('new', 'screening', 'interviewing', 'offer', 'accepted', 'on_hold');
  if v_joined >= v_op.headcount and v_active > 0 then
    v_resolve := true;   -- headcount reached but others are still in the pipeline: a human closes them out
  elsif v_joined >= v_op.headcount and v_op.status <> 'filled' then
    update podium.openings set status = 'filled' where id = v_op.id;
    -- No free-text reason (non-code reasons are redacted off the salary chain); the counts go in detail.
    insert into podium.application_events (opening_id, actor_user_id, actor_employee_id, event_type, from_status, to_status, detail)
    values (v_op.id, v_actor, v_actor_emp, 'opening_status', v_op.status, 'filled',
      jsonb_build_object('cause', 'headcount_reached', 'joined', v_joined, 'headcount', v_op.headcount));
    v_filled := true;
  end if;

  return jsonb_build_object('employee_id', v_e.id, 'employee_code', v_e.employee_code, 'already_joined', false,
    'opening_filled', v_filled, 'opening_needs_resolution', v_resolve);
end $$;

revoke all on function podium.hiring_confirm_joining(jsonb) from public, anon, authenticated;
grant execute on function podium.hiring_confirm_joining(jsonb) to service_role;

notify pgrst, 'reload schema';
