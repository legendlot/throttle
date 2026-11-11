-- podium_onboarding_v1 — J2: onboarding for joiners + one-time profile completion for every active employee.
-- Plan: docs/superpowers/plans/2026-11-12-podium-j2-onboarding.md · depends on 0010 (X1 shapes: template + snapshot
-- items, partial uniques, refuse_event_mutation, touch_updated_at, RLS + grant loop, locking RPCs).
-- AUTHORIZATION STAYS IN THE WORKER (as 0007-0010): every function trusts its caller (service_role only).
--
-- Decision 1: sensitive fields live in podium.employee_private, NOT on employees — employees is read with
-- select=* / EMP_EMBED in dozens of worker paths; one missed strip would leak bank details. PAN stays on
-- employees.pan_number (stripPan). Decision 7: nothing here gates payroll — J2 records, it never blocks.
-- Live values checked 2026-11-12: documents.doc_type has no 'photo' (self uploads use 'other'); employees.gender
-- holds 'm' / 'f' (lowercase, no CHECK); store.assets.status ∈ in_use|in_storage|damaged|in_repair|retired.

-- ── Settings: the campaign stamp, the required documents, the export's PT location ──
alter table podium.settings
  add column profile_campaign_launched_at timestamptz,
  add column profile_campaign_launched_by uuid,
  add column profile_required_doc_types text[] not null default '{id_proof,address_proof,bank_details}'
    check (profile_required_doc_types <@ array['id_proof', 'address_proof', 'bank_details', 'education_cert', 'other']::text[]),
  add column pt_state text not null default 'Karnataka' check (length(btrim(pt_state)) between 1 and 60);

-- ── The private 1:1 (bank, statutory, addresses, past-employer salary) ───────
-- Read by getMyProfile (self, full), getEmployeePrivate (HR: bank masked; comp: + salary fields, logged) and the
-- XPayroll export (comp, logged). The worker normalises input at the form (spaces stripped, IFSC uppercased);
-- these CHECKs are the backstop.
create table podium.employee_private (
  employee_id uuid primary key references podium.employees(id),
  current_address text check (current_address is null or length(current_address) between 1 and 500),
  permanent_address text check (permanent_address is null or length(permanent_address) between 1 and 500),
  pf_uan text check (pf_uan ~ '^[0-9]{12}$'),
  esic_number text check (esic_number ~ '^[0-9]{10,17}$'),
  bank_account_number text check (bank_account_number ~ '^[0-9]{9,18}$'),
  bank_ifsc text check (bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_account_name text check (bank_account_name is null or length(btrim(bank_account_name)) between 1 and 120),
  fy_label text check (fy_label ~ '^[0-9]{4}-[0-9]{2}$'),
  cur_fy_taxable_outside numeric check (cur_fy_taxable_outside >= 0),
  cur_fy_exemptions numeric check (cur_fy_exemptions >= 0),
  cur_fy_tds numeric check (cur_fy_tds >= 0),
  past_taxable_salary numeric check (past_taxable_salary >= 0),
  past_tds numeric check (past_tds >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create trigger employee_private_touch before update on podium.employee_private for each row execute function podium.touch_updated_at();

-- ── Decision 4: a self-change of PAN / bank after first fill = a request HR approves ──
-- rev is bumped every time the person replaces a pending value; HR decides against the revs it SAW
-- (profile_change_decide refuses podium_change_request_changed otherwise), so nobody approves an unseen value.
-- The three bank fields are one group, decided together; PAN is its own. The person may withdraw a pending one.
create table podium.profile_change_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references podium.employees(id),
  field text not null check (field in ('pan_number', 'bank_account_number', 'bank_ifsc', 'bank_account_name')),
  new_value text not null check (length(btrim(new_value)) between 1 and 120),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  rev int not null default 1 check (rev >= 1),
  requested_by uuid,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  check (status = 'pending' or decided_at is not null),
  check (field <> 'pan_number' or new_value ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  check (field <> 'bank_account_number' or new_value ~ '^[0-9]{9,18}$'),
  check (field <> 'bank_ifsc' or new_value ~ '^[A-Z]{4}0[A-Z0-9]{6}$')
);
-- One PENDING request per (employee, field); a re-request replaces the pending value (profile_save_self).
create unique index profile_change_requests_one_pending on podium.profile_change_requests (employee_id, field) where status = 'pending';
create index profile_change_requests_status_idx on podium.profile_change_requests (status, requested_at desc);

-- ── Policies (L4: ship EMPTY, co-created later) + acknowledgements ───────────
-- A new version = a new row (the old row is deactivated); an ack is for (policy row, version) only, so old acks
-- stay valid for the old version and never count for the new one.
create table podium.policies (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  version int not null default 1 check (version >= 1),
  storage_path text not null check (storage_path like 'policies/%' and position('..' in storage_path) = 0),
  applies_to text[] not null default '{}',   -- employment types; empty = all
  active boolean not null default true,
  published_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (title, version)
);
create unique index policies_one_active_per_title on podium.policies (title) where active;
create trigger policies_touch before update on podium.policies for each row execute function podium.touch_updated_at();

create table podium.policy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references podium.employees(id),
  policy_id uuid not null references podium.policies(id),
  version int not null check (version >= 1),
  acknowledged_at timestamptz not null default now(),
  unique (employee_id, policy_id, version)
);
create trigger policy_acknowledgements_no_update before update or delete on podium.policy_acknowledgements
  for each row execute function podium.refuse_event_mutation();

-- ── The onboarding TEMPLATE (admin data). Editing it never changes a started onboarding (items are a snapshot). ──
-- Decision 6: auto lines are computed (onboarding_auto_status), never ticked by hand; HR may mark one done with a
-- note only while it is unverifiable (no login linked → IT kit / policies cannot be checked).
create table podium.onboarding_lines (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  title text not null check (length(btrim(title)) between 1 and 120),
  owner text not null check (owner in ('hr', 'manager', 'it', 'employee')),
  required boolean not null default true,
  allow_na boolean not null default false,
  applies_to text[] not null default '{}',   -- employment types; empty = all
  auto_source text check (auto_source in ('profile', 'documents', 'policies', 'login', 'it_kit', 'probation_date')),
  due_offset_days int not null default 0 check (due_offset_days between -60 and 365),   -- from date_joined; < 0 = before day one
  sort int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger onboarding_lines_touch before update on podium.onboarding_lines for each row execute function podium.touch_updated_at();

insert into podium.onboarding_lines (key, title, owner, required, allow_na, applies_to, auto_source, due_offset_days, sort) values
  ('profile_complete',      'Profile completed (live)',                               'employee', true,  false, '{}', 'profile',        3,  10),
  ('documents_uploaded',    'Documents uploaded — ID, address, bank (live)',          'employee', true,  false, '{}', 'documents',      7,  20),
  ('policies_acknowledged', 'Policies read and acknowledged (live)',                  'employee', true,  false, '{}', 'policies',       7,  30),
  ('login_linked',          'LOT login linked (live)',                                'it',       true,  false, '{}', 'login',          0,  40),
  -- allow_na on it_kit is deliberate: floor / production staff get no laptop (HR marks N/A with a note).
  ('it_kit_issued',         'IT kit issued (live from Snorkel)',                      'it',       true,  true,  '{}', 'it_kit',         0,  50),
  ('app_access',            'App access set up',                                      'it',       true,  false, '{}', null,             1,  60),
  ('first_week_plan',       'First-week plan shared',                                 'manager',  true,  false, '{}', null,             0,  70),
  ('probation_goals',       'Probation goals set (the note may carry the OKR link)',  'manager',  true,  false, '{}', null,            14,  80),
  ('buddy_assigned',        'Buddy assigned',                                         'manager',  true,  false, '{}', null,             0,  90),
  ('payroll_setup',         'Payroll set up / XPayroll export done',                  'hr',       true,  false, '{}', null,             7, 100),
  ('pf_esi_registration',   'PF / ESI registration',                                  'hr',       true,  true,
     '{full_time,part_time,contractor,consultant}', null,                                                                  30, 110),
  ('probation_date_set',    'Probation end date set (live)',                          'hr',       true,  false, '{}', 'probation_date', 7, 120),
  ('welcome_email',         'Welcome email sent',                                     'hr',       false, false, '{}', null,             0, 130);

-- ── One row per onboarding ───────────────────────────────────────────────────
create table podium.employee_onboardings (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references podium.employees(id),
  status text not null default 'open' check (status in ('open', 'complete', 'cancelled')),
  started_by uuid,
  started_via text not null check (started_via in ('joining', 'hr')),
  completed_at timestamptz,
  completed_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'complete' or completed_at is not null),
  check (status <> 'cancelled' or (cancelled_at is not null and length(btrim(coalesce(cancel_reason, ''))) > 0))
);
-- One OPEN onboarding per employee (a cancelled one is history; a new one may start).
create unique index employee_onboardings_one_open on podium.employee_onboardings (employee_id) where status = 'open';
create index employee_onboardings_employee_idx on podium.employee_onboardings (employee_id, created_at desc);
create trigger employee_onboardings_touch before update on podium.employee_onboardings for each row execute function podium.touch_updated_at();

-- ── The checklist SNAPSHOT taken at start (X1 pattern) + due dates ──────────
create table podium.onboarding_items (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null references podium.employee_onboardings(id),
  line_key text not null,
  title text not null,
  owner text not null check (owner in ('hr', 'manager', 'it', 'employee')),
  required boolean not null,
  allow_na boolean not null,
  auto_source text check (auto_source in ('profile', 'documents', 'policies', 'login', 'it_kit', 'probation_date')),
  due_offset_days int not null default 0,
  due_date date,   -- date_joined + offset; null when date_joined is null
  sort int not null default 100,
  status text not null default 'open' check (status in ('open', 'done', 'na')),
  note text check (note is null or length(note) <= 2000),
  done_by uuid,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (onboarding_id, line_key),
  check (status <> 'na' or (allow_na and length(btrim(coalesce(note, ''))) > 0)),
  check (status = 'open' or done_at is not null)
);
create trigger onboarding_items_touch before update on podium.onboarding_items for each row execute function podium.touch_updated_at();

-- ── RLS: on, no policies; service_role only (as 0009 / 0010) ─────────────────
do $$
declare t text;
begin
  foreach t in array array['employee_private', 'profile_change_requests', 'policies', 'policy_acknowledgements',
                           'onboarding_lines', 'employee_onboardings', 'onboarding_items'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;

-- ── The completion rule (SQL twin of src/onboarding.js profileMissing — keep the lists identical) ──
-- Required: date_of_birth, gender, personal_email, phone, emergency_contact_name, emergency_contact_phone,
-- pan_number, current_address, bank_account_number, bank_ifsc + every settings.profile_required_doc_types
-- uploaded ('doc:<type>'). PF UAN / ESIC / past salary are optional.
create or replace function podium.profile_missing(p_employee_id uuid)
returns text[] language sql stable security definer set search_path to 'podium', 'public' as $$
  select coalesce(array_agg(k order by o), '{}'::text[]) from (
    select v.o, v.k
      from podium.employees e
      left join podium.employee_private p on p.employee_id = e.id
      cross join lateral (values
        (1,  'date_of_birth',           e.date_of_birth is null),
        (2,  'gender',                  nullif(btrim(coalesce(e.gender, '')), '') is null),
        (3,  'personal_email',          nullif(btrim(coalesce(e.personal_email, '')), '') is null),
        (4,  'phone',                   nullif(btrim(coalesce(e.phone, '')), '') is null),
        (5,  'emergency_contact_name',  nullif(btrim(coalesce(e.emergency_contact_name, '')), '') is null),
        (6,  'emergency_contact_phone', nullif(btrim(coalesce(e.emergency_contact_phone, '')), '') is null),
        (7,  'pan_number',              nullif(btrim(coalesce(e.pan_number, '')), '') is null),
        (8,  'current_address',         nullif(btrim(coalesce(p.current_address, '')), '') is null),
        (9,  'bank_account_number',     p.bank_account_number is null),
        (10, 'bank_ifsc',               p.bank_ifsc is null)
      ) as v(o, k, missing)
     where e.id = p_employee_id and v.missing
    union all
    select 100 + t.n, 'doc:' || t.doc_type
      from podium.settings s
      cross join lateral unnest(s.profile_required_doc_types) with ordinality as t(doc_type, n)
     where s.id = 1
       and not exists (select 1 from podium.documents d where d.employee_id = p_employee_id and d.doc_type = t.doc_type)
  ) x
$$;

-- ── An auto line's live status: 'done' | 'open' | 'unverifiable' (SQL twin of src/onboarding.js autoStatus) ──
create or replace function podium.onboarding_auto_status(p_employee_id uuid, p_source text)
returns text language plpgsql stable security definer set search_path to 'podium', 'public' as $$
declare
  v_e     podium.employees;
  v_n     int := 0;
  v_apply int := 0;
begin
  select * into v_e from podium.employees where id = p_employee_id;
  if not found then return 'open'; end if;
  if p_source = 'profile' then
    return case when cardinality(podium.profile_missing(p_employee_id)) = 0 then 'done' else 'open' end;
  elsif p_source = 'documents' then
    select count(*) into v_n from podium.settings s cross join lateral unnest(s.profile_required_doc_types) as t(doc_type)
     where s.id = 1
       and not exists (select 1 from podium.documents d where d.employee_id = p_employee_id and d.doc_type = t.doc_type);
    return case when v_n = 0 then 'done' else 'open' end;
  elsif p_source = 'policies' then
    select count(*) into v_apply from podium.policies pl
     where pl.active and (cardinality(pl.applies_to) = 0 or v_e.employment_type is null or v_e.employment_type = any(pl.applies_to));
    if v_apply = 0 then return 'done'; end if;               -- nothing to acknowledge (L4: ships empty)
    if v_e.auth_user_id is null then return 'unverifiable'; end if;   -- no login → cannot acknowledge in Podium
    select count(*) into v_n from podium.policies pl
     where pl.active and (cardinality(pl.applies_to) = 0 or v_e.employment_type is null or v_e.employment_type = any(pl.applies_to))
       and not exists (select 1 from podium.policy_acknowledgements a
                        where a.employee_id = p_employee_id and a.policy_id = pl.id and a.version = pl.version);
    return case when v_n = 0 then 'done' else 'open' end;
  elsif p_source = 'login' then
    return case when v_e.auth_user_id is not null then 'done' else 'open' end;
  elsif p_source = 'it_kit' then
    if v_e.auth_user_id is null then return 'unverifiable'; end if;   -- custody is keyed on the auth user
    select count(*) into v_n from store.assets where custodian_user_id = v_e.auth_user_id and status <> 'retired';
    return case when v_n > 0 then 'done' else 'open' end;
  elsif p_source = 'probation_date' then
    return case when v_e.probation_end_date is not null then 'done' else 'open' end;
  end if;
  return 'open';
end $$;

-- ── Start: the onboarding + its checklist snapshot, in one transaction ──────
-- p = { employee_id, started_by, started_via: joining|hr,
--       items: [{line_key, title, owner, required, allow_na, auto_source, due_offset_days, sort}] }
-- The worker builds the snapshot (src/onboarding.js snapshotOnboardingItems, filtered by applies_to); due dates
-- are computed HERE from the locked row's date_joined.
-- Raises podium_<code>: employee_not_found · already_exited · onboarding_already_open · onboarding_already_complete ·
-- no_lines.
create or replace function podium.onboarding_start(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_e    podium.employees;
  v_o    podium.employee_onboardings;
  v_item jsonb;
  v_off  int;
  v_n    int := 0;
begin
  select * into v_e from podium.employees where id = (p->>'employee_id')::uuid for update;
  if not found then raise exception 'podium_employee_not_found'; end if;
  if v_e.status = 'exited' then raise exception 'podium_already_exited'; end if;
  if exists (select 1 from podium.employee_onboardings where employee_id = v_e.id and status = 'open') then
    raise exception 'podium_onboarding_already_open';
  end if;
  if exists (select 1 from podium.employee_onboardings where employee_id = v_e.id and status = 'complete') then
    raise exception 'podium_onboarding_already_complete';
  end if;
  if jsonb_array_length(coalesce(p->'items', '[]'::jsonb)) = 0 then raise exception 'podium_no_lines'; end if;

  insert into podium.employee_onboardings (employee_id, status, started_by, started_via)
  values (v_e.id, 'open', nullif(p->>'started_by', '')::uuid, p->>'started_via')
  returning * into v_o;

  for v_item in select value from jsonb_array_elements(p->'items') loop
    v_off := coalesce((v_item->>'due_offset_days')::int, 0);
    insert into podium.onboarding_items (onboarding_id, line_key, title, owner, required, allow_na, auto_source,
      due_offset_days, due_date, sort)
    values (v_o.id, v_item->>'line_key', v_item->>'title', v_item->>'owner', (v_item->>'required')::boolean,
      (v_item->>'allow_na')::boolean, nullif(v_item->>'auto_source', ''), v_off,
      case when v_e.date_joined is null then null else v_e.date_joined + v_off end,
      coalesce((v_item->>'sort')::int, 100));
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('onboarding_id', v_o.id, 'employee_id', v_e.id, 'items', v_n, 'started_via', v_o.started_via);
end $$;

-- ── Set a line, under the onboarding lock ───────────────────────────────────
-- p = { item_id, status: open|done|na, note, actor_user_id, role: 'hr' | 'manager' (the worker decided; re-checked) }
-- Locks employee → onboarding → item (the start / complete order). Auto lines: only HR, and Done only while the
-- live check is unverifiable and with a note (decision 6); the live check is re-run HERE.
-- Raises podium_<code>: item_not_found · onboarding_not_open · bad_item_status · forbidden_item · na_not_allowed ·
-- na_note_required · set_automatically · auto_line_open · unverifiable_note_required.
create or replace function podium.onboarding_update_item(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_it     podium.onboarding_items;
  v_o      podium.employee_onboardings;
  v_e      podium.employees;
  v_status text := p->>'status';
  v_role   text := p->>'role';
  v_note   text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_actor  uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_ob_id  uuid;
  v_emp_id uuid;
  v_live   text;
begin
  select onboarding_id into v_ob_id from podium.onboarding_items where id = (p->>'item_id')::uuid;
  if not found then raise exception 'podium_item_not_found'; end if;
  select employee_id into v_emp_id from podium.employee_onboardings where id = v_ob_id;
  select * into v_e from podium.employees where id = v_emp_id for update;
  select * into v_o from podium.employee_onboardings where id = v_ob_id for update;
  if v_o.status <> 'open' then raise exception 'podium_onboarding_not_open'; end if;
  select * into v_it from podium.onboarding_items where id = (p->>'item_id')::uuid for update;

  if v_status is null or v_status not in ('open', 'done', 'na') then raise exception 'podium_bad_item_status'; end if;
  if v_role is null or v_role not in ('hr', 'manager') or (v_role = 'manager' and (v_it.owner <> 'manager' or v_it.auto_source is not null)) then
    raise exception 'podium_forbidden_item';
  end if;
  if v_it.auto_source is not null and v_role <> 'hr' then raise exception 'podium_forbidden_item'; end if;
  if v_status = 'na' and not v_it.allow_na then raise exception 'podium_na_not_allowed'; end if;
  if v_status = 'na' and v_note is null then raise exception 'podium_na_note_required'; end if;

  if v_status = 'done' and v_it.auto_source is not null then
    v_live := podium.onboarding_auto_status(v_e.id, v_it.auto_source);
    if v_live = 'done' then raise exception 'podium_set_automatically'; end if;
    if v_live = 'open' then raise exception 'podium_auto_line_open'; end if;
    if v_note is null then raise exception 'podium_unverifiable_note_required'; end if;
  end if;

  update podium.onboarding_items set
    status = v_status, note = v_note,
    done_by = case when v_status = 'open' then null else v_actor end,
    done_at = case when v_status = 'open' then null else now() end
   where id = v_it.id
  returning * into v_it;
  return to_jsonb(v_it);
end $$;

-- ── Complete: every required line resolved, auto lines re-checked live HERE ──
-- p = { onboarding_id, actor_user_id }. Resolved = done, or n/a where allowed, or (auto) the live check says done.
-- Auto lines that are live-done are stamped done by this call.
-- Raises podium_<code>: onboarding_not_found · onboarding_not_open · onboarding_incomplete (DETAIL = the keys).
create or replace function podium.onboarding_complete(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_o      podium.employee_onboardings;
  v_e      podium.employees;
  v_actor  uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_emp_id uuid;
  v_open   text;
  v_auto   int := 0;
begin
  select employee_id into v_emp_id from podium.employee_onboardings where id = (p->>'onboarding_id')::uuid;
  if not found then raise exception 'podium_onboarding_not_found'; end if;
  select * into v_e from podium.employees where id = v_emp_id for update;
  select * into v_o from podium.employee_onboardings where id = (p->>'onboarding_id')::uuid for update;
  if v_o.status <> 'open' then raise exception 'podium_onboarding_not_open'; end if;

  select string_agg(i.line_key, ',' order by i.sort) into v_open from podium.onboarding_items i
   where i.onboarding_id = v_o.id and i.required
     and not ((i.status = 'na' and i.allow_na)
           or i.status = 'done'
           or (i.auto_source is not null and podium.onboarding_auto_status(v_e.id, i.auto_source) = 'done'));
  if v_open is not null then raise exception 'podium_onboarding_incomplete' using detail = v_open; end if;

  update podium.onboarding_items i set status = 'done', done_at = now(), done_by = v_actor,
         note = coalesce(i.note, 'Verified automatically at completion')
   where i.onboarding_id = v_o.id and i.auto_source is not null and i.status = 'open'
     and podium.onboarding_auto_status(v_e.id, i.auto_source) = 'done';
  get diagnostics v_auto = row_count;
  update podium.employee_onboardings set status = 'complete', completed_at = now(), completed_by = v_actor where id = v_o.id;

  return jsonb_build_object('onboarding_id', v_o.id, 'employee_id', v_e.id, 'status', 'complete', 'auto_stamped', v_auto);
end $$;

-- ── Self-save: first fill applies, a change to a filled PAN / bank field becomes a request (decision 4) ──
-- p = { employee_id, actor_user_id, employee: {field: value|null}, private: {field: value|null} } — values already
-- validated + normalised by the worker (src/onboarding.js validateProfileInput); a key present = write it.
-- Under the employee lock, so a first fill and an HR approval can never interleave.
-- Raises podium_<code>: employee_not_found · already_exited · cannot_clear_protected (DETAIL = the field).
create or replace function podium.profile_save_self(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_e     podium.employees;
  v_p     podium.employee_private;
  v_emp   jsonb := coalesce(p->'employee', '{}'::jsonb);
  v_priv  jsonb := coalesce(p->'private', '{}'::jsonb);
  v_actor uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_req   text[] := '{}';
  v_f     text;
  v_new   text;
  v_cur   text;
  v_has   boolean;
begin
  select * into v_e from podium.employees where id = (p->>'employee_id')::uuid for update;
  if not found then raise exception 'podium_employee_not_found'; end if;
  if v_e.status = 'exited' then raise exception 'podium_already_exited'; end if;
  select * into v_p from podium.employee_private where employee_id = v_e.id for update;

  foreach v_f in array array['pan_number', 'bank_account_number', 'bank_ifsc', 'bank_account_name'] loop
    v_has := case when v_f = 'pan_number' then v_emp ? v_f else v_priv ? v_f end;
    if not v_has then continue; end if;
    v_new := nullif(btrim(coalesce(case when v_f = 'pan_number' then v_emp->>v_f else v_priv->>v_f end, '')), '');
    v_cur := case v_f when 'pan_number' then v_e.pan_number when 'bank_account_number' then v_p.bank_account_number
                      when 'bank_ifsc' then v_p.bank_ifsc else v_p.bank_account_name end;
    v_cur := nullif(btrim(coalesce(v_cur, '')), '');
    if v_cur is null then continue; end if;             -- first fill: written below
    if v_new is null then raise exception 'podium_cannot_clear_protected' using detail = v_f; end if;
    if v_new is distinct from v_cur then
      update podium.profile_change_requests set new_value = v_new, rev = rev + 1, requested_at = now(), requested_by = v_actor
       where employee_id = v_e.id and field = v_f and status = 'pending' and new_value is distinct from v_new;
      if not found and exists (select 1 from podium.profile_change_requests
                                where employee_id = v_e.id and field = v_f and status = 'pending') then
        null;   -- the same value is already pending: nothing changes, rev stays
      elsif not found then
        insert into podium.profile_change_requests (employee_id, field, new_value, requested_by)
        values (v_e.id, v_f, v_new, v_actor);
      end if;
      v_req := v_req || v_f;
    end if;
    -- Filled already (changed → requested; unchanged → nothing): never written here.
    if v_f = 'pan_number' then v_emp := v_emp - v_f; else v_priv := v_priv - v_f; end if;
  end loop;

  if v_emp <> '{}'::jsonb then
    update podium.employees set
      preferred_name          = case when v_emp ? 'preferred_name' then nullif(btrim(coalesce(v_emp->>'preferred_name', '')), '') else preferred_name end,
      personal_email          = case when v_emp ? 'personal_email' then nullif(btrim(coalesce(v_emp->>'personal_email', '')), '') else personal_email end,
      phone                   = case when v_emp ? 'phone' then nullif(btrim(coalesce(v_emp->>'phone', '')), '') else phone end,
      emergency_contact_name  = case when v_emp ? 'emergency_contact_name' then nullif(btrim(coalesce(v_emp->>'emergency_contact_name', '')), '') else emergency_contact_name end,
      emergency_contact_phone = case when v_emp ? 'emergency_contact_phone' then nullif(btrim(coalesce(v_emp->>'emergency_contact_phone', '')), '') else emergency_contact_phone end,
      date_of_birth           = case when v_emp ? 'date_of_birth' then nullif(v_emp->>'date_of_birth', '')::date else date_of_birth end,
      gender                  = case when v_emp ? 'gender' then nullif(btrim(coalesce(v_emp->>'gender', '')), '') else gender end,
      blood_group             = case when v_emp ? 'blood_group' then nullif(btrim(coalesce(v_emp->>'blood_group', '')), '') else blood_group end,
      pan_number              = case when v_emp ? 'pan_number' then nullif(btrim(coalesce(v_emp->>'pan_number', '')), '') else pan_number end,
      updated_at = now()
     where id = v_e.id;
  end if;

  if v_priv <> '{}'::jsonb then
    insert into podium.employee_private (employee_id, updated_by) values (v_e.id, v_actor) on conflict (employee_id) do nothing;
    update podium.employee_private set
      current_address        = case when v_priv ? 'current_address' then nullif(btrim(coalesce(v_priv->>'current_address', '')), '') else current_address end,
      permanent_address      = case when v_priv ? 'permanent_address' then nullif(btrim(coalesce(v_priv->>'permanent_address', '')), '') else permanent_address end,
      pf_uan                 = case when v_priv ? 'pf_uan' then nullif(btrim(coalesce(v_priv->>'pf_uan', '')), '') else pf_uan end,
      esic_number            = case when v_priv ? 'esic_number' then nullif(btrim(coalesce(v_priv->>'esic_number', '')), '') else esic_number end,
      bank_account_number    = case when v_priv ? 'bank_account_number' then nullif(btrim(coalesce(v_priv->>'bank_account_number', '')), '') else bank_account_number end,
      bank_ifsc              = case when v_priv ? 'bank_ifsc' then nullif(btrim(coalesce(v_priv->>'bank_ifsc', '')), '') else bank_ifsc end,
      bank_account_name      = case when v_priv ? 'bank_account_name' then nullif(btrim(coalesce(v_priv->>'bank_account_name', '')), '') else bank_account_name end,
      fy_label               = case when v_priv ? 'fy_label' then nullif(btrim(coalesce(v_priv->>'fy_label', '')), '') else fy_label end,
      cur_fy_taxable_outside = case when v_priv ? 'cur_fy_taxable_outside' then nullif(v_priv->>'cur_fy_taxable_outside', '')::numeric else cur_fy_taxable_outside end,
      cur_fy_exemptions      = case when v_priv ? 'cur_fy_exemptions' then nullif(v_priv->>'cur_fy_exemptions', '')::numeric else cur_fy_exemptions end,
      cur_fy_tds             = case when v_priv ? 'cur_fy_tds' then nullif(v_priv->>'cur_fy_tds', '')::numeric else cur_fy_tds end,
      past_taxable_salary    = case when v_priv ? 'past_taxable_salary' then nullif(v_priv->>'past_taxable_salary', '')::numeric else past_taxable_salary end,
      past_tds               = case when v_priv ? 'past_tds' then nullif(v_priv->>'past_tds', '')::numeric else past_tds end,
      updated_by = v_actor
     where employee_id = v_e.id;
  end if;

  return jsonb_build_object('employee_id', v_e.id, 'change_requests', to_jsonb(v_req),
    'written', (select coalesce(jsonb_agg(k), '[]'::jsonb) from (select jsonb_object_keys(v_emp) k union all select jsonb_object_keys(v_priv)) x));
end $$;

-- ── HR decides a change GROUP: PAN, or the bank fields together; an approval writes every field ──
-- p = { employee_id, group: pan|bank, expected: [{id, rev}], decision: approved|rejected, note, actor_user_id }.
-- Lock employee → the group's pending rows (profile_save_self's order). `expected` must be EXACTLY the pending rows
-- at the revs HR saw — a replaced value (rev bumped), a new field added to the group or one withdrawn since → refused.
-- Raises podium_<code>: bad_group · bad_decision · decision_note_required · change_request_not_pending ·
-- change_request_changed.
create or replace function podium.profile_change_decide(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_emp_id uuid := (p->>'employee_id')::uuid;
  v_group  text := p->>'group';
  v_fields text[];
  v_dec    text := p->>'decision';
  v_note   text := nullif(btrim(coalesce(p->>'note', '')), '');
  v_actor  uuid := nullif(p->>'actor_user_id', '')::uuid;
  v_have   text;
  v_want   text;
  v_r      podium.profile_change_requests;
  v_n      int := 0;
begin
  v_fields := case v_group when 'pan' then array['pan_number']
                           when 'bank' then array['bank_account_number', 'bank_ifsc', 'bank_account_name'] end;
  if v_fields is null then raise exception 'podium_bad_group'; end if;
  if v_dec is null or v_dec not in ('approved', 'rejected') then raise exception 'podium_bad_decision'; end if;
  if v_dec = 'rejected' and v_note is null then raise exception 'podium_decision_note_required'; end if;
  perform 1 from podium.employees where id = v_emp_id for update;
  perform 1 from podium.profile_change_requests
   where employee_id = v_emp_id and field = any(v_fields) and status = 'pending' for update;

  select string_agg(id::text || ':' || rev::text, ',' order by id) into v_have from podium.profile_change_requests
   where employee_id = v_emp_id and field = any(v_fields) and status = 'pending';
  if v_have is null then raise exception 'podium_change_request_not_pending'; end if;
  select string_agg((e->>'id') || ':' || ((e->>'rev')::int)::text, ',' order by (e->>'id')::uuid) into v_want
    from jsonb_array_elements(coalesce(p->'expected', '[]'::jsonb)) e;
  if v_want is distinct from v_have then raise exception 'podium_change_request_changed'; end if;

  for v_r in select * from podium.profile_change_requests
              where employee_id = v_emp_id and field = any(v_fields) and status = 'pending' loop
    if v_dec = 'approved' then
      if v_r.field = 'pan_number' then
        update podium.employees set pan_number = v_r.new_value, updated_at = now() where id = v_emp_id;
      else
        insert into podium.employee_private (employee_id, updated_by) values (v_emp_id, v_actor) on conflict (employee_id) do nothing;
        update podium.employee_private set
          bank_account_number = case when v_r.field = 'bank_account_number' then v_r.new_value else bank_account_number end,
          bank_ifsc           = case when v_r.field = 'bank_ifsc' then v_r.new_value else bank_ifsc end,
          bank_account_name   = case when v_r.field = 'bank_account_name' then v_r.new_value else bank_account_name end,
          updated_by = v_actor
         where employee_id = v_emp_id;
      end if;
    end if;
    update podium.profile_change_requests set status = v_dec, decided_by = v_actor, decided_at = now(), decision_note = v_note
     where id = v_r.id;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('employee_id', v_emp_id, 'group', v_group, 'status', v_dec, 'decided', v_n);
end $$;

-- ── Publish a policy (a new title, or the next version of one) in one transaction ──
-- p = { title, storage_path, applies_to: text[], actor_user_id }. The next version = max(version) + 1 for the
-- title; the active row of that title is deactivated first (policies_one_active_per_title), so a failed insert
-- never leaves the title with no active version.
-- Raises podium_<code>: bad_policy.
create or replace function podium.policy_publish(p jsonb)
returns jsonb language plpgsql security definer set search_path to 'podium', 'public' as $$
declare
  v_title text := btrim(coalesce(p->>'title', ''));
  v_path  text := p->>'storage_path';
  v_ver   int;
  v_row   podium.policies;
begin
  if length(v_title) not between 1 and 160 or v_path is null or v_path not like 'policies/%' or position('..' in v_path) > 0 then
    raise exception 'podium_bad_policy';
  end if;
  perform pg_advisory_xact_lock(hashtext('podium.policy_publish:' || v_title));
  select coalesce(max(version), 0) + 1 into v_ver from podium.policies where title = v_title;
  update podium.policies set active = false where title = v_title and active;
  insert into podium.policies (title, version, storage_path, applies_to, active, published_at, created_by)
  values (v_title, v_ver, v_path,
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'applies_to', '[]'::jsonb)) as t(x)), '{}'::text[]),
    true, now(), nullif(p->>'actor_user_id', '')::uuid)
  returning * into v_row;
  return to_jsonb(v_row);
end $$;

revoke all on function podium.policy_publish(jsonb) from public, anon, authenticated;
grant execute on function podium.policy_publish(jsonb) to service_role;
revoke all on function podium.profile_missing(uuid) from public, anon, authenticated;
revoke all on function podium.onboarding_auto_status(uuid, text) from public, anon, authenticated;
revoke all on function podium.onboarding_start(jsonb) from public, anon, authenticated;
revoke all on function podium.onboarding_update_item(jsonb) from public, anon, authenticated;
revoke all on function podium.onboarding_complete(jsonb) from public, anon, authenticated;
revoke all on function podium.profile_save_self(jsonb) from public, anon, authenticated;
revoke all on function podium.profile_change_decide(jsonb) from public, anon, authenticated;
grant execute on function podium.profile_missing(uuid) to service_role;
grant execute on function podium.onboarding_auto_status(uuid, text) to service_role;
grant execute on function podium.onboarding_start(jsonb) to service_role;
grant execute on function podium.onboarding_update_item(jsonb) to service_role;
grant execute on function podium.onboarding_complete(jsonb) to service_role;
grant execute on function podium.profile_save_self(jsonb) to service_role;
grant execute on function podium.profile_change_decide(jsonb) to service_role;

notify pgrst, 'reload schema';
