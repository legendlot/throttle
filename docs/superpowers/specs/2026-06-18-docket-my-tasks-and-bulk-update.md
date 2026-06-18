# Docket — cross-space "My tasks" + bulk task update (S153)

> 2026-06-18. Two Docket-only features. Mirrors the S138 cross-space program-view
> pattern (own additive RPC + worker GET + page "mode"); zero change to `list_tasks`
> / `dashboard_stats` (no board/dashboard regression).

## 1. Cross-space "My tasks" (two sections)

**Today:** the sidebar "My tasks" → `/tasks?lens=mine`, which loads the **General**
space with the `lens=mine` filter. Since almost every task lives in a private space,
this view is nearly empty and is single-space only.

**New:** `/tasks?lens=mine` (no `?space`, no `?program`) becomes a dedicated
**My-tasks mode** — a flat, cross-space list of every task I own or collaborate on,
across **all spaces I can access** (same membership frame as the program view), split
into two sections:

- **Assigned to me** — tasks where I'm the **owner** (the sole DRI). Always shown.
- **Collaborating** — tasks where I'm a **collaborator** (and not the owner). Rendered
  in a **collapsible** section (default open, sticky per-person).

Scope decision (Afshaan): "assigned to me" = **owner only** (not creator/dept). A task
where I'm both owner and collaborator falls in *Assigned to me*.

- Recurring (checklist) tasks excluded (as everywhere).
- A **Space** column is shown (rows span spaces), like program mode.
- Search + Manage filters (status/team/priority/overdue/revised + program) still apply;
  the Owner filter, the "My tasks" quick-toggle, and Group-by are hidden (redundant here).
  The Grid triage zone is not shown (focused work view).
- Quick-capture stays, and in this mode **auto-assigns the new task to me** (`assign_self`)
  so it lands under *Assigned to me*.

### Worker
- **New RPC** `docket.list_my_tasks(p_user, p_employee, p_view_all, p_member_space_ids,
  p_default_space_id, …same optional filters as list_tasks_by_program minus program/mine)`
  → `setof docket.tasks`. Predicate: `is_recurring = false` AND
  `(owner = p_employee OR collaborator)` AND cross-space visible
  (`p_view_all OR space = ANY(member) OR space = default`). Returns top-level AND sub-tasks
  (flat — each matching task is its own row). Migration `0010_my_tasks_and_bulk.sql`.
- **New GET `getMyTasks`** — resolves member-space ids + General id (`programScopeArgs`),
  calls `list_my_tasks`, hydrates like `getProgramTasks` (+ `space_name`), and annotates each
  row with **`_relation: 'owner' | 'collaborator'`** (`owner_employee_id === auth.employeeId`).
- `createTaskCore` gains an `assign_self` flag → owner defaults to `auth.employeeId`.

## 2. Bulk task update

Select multiple tasks in the task list and apply one action to all of them:
**owner · status · priority · deadline · program**. Works in **The Grid and the board**
(and naturally in program mode / my-tasks mode — selection is row-level and shared).

- A **Select** toggle in the toolbar enters selection mode. Each row/grid-card then shows a
  selection checkbox — **only for tasks I can edit** (`_can_edit`: owner/creator/admin).
  Tasks I can't edit have **no checkbox** (not selectable) — per Afshaan, I pick exactly the
  tasks I want and the rest stay out; where I'm not the owner they aren't selectable.
- A **master checkbox** selects/clears all currently-visible editable tasks.
- When ≥1 selected, a floating **bulk bar** shows the count + action buttons. Each opens a
  small picker (reusing `OptionList` / `DatePicker`):
  - **Owner** → employee picker (incl. "— Unassigned —").
  - **Status** → settable statuses (no Abandon in bulk — abandon needs a per-task reason).
  - **Priority** → P0–P3.
  - **Program** → program picker (incl. "— No program —").
  - **Deadline** → date picker + optional reason. Per task: first-set if none yet
    (immutable original, logged `deadline_set`); revise if one exists (logged
    `deadline_revised`, **reason required** when any selected task already has a deadline).

### Worker — `bulkUpdateTasks` (POST)
`{ ids:[…], field, value, reason? }`, `field ∈ {owner_employee_id, status, priority,
program_id, deadline}`.

Subrequest-budget-safe (≤4 regardless of N — respects the 50-subrequest limit, no per-row
await loop):
1. Load the tasks (`tasks?id=in.(…)&select=*`) — 1 req.
2. Keep only `canEditTask(auth,t)` AND not `abandoned`; the rest are **skipped** (counted).
3. PATCH the editable ids in one call (`id=in.(…)`), skipping rows already at `value` for a
   clean history. Deadline splits into first-set vs revise (≤2 PATCHes).
   - status `done` stamps `completed_at`; non-done clears it.
4. **One array insert** into `task_history` (one row per task, mirroring the single-task
   `*_changed` / `deadline_set` / `deadline_revised` event types + old→new note).

Returns `{ updated, skipped, field }`. The page reloads + clears selection + toasts
e.g. `Updated 6 · skipped 2`.

## Files
- `docketops-worker/migrations/0010_my_tasks_and_bulk.sql` (new RPC `list_my_tasks`).
- `docketops-worker/src/index.js` — `getMyTasks`, `bulkUpdateTasks`, `createTaskCore`
  `assign_self`, dispatch registration, batched-history helper.
- `apps/docket/src/app/(auth)/tasks/page.js` — my-tasks mode + selection model + bulk bar.
- `apps/docket/src/app/globals.css` — selection checkbox, bulk bar, my-tasks section heads.

## Out of scope / follow-ups
- Bulk add/remove collaborators, bulk move-to-space, bulk abandon (reason-per-task).
- My-tasks: optional sub-section for "created by me, not owned".
