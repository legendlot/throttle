# Docket — Programs in the Sidebar (cross-space program view)

> Design spec · 2026-06-15 · System: Docket (Org Task Manager)
> Worker: `docketops` · App: `apps/docket` · DB: `docket` schema

## Problem

Programs in Docket are a **global, soft grouping label** (`docket.programs`, `tasks.program_id`,
RULE-DOCKET-004) with no access effect. They are already a filter + group-by axis on the `/tasks`
board, but there is **no way to jump straight to "everything in this program."** In practice almost
all real work lives in **shared private spaces** (General is rarely used), and a program routinely
**spans several spaces**. Today the board (`getTasks` → `list_tasks`) is **hard-scoped to a single
space** (`t.space_id = p_space_id`), so a program's tasks can only ever be seen one space at a time.

## Goal

A **Programs** section in the Docket left sidebar that lets anyone quickly jump to a program and see
**all tasks tagged to that program, across every space they can access, in one view** — while keeping
the sidebar clean and compact. A program created inline on a new task appears in the sidebar
automatically.

## Scope decisions (settled in brainstorming)

1. **Cross-space view.** Clicking a program shows every task with that `program_id` that the caller can
   see across **all accessible spaces** (membership-respecting), not just the current space.
2. **Sidebar lists only programs the caller has ≥1 visible task in, with a task-count badge.** A program
   living in a space the caller is not a member of does not clutter their sidebar; every click lands on a
   non-empty view. (Creating a task with a new program → the creator can see it → it appears.)
3. **Collapsible groups.** Sidebar group headers collapse/expand (chevron); per-group state persisted per
   person in `localStorage`. **Programs** defaults expanded; **My spaces** and **By others** default
   collapsed. Override rule: *a group renders expanded if it is manually/default-expanded **or** it
   contains the currently-active selection* (so the group holding the open space/program auto-expands).

## Visibility rule (the one rule, applied across spaces)

A task is visible to the caller iff:
- `p_view_all` (reviewer/admin), **OR**
- the task's `space_id` ∈ the caller's **member private spaces**, **OR**
- the task is in **General** (the default space) AND baseline applies:
  `owner_employee_id = me` OR legacy `assignee_employee_id = me` OR `created_by_user_id = me`
  OR `department_id = my dept` OR caller is a collaborator.

This mirrors the existing `list_tasks` predicate exactly; the only change is it is evaluated **across
spaces in a single query** instead of after the worker has pinned one space.

## Architecture — Option A (dedicated RPCs)

Two **new** functions in a new migration; the load-bearing `list_tasks` / `dashboard_stats` are left
**untouched** (zero regression risk to the board/dashboard).

### Migration `0009_programs_nav.sql` (additive, advisor-clean)

**`docket.programs_for_user(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
p_member_space_ids uuid[], p_default_space_id uuid)`** → `TABLE(id uuid, name text, color text,
task_count bigint)`, `stable security definer set search_path = docket, public`.
- Aggregates over the visible-task set (visibility rule above), `is_recurring = false`,
  `parent_task_id is null` (top-level only — so the count equals the rows the view renders).
- Returns one row per program that has ≥1 visible top-level task, `name asc`. `task_count` = count of
  visible non-recurring top-level tasks in that program (all statuses — matches exactly what the view renders).
- `GRANT EXECUTE … TO service_role`.

**`docket.list_tasks_by_program(p_user uuid, p_employee uuid, p_dept uuid, p_view_all boolean,
p_member_space_ids uuid[], p_default_space_id uuid, p_program_id uuid, p_status text default null,
p_department_id uuid default null, p_employee_filter uuid default null, p_priority text default null,
p_overdue boolean default false, p_revised boolean default false, p_mine boolean default false,
p_q text default null)`** → `setof docket.tasks`, `stable security definer set search_path = docket,
public`.
- Same visibility rule across spaces, `program_id = p_program_id`, `is_recurring = false`. Returns
  **top-level tasks AND their sub-tasks** (the page nests children under parents, exactly like the space
  board); the sidebar count badge counts **top-level only** (`programs_for_user`), which equals the
  board's top-level rows. Applies the same optional filters as `list_tasks`
  (status/dept/owner/priority/overdue/revised/mine/q).
- Same `ORDER BY` as `list_tasks` (P-priority, then `coalesce(revised_deadline, deadline)` asc nulls
  last, then `created_at desc`).
- `GRANT EXECUTE … TO service_role`.

### Worker (`docketops-worker/src/index.js`)

- **`getMe`** — additionally returns `programs` by calling `programs_for_user` with the caller's already
  -resolved `employee_id` / `department_id` / `view_all` + member space ids + default space id. (`getMe`
  already loads spaces + membership, so this reuses that resolution.)
- **New GET `getProgramTasks`** `?program_id=…` (+ the optional filters above):
  - `verifyJWT` → resolve employee/dept/view_all, member space ids, default space id.
  - Call `list_tasks_by_program` RPC.
  - Hydrate **identically to `getTasks`** (department name, owner name, `collaborators[]`, `creator_name`,
    child/doc/comment counts, `program`) **plus `space_name`** per task (batch space lookup) so the view
    can show which space each task lives in.
  - No new permission key; visibility is enforced in the RPC.
- Register `getProgramTasks` in the GET action map.

### Frontend (`apps/docket`)

- **`components/DocketSidebar.js`:**
  - New **Programs** collapsible group, placed directly under the **Work** group's "My tasks". Each row =
    colour dot (`program.color || personColor(id)`) + name + a small count badge, routing via
    `onSelect('/tasks?program=' + id)`. Active when `activeKey === '/tasks?program=' + id`.
  - New collapsible group-header affordance (chevron) for **Programs / My spaces / By others**. A
    `collapsed` map persisted in `localStorage` key `docket.nav.collapsed`. A group renders expanded if
    persisted/default-expanded OR it contains the active selection.
  - Accept new props: `programs = []` and (already has) `activeKey`.
- **`app/(auth)/layout.js`:**
  - Store `programs` from `getMe`; pass to `DocketSidebar`.
  - Refetch programs on a new `docket:programs-changed` window event (mirrors `docket:spaces-changed`),
    fired after inline program-create on the tasks page.
  - `activeKey` computation learns `/tasks?program=<id>`.
- **`app/(auth)/tasks/page.js` — program mode** (when `?program=<id>` is present and no `?space`):
  - Fetch via `getProgramTasks` instead of `getTasks`.
  - Render an extra **Space** column (rows span spaces); header shows the program name + count.
  - Hide space-only chrome (New-space, SpaceSettings, space-dashboard button) and the now-redundant
    **Program** filter in Manage. All **other** Manage filters + group-by + client-side search still work.
  - **Quick-capture in program mode auto-tags the program** (S138 follow-up). The capture bar gains a compact
    **space picker** defaulting to the program's most-common existing space (computed client-side from the
    loaded rows; General if the program is brand-new), since a task must live in exactly one space. Type a
    title → `createTask({ title, space_id, program_id })` (worker access-checks the chosen space). Fires
    `docket:programs-changed` to refresh the sidebar count.
  - Still publish the visible task count to the topbar (existing `lib/chrome.js` bridge).
  - Fire `docket:programs-changed` after a successful inline program-create (so a brand-new program lands
    in the sidebar) — this is additive to the existing `createAndAssignProgram` path.

## Data flow

```
app load → getMe → { …, spaces[], programs:[{id,name,color,task_count}] }
                         │
                         └─> DocketSidebar renders Programs group (collapsible, counts)
click program → /tasks?program=<id>
   tasks page (program mode) → getProgramTasks(program_id, …filters)
       → list_tasks_by_program RPC (cross-space, visibility-filtered)
       → hydrate (+ space_name) → board table with Space column
inline create new program on a task → createProgram → window 'docket:programs-changed'
       → layout refetches getMe.programs → sidebar updates
```

## Non-goals / YAGNI

- No per-program dashboard (the view is the board list; `dashboard_stats` stays single-space).
- No program rename/archive/colour management UI in this pass (programs are still created inline; manage
  later if asked).
- No new permission keys or access semantics — programs remain soft labels; the **space** membership is
  the only access boundary and is honoured by the visibility rule.
- Quick-capture into a program view (which would need a target-space chooser) is deferred — create in a
  space, tag the program.

## Risk / blast radius

- `docketops` worker serves **Docket only** (single-system blast radius).
- The new RPCs are additive; `list_tasks` / `dashboard_stats` are not modified, so the board and
  dashboard cannot regress from this change.
- Shared `@throttle/ui` is **not** touched (Docket uses its own `DocketSidebar`); Garage/Redline/Throttle
  unaffected. Still build all monorepo apps before commit per repo rule.

## Test / verification

- Migration applies advisor-clean; `programs_for_user` and `list_tasks_by_program` exist with
  service_role grants.
- Worker `node --check`; `getMe` returns `programs[]`; `getProgramTasks` returns hydrated cross-space rows
  with `space_name`.
- `apps/docket` builds clean (route count unchanged — program mode is the existing `/tasks` route).
- **Live browser smoke (needs a Google login):** Programs group lists only programs you have tasks in,
  with correct counts; collapse/expand persists across reloads; My spaces / By others default collapsed,
  the active space's group auto-expands; click a program spanning two private spaces you belong to → see
  tasks from both with a Space column; a program in a space you're NOT a member of does not appear; create
  a task with a brand-new program inline → it appears in the sidebar without a manual reload; reviewer/
  admin (view_all) sees org-wide program counts.
```
