-- podium_title_level_team_v1 — Title / Level / Team (spec docs/superpowers/specs/2026-11-13-podium-title-level-team.md).
-- Afshaan 2026-11-14 on the confirmed org sheet: (1) a Level ladder L0–L10 on people and openings; (2) every team names
-- the founder who owns it (the skip-level when the direct manager's seat is empty); (3) "Wherever the direct reporting
-- manager is vacant, leave it vacant, mark it to be hired, so don't put placeholders, let Vinay and I be skip level
-- managers for those positions" → employees.manager_to_be_hired. No data change here: the sheet load is a separate,
-- snapshotted step. Re-runnable.

-- ── Levels: one ladder for every team ──
create table if not exists podium.levels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  rank int not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into podium.levels (code, name, rank) values
  ('L0', 'Intern', 0), ('L1', 'Associate', 1), ('L2', 'Senior Associate', 2), ('L3', 'Assistant Manager', 3),
  ('L4', 'Manager', 4), ('L5', 'Senior Manager', 5), ('L6', 'Associate Director', 6), ('L7', 'Director', 7),
  ('L8', 'Senior Director', 8), ('L9', 'VP', 9), ('L10', 'Founder', 10)
on conflict (code) do nothing;
alter table podium.levels enable row level security;
grant all on podium.levels to service_role;

alter table podium.employees add column if not exists level_id uuid references podium.levels(id);
alter table podium.openings add column if not exists level_id uuid references podium.levels(id);

-- ── Team founder owner (Vinay or Afshaan; null = both, e.g. Founder's Office) ──
alter table podium.departments add column if not exists founder_owner_employee_id uuid
  references podium.employees(id) on delete set null;

-- ── Vacant direct manager: manager_id stays null and the seat reads "To be hired" ──
alter table podium.employees add column if not exists manager_to_be_hired boolean not null default false;
alter table podium.employees drop constraint if exists employees_manager_tbh_check;
alter table podium.employees add constraint employees_manager_tbh_check
  check (not (manager_to_be_hired and manager_id is not null));

notify pgrst, 'reload schema';
