# Docket — Checklists (recurring tasks) — design

> Session 124 (2026-06-12, Afshaan). Status: building.
> Rule: RULE-DOCKET-008. Spoke: `systems/docket.md`.

## What it is

A **Checklist** is a per-person container of **recurring tasks**, distinct from the
one-time tasks on the `/tasks` board. **Every person has exactly one checklist** — it
holds recurring tasks they created for themselves *or* that someone else created and
**assigned** to them. A recurring task otherwise **behaves like any other Docket task**
(owner, program, department, priority, collaborators, comments, doc-links, history) and
**follows the same visibility logic** — it just recurs and lives on the checklist page,
not the board.

Decisions locked with Afshaan (S124):
- **Recurrence model = one task + completion log** (the recurring task is a single row that
  never permanently "completes"; each scheduled day it presents one checkable occurrence;
  each check writes a completion record → full adherence history, no row explosion).
- **Custom categories = deferred** (not in v1; add later once usage is understood).
- **Checklist tasks appear on checklist pages ONLY** — excluded from the `/tasks` board and
  the founder dashboard counts.
- **No "N times a day."** Recurrence = **daily / weekly (incl. specific weekdays) / monthly**,
  each at a **set time of day** (one occurrence per scheduled day).

## Data model

Recurring tasks live in **`docket.tasks`** (NOT a separate table) so they reuse every task
mechanism (visibility via `list_tasks`/`canSeeTask`, collaborators, comments, docs, history,
DKT-NNNN numbering, the drawer). Two additions + one new table (migration `0006_checklists.sql`):

```sql
alter table docket.tasks
  add column is_recurring boolean not null default false,
  add column recurrence  jsonb;            -- null for one-time tasks
create index docket_tasks_recurring_owner_idx
  on docket.tasks(owner_employee_id) where is_recurring;

create table docket.checklist_completions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references docket.tasks(id) on delete cascade,
  occurrence_date date not null,           -- the IST date this occurrence belongs to
  completed_at timestamptz not null default now(),
  completed_by_user_id uuid not null,
  unique (task_id, occurrence_date)        -- one occurrence per task per day (no N/day)
);
create index docket_checklist_compl_task_idx
  on docket.checklist_completions(task_id, occurrence_date);
alter table docket.checklist_completions enable row level security;
grant all on docket.checklist_completions to service_role;
```

**Board/dashboard exclusion** — `list_tasks` and `dashboard_stats` are recreated with
`CREATE OR REPLACE` (no signature change) adding `and t.is_recurring = false` everywhere they
count/return tasks. So recurring tasks never show on `/tasks` or `/dashboard`.

### `recurrence` jsonb shape

```jsonc
{
  "freq": "daily" | "weekly" | "monthly",
  "days_of_week": [0,1,2,3,4,5,6],   // weekly only — 0=Sun..6=Sat (JS getDay). 1 day = classic weekly; many = "specific weekdays"
  "day_of_month": 1..31,             // monthly only — clamped to the month's last day
  "time": "HH:MM",                   // 24h, IST — the set time of day
  "until": "YYYY-MM-DD"              // optional expiry (IST). After this date the task auto-drops off the checklist. Omitted = never expires.
}
```

**Expiry (added S124-cont):** `until` is an optional IST end date. Lazy expiry — `getChecklist` filters out
tasks whose `until < today`, so after that date they vanish from BOTH the Today card and the manage list and
no longer clog the checklist. The row stays in the DB (completion history intact); no auto-abandon, no cron.
- **daily** → every day at `time`.
- **weekly** → on each weekday in `days_of_week`, every week, at `time`.
- **monthly** → on `day_of_month` each month (clamped), at `time`.

`time`/dates are **IST (Asia/Kolkata)**. The worker computes "today" and "due on date D" in IST
(`Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'})`), never UTC.

### Status semantics

A recurring task is created `status='in_progress'` (= active). The per-day done state is the
completion log, NOT `tasks.status`. Terminal stop = **Abandoned** (RULE-DOCKET-001, reuse
`abandonTask`) which stops it recurring. (Pause-without-abandon is deferred.) Recurring tasks are
always top-level (`parent_task_id` null, no sub-tasks in v1) and default to the **General** space
(space is irrelevant since they're off the board).

## Worker (docketops)

New handlers:
- **GET `getChecklist`** `?employee_id=` (optional; default = caller's employee). Person-level gate
  `canViewChecklistOf(target)` = `view_all` OR target is me OR target shares my department. Returns:
  `{ owner:{id,full_name}, today:'YYYY-MM-DD', items:[ task + recurrence + due_today + completed_today + recurrence_summary + _can_complete ] }`. Items = all non-abandoned recurring tasks owned by target, hydrated (`hydrateTasks`) + each joined to today's completion. `_can_complete = canEditTask`.
- **POST `createRecurringTask`** `{title, recurrence, owner_employee_id?, program_id?, department_id?, priority?, description?, collaborators?}` → reuses `createTaskCore` with `is_recurring=true` + validated `recurrence`; default owner = caller's employee ("create for myself"); status forced `in_progress`; space = General; parent forbidden.
- **POST `updateRecurrence`** `{id, recurrence}` → `canEditTask`, validate, patch, log `recurrence_changed`.
- **POST `toggleChecklistOccurrence`** `{id, date?, completed}` → `canEditTask`; date defaults to IST today; `completed=true` upserts a completion row, `completed=false` deletes it. (No `task_history` noise — the completion row is the audit.)

Reused unchanged: `updateTask` (title/owner/program/dept/priority — reassigning owner moves the
task to the new person's checklist), `abandonTask`, comments/docs/collaborators, `getTask`/drawer.

`validateRecurrence(rec)`: freq∈{daily,weekly,monthly}; `time` matches `^([01]?\d|2[0-3]):[0-5]\d$`;
weekly ⇒ `days_of_week` non-empty subset of 0..6; monthly ⇒ `day_of_month` 1..31.

## Frontend (`apps/docket`)

- **`/checklist` page** (`app/(auth)/checklist/page.js`) — nav item placed next to Scratchpad
  (no perm gate). Header: "Checklist" + person selector (default "My checklist"; options = me +
  (view_all ? everyone : my-department employees), computed client-side from `getMe` + `getEmployees`).
  - **Today card:** IST date, progress `x/y done`, the due-today items as big checkboxes (title, time,
    priority dot, program/dept chips). Checking calls `toggleChecklistOccurrence`. Past-time-not-done
    rows get a subtle overdue tint. Checkboxes disabled when `!_can_complete` (viewing someone else's).
  - **All recurring (manage):** flat list (ordered by time, then title) of the person's recurring task
    definitions with a recurrence summary + status; **+ New recurring task** inline create (title +
    `RecurrenceEditor` + owner/assignee picker + optional program/dept/priority/description); per-row
    edit recurrence / abandon; row title → existing `TaskDrawer` (comments/history/docs/collaborators).
- **`components/RecurrenceEditor.js`** — freq segmented control (Daily / Weekly / Monthly) + weekday
  multiselect (weekly) + day-of-month (monthly) + time input. Emits the `recurrence` jsonb.
- **`lib/recurrence.js`** — client mirror of the worker logic: `recurrenceSummary(rec)` ("Daily at
  9:00 AM", "Weekly · Mon, Wed, Fri at 6:00 PM", "Monthly on the 15th at 10:00 AM"), `isDueOn(rec,date)`,
  weekday labels.
- **`lib/nav.js`** — add `{ id:'checklist', label:'Checklist', route:'/checklist', icon:ListTodo }`
  alongside Scratchpad in `buildNavGroups`.
- **`TaskDrawer`** — when `task.is_recurring`, show a "Repeats" line (recurrence summary) in place of
  the deadline control.

## Out of scope (v1) / deferred

Custom categories; pause-without-abandon; date navigation / completing past or future occurrences
(v1 completes **today** only); sub-tasks on recurring tasks; checklist adherence on the founder
dashboard; notifications/reminders at the set time.
