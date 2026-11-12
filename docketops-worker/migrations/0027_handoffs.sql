-- F9 R8 — hand-offs (spec §4.6). A hand-off is a task on the GIVER: owner = giver, effective deadline = the
-- hand-off date, status = the hand-off status. These columns name the receiving side and its acceptance.
-- Additive: every existing row has handoff_to_department_id null (not a hand-off). Applied before the worker
-- that reads/writes them deploys.

alter table docket.tasks add column if not exists handoff_to_department_id uuid references podium.departments(id);
alter table docket.tasks add column if not exists handoff_to_employee_id uuid references podium.employees(id);
alter table docket.tasks add column if not exists handoff_accepted_at timestamptz;
alter table docket.tasks add column if not exists handoff_accepted_by uuid;

alter table docket.tasks drop constraint if exists tasks_handoff_shape;
alter table docket.tasks add constraint tasks_handoff_shape check (
  (handoff_to_department_id is not null or (handoff_to_employee_id is null and handoff_accepted_at is null))
  and ((handoff_accepted_at is null) = (handoff_accepted_by is null))
);
alter table docket.tasks drop constraint if exists tasks_handoff_top_level;
alter table docket.tasks add constraint tasks_handoff_top_level check (handoff_to_department_id is null or parent_task_id is null);

create index if not exists tasks_handoff_dept_idx on docket.tasks (handoff_to_department_id) where handoff_to_department_id is not null;
create index if not exists tasks_handoff_emp_idx on docket.tasks (handoff_to_employee_id) where handoff_to_employee_id is not null;

-- Changing who receives it voids an acceptance, unless the same write sets the acceptance (the accept itself).
create or replace function docket.tasks_handoff_reset() returns trigger
language plpgsql set search_path to 'docket', 'public' as $$
begin
  if (NEW.handoff_to_department_id is distinct from OLD.handoff_to_department_id
      or NEW.handoff_to_employee_id is distinct from OLD.handoff_to_employee_id)
     and NEW.handoff_accepted_at is not distinct from OLD.handoff_accepted_at then
    NEW.handoff_accepted_at := null;
    NEW.handoff_accepted_by := null;
  end if;
  if NEW.handoff_to_department_id is null then
    NEW.handoff_to_employee_id := null; NEW.handoff_accepted_at := null; NEW.handoff_accepted_by := null;
  end if;
  return NEW;
end $$;
drop trigger if exists tasks_handoff_reset on docket.tasks;
create trigger tasks_handoff_reset before update of handoff_to_department_id, handoff_to_employee_id, handoff_accepted_at
  on docket.tasks for each row execute function docket.tasks_handoff_reset();
revoke all on function docket.tasks_handoff_reset() from public, anon, authenticated;
