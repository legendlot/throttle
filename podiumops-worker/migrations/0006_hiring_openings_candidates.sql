-- podium_hiring_c1_c2_v1 — Hiring module C1 (openings) + C2 (candidates/applications/documents).
-- Spec: docs/superpowers/specs/2026-11-11-podium-hiring-module-scope.md (v3.2).
-- Joining hand-off (Directory-sync pairing) lands with C3, because it needs an accepted offer.
-- All tables RLS-on, service-role only (RULE-RLS-001 / RULE-PODIUM-002 posture).

-- ── Codes ────────────────────────────────────────────────────────────────────
create or replace function podium.next_hiring_seq(p_name text)
returns bigint language plpgsql security definer set search_path to 'store', 'public' as $$
declare v_next bigint;
begin
  if p_name not in ('podium_opening', 'podium_candidate') then
    raise exception 'next_hiring_seq: unknown sequence %', p_name;
  end if;
  insert into store.sequences(name, current_val) values (p_name, 0) on conflict (name) do nothing;
  update store.sequences set current_val = current_val + 1 where name = p_name returning current_val into v_next;
  return v_next;
end $$;
revoke all on function podium.next_hiring_seq(text) from public;
grant execute on function podium.next_hiring_seq(text) to service_role;

-- ── C1: openings ─────────────────────────────────────────────────────────────
create table podium.openings (
  id uuid primary key default gen_random_uuid(),
  opening_code text not null unique,
  job_role_id uuid references podium.job_roles(id),
  designation text not null check (length(btrim(designation)) > 0),
  department_id uuid references podium.departments(id),
  reporting_manager_employee_id uuid not null references podium.employees(id),
  hiring_owner_employee_id uuid not null references podium.employees(id),
  location_city text not null default 'Bangalore',
  location_state text not null default 'Karnataka',
  employment_type text not null default 'full_time' check (employment_type in ('full_time', 'intern')),
  legal_entity text not null default 'Fraternitas' check (legal_entity in ('Fraternitas')),
  headcount int not null default 1 check (headcount between 1 and 100),
  target_join_date date,
  notes text,
  -- draft = no JD yet (the JD gate); open/on_hold/filled/cancelled per spec §C1.
  status text not null default 'draft' check (status in ('draft', 'open', 'on_hold', 'filled', 'cancelled')),
  current_jd_id uuid,
  current_budget_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index openings_status_idx on podium.openings(status);
create index openings_rm_idx on podium.openings(reporting_manager_employee_id);
create index openings_owner_idx on podium.openings(hiring_owner_employee_id);

-- JD versions: never deleted once candidates exist (worker-enforced); text and/or file.
create table podium.opening_jds (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references podium.openings(id) on delete cascade,
  version int not null check (version >= 1),
  source text not null check (source in ('text', 'file', 'job_role')),
  jd_text text,
  storage_path text unique,
  file_name text,
  mime_type text,
  file_size bigint check (file_size is null or file_size between 1 and 15728640),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (opening_id, version),
  check ((jd_text is not null and length(btrim(jd_text)) > 0) or storage_path is not null)
);

-- Budget (salary band on TOTAL CTC, annual INR) versions. The approver is SNAPSHOTTED at request time.
create table podium.opening_budgets (
  id uuid primary key default gen_random_uuid(),
  opening_id uuid not null references podium.openings(id) on delete cascade,
  version int not null check (version >= 1),
  band_min numeric(12,0) not null check (band_min >= 0),
  band_max numeric(12,0) not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'superseded', 'cancelled')),
  requested_by uuid not null,
  requested_by_employee_id uuid references podium.employees(id),
  approver_employee_id uuid not null references podium.employees(id),
  decided_by uuid,
  decided_by_employee_id uuid references podium.employees(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  unique (opening_id, version),
  check (band_max >= band_min),
  -- No self-approval, enforced in the DB as well as the worker.
  check (decided_by_employee_id is null or requested_by_employee_id is null or decided_by_employee_id <> requested_by_employee_id)
);
-- At most one pending request per opening.
create unique index opening_budgets_one_pending on podium.opening_budgets(opening_id) where status = 'pending';

alter table podium.openings
  add constraint openings_current_jd_fk foreign key (current_jd_id) references podium.opening_jds(id),
  add constraint openings_current_budget_fk foreign key (current_budget_id) references podium.opening_budgets(id);

-- ── C2: candidates (the person) ──────────────────────────────────────────────
create table podium.candidates (
  id uuid primary key default gen_random_uuid(),
  candidate_code text not null unique,
  full_name text not null check (length(btrim(full_name)) > 0),
  email text,
  email_norm text generated always as (nullif(lower(btrim(email)), '')) stored,
  phone text,
  phone_norm text generated always as (nullif(right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10), '')) stored,
  location text,
  current_employer text,
  current_title text,
  total_experience_years numeric(4,1) check (total_experience_years is null or total_experience_years between 0 and 60),
  skills text[] not null default '{}',
  education text,
  linkedin_url text,
  notes text,
  employee_id uuid references podium.employees(id),
  merged_into_id uuid references podium.candidates(id),
  notice_version text,                       -- privacy notice shown/sent (DPDP readiness)
  talent_pool boolean not null default false,
  talent_pool_consent_at timestamptz,
  retain_until date,                          -- set when the last application closes without joining (+12 months)
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (merged_into_id is null or merged_into_id <> id)
);
create index candidates_email_norm_idx on podium.candidates(email_norm);
create index candidates_phone_norm_idx on podium.candidates(phone_norm);
create index candidates_name_idx on podium.candidates(lower(full_name));

-- ── C2: applications (person × opening) ──────────────────────────────────────
create table podium.applications (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references podium.candidates(id),
  opening_id uuid not null references podium.openings(id),
  source text not null default 'other' check (source in ('referral', 'linkedin', 'naukri', 'campus', 'walk_in', 'agency', 'careers_page', 'other')),
  referrer_employee_id uuid references podium.employees(id),
  source_detail text,
  current_ctc numeric(12,0) check (current_ctc is null or current_ctc >= 0),
  expected_ctc numeric(12,0) check (expected_ctc is null or expected_ctc >= 0),
  notice_period_days int check (notice_period_days is null or notice_period_days between 0 and 365),
  status text not null default 'new' check (status in (
    'new', 'screening', 'interviewing', 'offer', 'accepted', 'on_hold',
    'joined', 'rejected', 'declined', 'withdrawn', 'no_show')),
  outcome_reason text,
  moved_to_application_id uuid references podium.applications(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index applications_opening_idx on podium.applications(opening_id, status);
create index applications_candidate_idx on podium.applications(candidate_id);
-- One ACTIVE application per person per opening.
create unique index applications_one_active on podium.applications(candidate_id, opening_id)
  where status in ('new', 'screening', 'interviewing', 'offer', 'accepted', 'on_hold');

-- Append-only timeline. Salary values never go in reason text (worker-enforced).
create table podium.application_events (
  id bigint generated always as identity primary key,
  application_id uuid references podium.applications(id) on delete cascade,
  opening_id uuid references podium.openings(id) on delete cascade,
  candidate_id uuid references podium.candidates(id) on delete cascade,
  actor_user_id uuid,
  actor_employee_id uuid,
  event_type text not null,
  from_status text,
  to_status text,
  reason text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index application_events_app_idx on podium.application_events(application_id, created_at);
create index application_events_opening_idx on podium.application_events(opening_id, created_at);
create index application_events_candidate_idx on podium.application_events(candidate_id, created_at);
create or replace function podium.refuse_event_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'application_events is append-only';
end $$;
-- Deletes are allowed only via the cascade of a retention purge (candidate row deleted);
-- direct UPDATEs are refused.
create trigger application_events_no_update before update on podium.application_events
  for each row execute function podium.refuse_event_mutation();

-- ── C2: candidate documents (own table — podium.documents' visibility keys on employee_id) ──
create table podium.candidate_documents (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references podium.candidates(id) on delete cascade,
  application_id uuid references podium.applications(id) on delete set null,
  doc_type text not null check (doc_type in (
    'cv', 'payslip', 'signed_offer', 'id_proof', 'pan', 'address_proof', 'education',
    'experience_letter', 'relieving_letter', 'bank', 'photo', 'other')),
  title text,
  storage_path text not null unique,
  file_name text,
  mime_type text,
  file_size bigint check (file_size is null or file_size between 1 and 15728640),
  notes text,
  uploaded_by uuid,
  uploaded_at timestamptz not null default now()
);
create index candidate_documents_candidate_idx on podium.candidate_documents(candidate_id);

-- ── updated_at touch ─────────────────────────────────────────────────────────
create or replace function podium.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger openings_touch before update on podium.openings for each row execute function podium.touch_updated_at();
create trigger candidates_touch before update on podium.candidates for each row execute function podium.touch_updated_at();
create trigger applications_touch before update on podium.applications for each row execute function podium.touch_updated_at();

-- ── RLS: on, no policies; service_role only ──────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['openings', 'opening_jds', 'opening_budgets', 'candidates', 'applications', 'application_events', 'candidate_documents'] loop
    execute format('alter table podium.%I enable row level security', t);
    execute format('revoke all on podium.%I from anon, authenticated', t);
    execute format('grant all on podium.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema podium to service_role;

-- ── Permission preset: Hiring (podium_view + podium_hiring) ──────────────────
insert into store.podium_roles (role_key, label, description, permissions, is_system)
values ('hiring', 'Hiring', 'Create openings and see every opening and candidate. Salary numbers still follow the opening chain + allow-list.',
        '{"podium_view": true, "podium_hiring": true}'::jsonb, false)
on conflict (role_key) do nothing;
