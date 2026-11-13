-- podium_dept_google_label_dirty_v1 — the Google department label is now "<Parent> - <Child>" (0024 / googlesync
-- googleDepartmentLabel), so a team's label changes when the team is renamed, MOVED (parent_department_id), or its
-- PARENT is renamed. 0015's trigger watched only `name` and only the team's own members. This re-points it: on a
-- name or parent change, dirty `department` for the members of the team AND of its direct sub-teams (the tree is
-- two levels deep; a sub-team's label never names a grandparent). Re-runnable.
create or replace function podium.departments_google_sync_dirty()
returns trigger language plpgsql security definer set search_path to 'podium', 'public' as $$
begin
  perform podium.google_sync_mark(array(
      select e.id from podium.employees e
       where e.status <> 'exited'
         and (e.department_id = new.id
              or e.department_id in (select c.id from podium.departments c where c.parent_department_id = new.id))),
    array['department'], podium.gsync_actor());
  return null;
end $$;
create or replace trigger departments_google_sync after update of name, parent_department_id on podium.departments
  for each row when (old.name is distinct from new.name or old.parent_department_id is distinct from new.parent_department_id)
  execute function podium.departments_google_sync_dirty();
