-- ============================================================================
-- podium_phase1_foundation
-- Podium — LOT People & Performance OS · Phase 1 (Foundation & Profiles)
--
-- Tables: settings, departments, job_roles, employees, role_kpis,
--         compensation_events, documents, org_snapshots
-- Plus  : podium.next_employee_seq() (EMP-NNN via store.sequences)
--
-- Security: RLS enabled on EVERY table, service_role-only — NO anon/authenticated
-- grants (RULE-RLS-001). The podiumops worker is the sole DB client (service_role,
-- BYPASSRLS). The absolute-salary vault columns (old_ctc/new_ctc/components) ship
-- but stay unused until Phase 5 hardening (settings.comp_vault_enabled).
--
-- Post-migration dashboard steps (cannot be done in SQL):
--   1. Project Settings → Data API → Exposed schemas → append `podium` (PATTERN-092)
--   2. Create PRIVATE Storage bucket `podium-documents` (no public policy)
-- ============================================================================

create schema if not exists podium;
grant usage on schema podium to service_role;

-- ── settings (single row; server-controlled gates) ──────────────────────────
create table if not exists podium.settings (
  id                 smallint primary key default 1,
  comp_vault_enabled boolean  not null default false,  -- absolute-CTC vault gate (flip in Phase 5)
  min_tenure_days    integer  not null default 90,      -- appraisal eligibility threshold
  updated_at         timestamptz not null default now(),
  constraint settings_singleton check (id = 1)
);
insert into podium.settings (id) values (1) on conflict do nothing;

-- ── departments ──────────────────────────────────────────────────────────────
create table if not exists podium.departments (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  code                 text unique,
  parent_department_id uuid references podium.departments(id) on delete set null,
  head_employee_id     uuid,                 -- FK wired after employees exists
  description          text,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid
);

-- ── job_roles (JD + KPI registry; distinct from store.roles permission model) ─
create table if not exists podium.job_roles (
  id               uuid primary key default gen_random_uuid(),
  role_code        text unique,
  title            text not null,
  department_id    uuid references podium.departments(id) on delete set null,
  level            text,               -- e.g. L1..L5 / Junior/Mid/Senior/Lead
  summary          text,
  job_description  text,               -- markdown
  responsibilities text[],
  salary_band_min  numeric(12,2),
  salary_band_mid  numeric(12,2),
  salary_band_max  numeric(12,2),
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  created_by       uuid
);

-- ── employees (the people master) ────────────────────────────────────────────
create table if not exists podium.employees (
  id                      uuid primary key default gen_random_uuid(),
  employee_code           text unique not null,
  auth_user_id            uuid unique,        -- → auth.users / store.users_profile; null = login-less (floor/contract)
  full_name               text not null,
  preferred_name          text,
  personal_email          text,
  work_email              text,
  phone                   text,
  emergency_contact_name  text,
  emergency_contact_phone text,
  date_of_birth           date,
  department_id           uuid references podium.departments(id) on delete set null,
  job_role_id             uuid references podium.job_roles(id) on delete set null,
  job_title               text,
  manager_id              uuid references podium.employees(id) on delete set null,
  employment_type         text check (employment_type in ('full_time','part_time','intern','contractor','consultant')),
  legal_entity            text,
  work_location           text,
  date_joined             date,
  probation_end_date      date,
  confirmed_at            date,
  date_exited             date,
  exit_reason             text,
  status                  text not null default 'active' check (status in ('active','on_leave','notice','exited')),
  photo_url               text,
  google_user_id          text,
  synced_from_google_at   timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid
);
create index if not exists employees_manager_idx    on podium.employees (manager_id);
create index if not exists employees_department_idx on podium.employees (department_id);
create index if not exists employees_status_idx     on podium.employees (status);

-- wire departments.head_employee_id now that employees exists
alter table podium.departments
  drop constraint if exists departments_head_fk;
alter table podium.departments
  add constraint departments_head_fk
  foreign key (head_employee_id) references podium.employees(id) on delete set null;

-- ── role_kpis ─────────────────────────────────────────────────────────────────
create table if not exists podium.role_kpis (
  id          uuid primary key default gen_random_uuid(),
  job_role_id uuid not null references podium.job_roles(id) on delete cascade,
  name        text not null,
  description text,
  metric_type text check (metric_type in ('qualitative','quantitative')),
  target      text,
  weight      numeric(6,2),
  sort_order  integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists role_kpis_role_idx on podium.role_kpis (job_role_id);

-- ── compensation_events (gated by podium_comp; absolute CTC deferred) ─────────
create table if not exists podium.compensation_events (
  id            uuid primary key default gen_random_uuid(),
  employee_id   uuid not null references podium.employees(id) on delete cascade,
  event_type    text not null check (event_type in ('initial','increment','revision','one_time_bonus','correction')),
  effective_date date not null default current_date,
  old_ctc       numeric(12,2),       -- comp_vault (Phase 5) — NULL in v1
  new_ctc       numeric(12,2),       -- comp_vault (Phase 5) — NULL in v1
  increment_pct numeric(6,2),
  amount        numeric(12,2),       -- one-time bonus amount
  currency      text not null default 'INR',
  components    jsonb,               -- comp_vault (Phase 5) — NULL in v1
  reason        text,
  appraisal_id  uuid,                -- FK to podium.appraisals added in Phase 3
  approved_by   uuid,
  created_at    timestamptz not null default now(),
  created_by    uuid
);
create index if not exists comp_events_emp_idx on podium.compensation_events (employee_id, effective_date desc);

-- ── documents (private bucket; storage_path only, signed-URL access) ─────────
create table if not exists podium.documents (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references podium.employees(id) on delete cascade,
  doc_type     text not null check (doc_type in (
                 'resume','offer_letter','employment_agreement','nda','education_cert',
                 'id_proof','bank_details','address_proof','appraisal_letter','increment_letter','other')),
  title        text,
  storage_path text not null,        -- path within the PRIVATE podium-documents bucket
  file_name    text,
  mime_type    text,
  file_size    bigint,
  expires_at   date,
  notes        text,
  uploaded_by  uuid,
  uploaded_at  timestamptz not null default now()
);
create index if not exists documents_emp_idx on podium.documents (employee_id);

-- ── org_snapshots (point-in-time org chart history) ──────────────────────────
create table if not exists podium.org_snapshots (
  id          uuid primary key default gen_random_uuid(),
  label       text,
  snapshot    jsonb not null,
  captured_at timestamptz not null default now(),
  captured_by uuid
);

-- ── sequence RPC: employee codes EMP-NNN (clone of ignition.next_*_seq) ───────
create or replace function podium.next_employee_seq()
returns bigint language plpgsql security definer set search_path to 'store','public' as $$
declare v_next bigint;
begin
  insert into store.sequences(name, current_val) values ('podium_employee', 0)
    on conflict (name) do nothing;
  update store.sequences set current_val = current_val + 1
    where name = 'podium_employee' returning current_val into v_next;
  return v_next;
end $$;

-- ── RLS: enable on every table (service_role bypasses; no policy = locked) ────
alter table podium.settings            enable row level security;
alter table podium.departments         enable row level security;
alter table podium.job_roles           enable row level security;
alter table podium.employees           enable row level security;
alter table podium.role_kpis           enable row level security;
alter table podium.compensation_events enable row level security;
alter table podium.documents           enable row level security;
alter table podium.org_snapshots       enable row level security;

-- ── grants: service_role ONLY — never anon/authenticated (RULE-RLS-001) ──────
grant all on all tables    in schema podium to service_role;
grant all on all sequences in schema podium to service_role;
grant execute on all functions in schema podium to service_role;
alter default privileges in schema podium grant all     on tables    to service_role;
alter default privileges in schema podium grant all     on sequences to service_role;
alter default privileges in schema podium grant execute on functions to service_role;

-- reload PostgREST schema cache (also triggered by the Exposed-Schemas save)
notify pgrst, 'reload schema';
