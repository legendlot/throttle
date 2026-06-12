# Docket — Structured Checklist Templates, Oversight & Completion Timestamps

> Design spec · 2026-06-12 · System: Docket (Org Task Manager)
> Builds on RULE-DOCKET-008 (S124 flat per-person recurring tasks). Adds a second,
> structured checklist model **alongside** the flat one — it must not disturb the
> existing simple checklist behaviour.

## Problem

Three gaps in the S124 checklist feature:

1. **No monitoring of assigned checklists.** Once a recurring task is created for someone
   else it moves to *their* checklist and the creator loses sight of it. `getChecklist`
   only lets `view_all` / self / same-department view a person's checklist via the person
   picker; a cross-department assigner can't see it at all, and there is no aggregate
   "what did/didn't my people do" view.
2. **Completion time is invisible.** `docket.checklist_completions.completed_at`
   (timestamptz, default `now()`) + `completed_by_user_id` are written on every check-off,
   but never surfaced — there's no way to see *when* a timed task was actually done, or
   whether it was done late.
3. **Role-linked checklists don't fit the flat model.** The real LOT checklists (e.g.
   *Senior Production Manager daily checklist*) are one structured daily document: ~47
   items in 7 time-windowed sections ("Before 09:00", "By 12:30", "End of Shift"…), each
   item with help text and tags (Critical / QC / Deadline / Ongoing), plus a per-section
   comments box. They belong to a **role**, not a person — whoever holds the role runs it.
   The flat single-item recurring-task model can't express sections, item metadata,
   per-section comments, or role-binding.

## Decisions (locked with Afshaan, 2026-06-12)

- **R3 structure** = full structured templates (sections + per-item help/tags + per-section
  comments), **coexisting** with today's flat personal recurring tasks (kept as-is).
- **Role binding** = assign-to-people, role is a free-text **label**; reassign manually when
  the holder changes. (`podium.job_roles` is empty/unmaintained and 0 of 58 active employees
  carry a `job_role_id`, so binding to Podium roles is not viable today.)
- **Monitoring (R1)** = a manager/assigner **Oversight** view on `/checklist`.
- **Sign-off** = none. Live per-item check-off only; a day's run is "done" when all (or all
  Critical) items are checked. No submit/lock workflow in v1.
- **Authority** = anyone can author a template and assign it (mirrors `createRecurringTask`,
  which already lets any user set another person as owner). Edit/archive a template = its
  creator or `docket_admin`. Completing a run = the **assignee only**.

Current usage is light (6 active recurring tasks, 4 people, 5 completions) — negligible
migration concern; the flat model stays untouched.

## Mental model

Two coexisting concepts surfaced together on `/checklist`:

- **Recurring task** (existing, flat) — a single-item personal reminder, one `docket.tasks`
  row (`is_recurring=true` + `recurrence` jsonb), checked off per day in
  `docket.checklist_completions`. **Unchanged.**
- **Checklist template** (new, structured) — a reusable SOP: `template → sections → items`,
  tagged with a `role_label`, with its own recurrence. **Assigned** to one or more people;
  each assignee runs their own copy each day. A "run" is **derived** (the completions +
  comments that exist for a given template+person+date) — no per-day row is spawned.

Templates live **outside `docket.tasks`**, so they are automatically off the board
(`list_tasks`) and founder dashboard (`dashboard_stats`) — no change to those RPCs.

## Data model — `docket` schema (6 new tables)

All tables: `id uuid PK default gen_random_uuid()`, RLS **enabled**, **no** anon/authenticated
grants, `GRANT ALL ... TO service_role` (RULE-RLS-001). Numeric/`Number()` and
`Math.round()` conventions apply to any counts.

### `checklist_templates`
| col | type | notes |
|---|---|---|
| name | text NOT NULL | e.g. "Senior Production Manager — Daily" |
| role_label | text | free-text role this represents; nullable |
| department_id | uuid | → `podium.departments`, optional (grouping/oversight scope) |
| description | text | |
| recurrence | jsonb NOT NULL | `{freq:'daily'|'weekly'|'monthly', days_of_week?:[0..6], day_of_month?:1..31, until?:'YYYY-MM-DD'}` — **no single `time`** (times live on sections) |
| is_active | boolean NOT NULL default true | soft-disable |
| archived_at | timestamptz | soft-delete; never hard-delete |
| created_by_user_id | uuid NOT NULL | |
| created_at | timestamptz default now() | |
| updated_at / updated_by_user_id | | |

### `checklist_template_sections`
| col | type | notes |
|---|---|---|
| template_id | uuid NOT NULL | → `checklist_templates` ON DELETE CASCADE |
| title | text NOT NULL | e.g. "Before 09:00 — Pre-Shift Checks" |
| subtitle | text | section help line, e.g. "Complete before shift start" |
| due_time | text | `HH:MM` IST, optional — drives late-flagging for the section's items |
| sort_order | int NOT NULL default 0 | |

### `checklist_template_items`
| col | type | notes |
|---|---|---|
| section_id | uuid NOT NULL | → `checklist_template_sections` ON DELETE CASCADE |
| title | text NOT NULL | |
| help_text | text | per-item description |
| tags | text[] NOT NULL default '{}' | subset of {Critical, QC, Deadline, Ongoing} |
| sort_order | int NOT NULL default 0 | |

### `checklist_assignments`
| col | type | notes |
|---|---|---|
| template_id | uuid NOT NULL | → `checklist_templates` ON DELETE CASCADE |
| employee_id | uuid NOT NULL | → `podium.employees` |
| assigned_by_user_id | uuid NOT NULL | |
| assigned_at | timestamptz default now() | |
| unassigned_at | timestamptz | active = NULL (soft, keeps history) |

`CREATE UNIQUE INDEX ... ON checklist_assignments (template_id, employee_id) WHERE unassigned_at IS NULL;`

### `checklist_item_completions`
| col | type | notes |
|---|---|---|
| template_item_id | uuid NOT NULL | → `checklist_template_items` ON DELETE CASCADE |
| employee_id | uuid NOT NULL | the assignee (whose run this is) |
| occurrence_date | date NOT NULL | IST calendar date |
| completed_at | timestamptz NOT NULL default now() | **R2 source of truth** |
| completed_by_user_id | uuid NOT NULL | |

`UNIQUE (template_item_id, employee_id, occurrence_date)` — one completion per item per
person per day; toggle = upsert (ignore-duplicates) / delete, mirroring
`toggleChecklistOccurrence`.

### `checklist_section_comments`
| col | type | notes |
|---|---|---|
| section_id | uuid NOT NULL | → `checklist_template_sections` ON DELETE CASCADE |
| employee_id | uuid NOT NULL | |
| occurrence_date | date NOT NULL | |
| body | text | |
| author_user_id | uuid NOT NULL | |
| created_at / updated_at | timestamptz | |

`UNIQUE (section_id, employee_id, occurrence_date)` — one comment box per section per
person per day (upsert).

Indexes: `template_id` on sections + assignments; `section_id` on items + section_comments;
`(employee_id, occurrence_date)` on item_completions + section_comments; `employee_id` on
assignments.

## Recurrence reuse

Templates reuse the `recurrence` jsonb shape but **without** `time` (times are per-section).
- New `validateTemplateRecurrence(rec)` — like `validateRecurrence` but does **not** require
  `time` and ignores it. `normalizeTemplateRecurrence` drops `time`.
- `isDueOn(rec, dateStr)` already ignores `time` → reused unchanged for "does this template
  run today".
- `isExpired(rec, dateStr)` (the `until` lazy-expiry) reused unchanged.

## Late-flagging (R2)

- **Template items**: late if `completed_at` (rendered in IST `HH:MM`) > the item's section
  `due_time`. Items with no section `due_time` are never "late".
- **Flat recurring tasks**: late if `completed_at` IST time > `recurrence.time`.
- Rendered as a small "late" pill next to the completion time. Computed in the worker (so the
  UI just renders), exposed as `completed_at`, `completed_by` (resolved name), `late` per
  completed item.

## R1 — Oversight

New **Oversight** tab on `/checklist`, shown when the caller manages people OR has assigned a
recurring task/template to anyone OR has `view_all`.

**People in scope** = union of:
- direct reports (`podium.employees.manager_id = caller.employee_id`),
- anyone the caller assigned a recurring task to (`tasks.created_by_user_id = caller` and
  `owner_employee_id <> caller`'s employee) or a template to
  (`checklist_assignments.assigned_by_user_id = caller`),
- everyone, if `view_all`.

For a chosen `date` (default IST today) each person row shows adherence: personal recurring
`x/y` done, and per assigned template `done/total` items with the list of incomplete sections,
completion times, and late flags. Drill into a person → their full **read-only** checklist for
that date (the same `ChecklistRun` rendering, completion disabled).

`canViewChecklistOf` is widened: in addition to `view_all` / self / same-dept, an
**assigner/creator can always view a person they assigned to** (fixes the cross-department R1
gap).

## Permission model

- **Author/assign** a template: any authenticated docket user (baseline). No new perm key.
- **Edit / archive** a template, **edit sections/items**: creator or `docket_admin`
  (mirrors `canEditTask`).
- **Assign / unassign**: any authenticated user (mirrors assigning a recurring-task owner).
- **Complete an item / save a section comment**: the **assignee only** (`employee_id ===
  auth.employeeId`) or `docket_admin`. Managers / `view_all` see runs read-only.
- **View** a template's runs for a person: `canViewChecklistOf` (widened, above).

## Worker (docketops) actions

Helpers (new): `validateTemplateRecurrence`, `normalizeTemplateRecurrence`,
`canEditTemplate(auth, tmpl)`, `lateFlag(completedAtIso, dueTime)`, `peopleInScope(auth, env)`.
Reuse `istDateStr`, `isDueOn`, `isExpired`, `enc`, `inList`, `uniq`, `logHistory` (template-level
history optional — see below).

**GET**
- `getChecklist?employee_id=&date=` (extend) → `{ owner, date, recurring_items:[…flat, now with
  completed_at/completed_by/late…], template_runs:[ { template:{id,name,role_label,department_name},
  sections:[ { …, due_time, items:[ { …, tags, completed, completed_at, completed_by, late } ] },
  comment:{body} ] } ] }`. Only templates **assigned to** the person and **due on** `date` (and
  not expired) appear. `_can_complete` = caller is the assignee.
- `getChecklistTemplates` → list of templates the caller can see (active + own + assigned-to-me),
  with section/item counts + assignee count, for the Manage tab.
- `getChecklistTemplate?id=` → full nested template (sections → items) + active assignees
  (employee id + name). Edit-gated fields flagged via `_can_edit`.
- `getChecklistOversight?date=` → `{ date, people:[ { employee_id, full_name, department_name,
  recurring:{done,total}, templates:[ {template_id, name, done, total, incomplete_sections:[…],
  late_count} ] } ] }` scoped to `peopleInScope`.

**POST**
- `saveChecklistTemplate` — body = full nested `{ id?, name, role_label, department_id,
  description, recurrence, sections:[ {id?, title, subtitle, due_time, sort_order, items:[ {id?,
  title, help_text, tags, sort_order} ] } ] }`. Creates or updates the template, then
  **diff-upserts** sections + items (delete rows not present in the payload, upsert the rest).
  Validates recurrence + tags-subset + `due_time` format. Author = any user; edit = creator/admin.
- `assignChecklistTemplate` `{template_id, employee_id}` / `unassignChecklistTemplate`
  (sets `unassigned_at`). Idempotent via the active-partial unique index.
- `toggleChecklistItem` `{template_item_id, date?, completed}` — assignee-only; upsert/delete a
  `checklist_item_completions` row (mirrors `toggleChecklistOccurrence`).
- `saveSectionComment` `{section_id, date?, body}` — assignee-only; upsert into
  `checklist_section_comments`.
- `archiveChecklistTemplate` `{id}` — creator/admin; sets `archived_at` (soft).

Existing flat actions (`createRecurringTask`, `updateRecurrence`, `toggleChecklistOccurrence`,
`abandonTask`) untouched. All new handlers: `verifyJWT` first, then the per-handler guard.

History: template structure edits are low-risk and high-churn during authoring — v1 logs only
**assign/unassign** to `task_history`-style is out of scope (templates aren't tasks). Skip a
template audit log in v1 (revisit if needed).

## Frontend (`apps/docket`)

`/checklist/page.js` reworked into three views (segmented control at the top):

1. **My day** (default) — today's due items across BOTH models, grouped: personal recurring
   items first, then each assigned template run rendered by `ChecklistRun` (sections with
   due-time labels, items with help text + tag pills + checkbox, completion time + late pill,
   per-section comment box). `x/y` progress per template + overall.
2. **Manage** — the existing personal recurring list (create/edit-schedule/stop, unchanged) +
   "My templates" (authored or assigned to me) with the `ChecklistTemplateEditor`
   (create/edit sections+items+tags+schedule+role label+department+assignees).
3. **Oversight** (conditional) — `OversightPanel`: date picker + the scoped people roster with
   per-person adherence; click a person → read-only `ChecklistRun`s for that date.

New components: `ChecklistTemplateEditor.js`, `ChecklistRun.js`, `OversightPanel.js`,
`TagPill.js`. Extend `RecurrenceEditor` with a `hideTime` prop (template mode). New lib helpers
in `lib/recurrence.js` (template-recurrence validate/summary) + a small `lib/checklist.js`
(progress, late, scope helpers for the client). `TaskDrawer` unchanged for templates (templates
aren't tasks; they open in the editor, not the drawer).

The `/checklist` nav item is unchanged (already present, no perm gate). Tabs are in-page.

## Migration

`docketops-worker/migrations/0007_checklist_templates.sql` — create the 6 tables, enable RLS on
each, `GRANT ALL ... TO service_role`, the indexes + the active-assignment partial unique index.
Additive only; advisor-clean (RLS enabled, no anon grants). No change to `list_tasks` /
`dashboard_stats` / existing tables.

## Build sequencing

- **Phase 1** — migration + worker: template CRUD (`saveChecklistTemplate`, get*),
  assignment, `toggleChecklistItem`, `saveSectionComment`, extend `getChecklist`.
- **Phase 2** — frontend: `ChecklistTemplateEditor`, `ChecklistRun`, My day + Manage tabs.
- **Phase 3** — Oversight (`getChecklistOversight` + `OversightPanel`) + R2 timestamp/late
  surfacing across My day + Oversight + flat-task display.

Shippable incrementally (Phase 1+2 give working role checklists; Phase 3 adds monitoring).

## Out of scope (v1)

- Submit/sign-off + lock workflow; manager counter-sign.
- Custom (free-text) tags; per-item due times (section-level only).
- Binding to `podium.job_roles` / a Docket positions table (role is a label; reassign manually).
- Template version history / structural audit log.
- Completing past/future occurrences (Today/selected-date for own; Oversight is read-only history).
- Checklist adherence on the founder dashboard (Oversight view only, per decision).
- Notifications/reminders at section due times (ties into the deferred V2 notifications).

## Rules / knowledge-file updates

- New **RULE-DOCKET-009** (structured checklist templates) in `BUSINESS_RULES.md`.
- `systems/docket.md` — Checklists section extended with the template model + Oversight + R2.
- `CORE.md` — `docket` schema bullet: add the 6 tables.
- `BACKLOG.md` — close/replace the relevant checklist follow-ups; add live-smoke item.
- This spec linked from `systems/docket.md`.
