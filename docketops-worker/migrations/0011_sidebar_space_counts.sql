-- 0011_sidebar_space_counts.sql — S309
--
-- Sidebar task-count badges for SPACES, and a correction to the PROGRAMS badge
-- that already existed.
--
-- ── What a sidebar badge counts, and why ────────────────────────────────────
-- OPEN (status not in done/abandoned) · non-recurring · TOP-LEVEL (parent_task_id
-- is null) tasks the caller can see.
--
-- ⚠️ This deliberately does NOT equal the row count on the board you land on
-- when you click. The board applies no status filter by default, so it also
-- lists done tasks, and it nests sub-tasks under their parents. The badge is a
-- "how much live work is in here" signal, not a row count. Do NOT "fix" it into
-- an all-time count to make the two agree — that is the bug this migration
-- removes, not a consistency win.
--
-- ── The programs_for_user correction ────────────────────────────────────────
-- programs_for_user (0009) had NO status filter, so a program whose work was
-- entirely finished still carried a badge. Measured 2026-08-25 before the change,
-- on live data: `Miracle` showed 2 with BOTH tasks done, and `Project June Sales/
-- Production Spike` showed 1 with that task done — 2 of the 3 live programs were
-- advertising work that did not exist. Only `Bogus` (3 shown / 2 open) was even
-- close. Programs are lightly used so the blast radius was small, but spaces are
-- not (1,021 tasks, 350 open as of today), so mirroring the same all-time
-- semantics into space badges would have shipped a number ~3x the useful one.
--
-- ⚠️ The body below is rebuilt from the LIVE pg_get_functiondef output, NOT from
-- 0009_programs_nav.sql. PATTERN-297: a CREATE OR REPLACE reconstructed from a
-- repo migration file silently dropped a live filter that had been added later.
-- The ONLY intended change is the added status predicate.
--
-- Additive + idempotent. list_tasks / list_my_tasks / dashboard_stats UNTOUCHED.

begin;

-- ── 1. Programs badge: add the open-only predicate. Everything else verbatim. ──
create or replace function docket.programs_for_user(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_member_space_ids uuid[], p_default_space_id uuid
)
returns table(id uuid, name text, color text, task_count bigint)
language sql
stable security definer
set search_path to 'docket', 'public'
as $function$
  select p.id, p.name, p.color, count(t.id) as task_count
  from docket.programs p
  join docket.tasks t on t.program_id = p.id
  where p.archived_at is null
    and t.is_recurring = false
    and t.parent_task_id is null
    and t.status not in ('done','abandoned')          -- ← S309: the only change
    and (
      p_view_all
      or t.space_id = any(p_member_space_ids)
      or (
        t.space_id = p_default_space_id and (
          t.owner_employee_id = p_employee
          or t.assignee_employee_id = p_employee
          or t.created_by_user_id = p_user
          or (p_dept is not null and t.department_id = p_dept)
          or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
        )
      )
    )
  group by p.id, p.name, p.color
  order by p.name asc;
$function$;

-- ── 2. Space badges. ─────────────────────────────────────────────────────────
-- Visibility mirrors list_tasks EXACTLY, which is what makes the badge honest:
-- a private space the caller can reach shows every open task in it, while the
-- default (General) space is narrowed to the caller's own relation to the task
-- unless they hold view-all. Getting this wrong would leak the SIZE of other
-- people's work in General even though the titles stay hidden.
--
-- Returns one row per space that has >= 1 open task. A space with none is simply
-- absent — the caller renders no badge rather than a "0", because a zero badge
-- reads as a broken count rather than an empty space.
create or replace function docket.space_counts_for_user(
  p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
  p_space_ids uuid[]
)
returns table(space_id uuid, task_count bigint)
language sql
stable security definer
set search_path to 'docket', 'public'
as $function$
  select t.space_id, count(*) as task_count
  from docket.tasks t
  join docket.spaces s on s.id = t.space_id
  where t.space_id = any(p_space_ids)
    and t.is_recurring = false
    and t.parent_task_id is null
    and t.status not in ('done','abandoned')
    and (
      (not s.is_default)                              -- private space: caller is already scoped by p_space_ids
      or p_view_all
      or t.owner_employee_id = p_employee
      or t.assignee_employee_id = p_employee
      or t.created_by_user_id = p_user
      or (p_dept is not null and t.department_id = p_dept)
      or exists (select 1 from docket.task_collaborators c where c.task_id = t.id and c.employee_id = p_employee)
    )
  group by t.space_id;
$function$;

grant execute on function docket.space_counts_for_user(uuid, uuid, uuid, boolean, uuid[]) to service_role;

commit;

-- PostgREST caches the schema at start; a function it has never seen is invisible
-- until the cache reloads, and the failure is SILENT (the call returns not-found,
-- indistinguishable from an empty result). CORE.md — add this to any migration
-- whose object the worker reads in the same session.
notify pgrst, 'reload schema';
