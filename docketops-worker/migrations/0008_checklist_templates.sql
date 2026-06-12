-- Docket — Structured checklist templates (role-linked SOP checklists). RULE-DOCKET-009.
-- Applied to Supabase lot-production as migration `docket_checklist_templates_v1`.
-- Coexists with the flat recurring-task model (RULE-DOCKET-008); templates live OUTSIDE
-- docket.tasks, so list_tasks / dashboard_stats are untouched.
-- Spec: docs/superpowers/specs/2026-06-12-docket-checklist-templates-design.md.

create table if not exists docket.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role_label text,
  department_id uuid,                         -- → podium.departments (cross-schema, no FK)
  description text,
  recurrence jsonb not null,                  -- {freq, days_of_week[]?, day_of_month?, until?} — NO time
  is_active boolean not null default true,
  archived_at timestamptz,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by_user_id uuid
);
alter table docket.checklist_templates enable row level security;
grant all on docket.checklist_templates to service_role;

create table if not exists docket.checklist_template_sections (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references docket.checklist_templates(id) on delete cascade,
  title text not null,
  subtitle text,
  due_time text,                              -- 'HH:MM' IST, optional → drives late-flagging
  sort_order int not null default 0
);
create index if not exists docket_cl_sections_tmpl_idx on docket.checklist_template_sections(template_id);
alter table docket.checklist_template_sections enable row level security;
grant all on docket.checklist_template_sections to service_role;

create table if not exists docket.checklist_template_items (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references docket.checklist_template_sections(id) on delete cascade,
  title text not null,
  help_text text,
  tags text[] not null default '{}',          -- subset of {Critical, QC, Deadline, Ongoing}
  sort_order int not null default 0
);
create index if not exists docket_cl_items_section_idx on docket.checklist_template_items(section_id);
alter table docket.checklist_template_items enable row level security;
grant all on docket.checklist_template_items to service_role;

create table if not exists docket.checklist_assignments (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references docket.checklist_templates(id) on delete cascade,
  employee_id uuid not null,                  -- → podium.employees
  assigned_by_user_id uuid not null,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz
);
create unique index if not exists docket_cl_assign_active_uniq
  on docket.checklist_assignments(template_id, employee_id) where unassigned_at is null;
create index if not exists docket_cl_assign_emp_idx
  on docket.checklist_assignments(employee_id) where unassigned_at is null;
create index if not exists docket_cl_assign_tmpl_idx on docket.checklist_assignments(template_id);
alter table docket.checklist_assignments enable row level security;
grant all on docket.checklist_assignments to service_role;

create table if not exists docket.checklist_item_completions (
  id uuid primary key default gen_random_uuid(),
  template_item_id uuid not null references docket.checklist_template_items(id) on delete cascade,
  employee_id uuid not null,
  occurrence_date date not null,              -- IST date of this occurrence
  completed_at timestamptz not null default now(),
  completed_by_user_id uuid not null,
  unique (template_item_id, employee_id, occurrence_date)
);
create index if not exists docket_cl_itemcompl_emp_date_idx
  on docket.checklist_item_completions(employee_id, occurrence_date);
alter table docket.checklist_item_completions enable row level security;
grant all on docket.checklist_item_completions to service_role;

create table if not exists docket.checklist_section_comments (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references docket.checklist_template_sections(id) on delete cascade,
  employee_id uuid not null,
  occurrence_date date not null,
  body text,
  author_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (section_id, employee_id, occurrence_date)
);
create index if not exists docket_cl_seccomments_emp_date_idx
  on docket.checklist_section_comments(employee_id, occurrence_date);
alter table docket.checklist_section_comments enable row level security;
grant all on docket.checklist_section_comments to service_role;
