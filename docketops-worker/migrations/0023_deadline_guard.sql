-- F9 R5 part 3 — apply only AFTER docketops calls docket.task_set_deadline (0021) for every deadline
-- write: from here an UPDATE of tasks.deadline / revised_deadline outside that RPC is refused, and the
-- original deadline is immutable (RULE-DOCKET-001, now enforced by the database).
create or replace function docket.tasks_deadline_guard() returns trigger
language plpgsql set search_path to 'docket', 'public' as $$
begin
  if (NEW.deadline is distinct from OLD.deadline or NEW.revised_deadline is distinct from OLD.revised_deadline)
     and coalesce(current_setting('docket.deadline_rpc', true), '') <> 'on' then
    raise exception 'deadline_via_rpc' using errcode = 'check_violation';
  end if;
  if OLD.deadline is not null and NEW.deadline is distinct from OLD.deadline then
    raise exception 'deadline_immutable' using errcode = 'check_violation';
  end if;
  return NEW;
end $$;
drop trigger if exists tasks_deadline_guard on docket.tasks;
create trigger tasks_deadline_guard before update of deadline, revised_deadline on docket.tasks
  for each row execute function docket.tasks_deadline_guard();

