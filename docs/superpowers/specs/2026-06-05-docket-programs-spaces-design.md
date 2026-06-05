# Docket — Programs & Spaces

> Design spec · 2026-06-05 · System: Docket (Org Task Manager)
> Adds two org-organising dimensions to Docket: **Program** (a soft, global grouping
> label) and **Space** (a hard access partition, ClickUp-style, in the left sidebar).

## 1. Goals

Give Docket two new ways to organise tasks that are deliberately different in kind:

- **Program** — a lightweight, org-wide grouping label applied to a task. Purely
  organisational; it has **no** effect on who can see a task. Adds a "by Program"
  group-by axis and an inline-editable Program field, alongside the existing
  Team/Owner axes.
- **Space** — a hard **access partition**. Every task lives in exactly one space.
  A default open space (**General**) preserves Docket's current behaviour; **private
  spaces** are membership-gated so only members can see inside — **including hiding
  from `docket_admin`/`docket_view_all`** (strict separation). Anyone can create and
  own a private space (decentralised, ClickUp-like "Spaces" in the sidebar).

Non-goals: arbitrary space nesting, cross-space task links, per-space custom fields,
notifications. (See §10.)

## 2. Concepts

### 2.1 Program (grouping, global)
- A single org-wide list of programs. A task has **zero or one** program.
- Created **inline by any user** (type a new name in the Program picker → created on
  the fly, like adding a label). No admin gate.
- Used as a third **group-by** option (No grouping / Owner / Team / **Program**) and
  as an inline-editable cell + a filter. Grouping by Program reflows the whole board
  under program headings — same mechanic as the existing group-by.
- Program **names** are visible org-wide (the shared label list). Tasks themselves
  stay gated by their space — a program label leaks nothing about private-space tasks.

### 2.2 Space (access partition, hard)
- Every task belongs to **exactly one** space (`tasks.space_id` NOT NULL).
- **General** — the single default *open* space. `is_default = true`, `is_private = false`,
  no owner. Holds every pre-existing task and anything created without choosing a
  space. **Behaves exactly like Docket today** inside General (dept baseline +
  reviewer/admin see-all). Cannot be archived, renamed, or deleted.
- **Private spaces** — `is_private = true`, created by any user who becomes the
  **owner**. Membership-gated: only the owner + members can see the space exists (in
  their sidebar) or any task in it. **`docket_admin`/`docket_view_all` do NOT bypass
  this** — strict separation is the whole point.
- Decentralised ownership: any authenticated user can create private spaces and run
  their own "special projects" in them.

## 3. Data model (`docket` schema)

All new tables: RLS enabled, `GRANT ALL … TO service_role`, no anon grants (RULE-RLS-001).

### `docket.spaces`
| col | type | notes |
|---|---|---|
| `id` | uuid PK (`gen_random_uuid()`) | |
| `name` | text NOT NULL | |
| `is_default` | bool NOT NULL default false | true only for General (partial-unique: at most one) |
| `is_private` | bool NOT NULL default true | General = false |
| `owner_user_id` | uuid NULL | → auth user; NULL for General |
| `created_by_user_id` | uuid NULL | |
| `created_at` | timestamptz default now() | |
| `archived_at` | timestamptz NULL | soft-archive (owner action); General never archived |

Partial unique index `where is_default` (one General). Seed exactly one General row.

### `docket.space_members`
| col | type | notes |
|---|---|---|
| `space_id` | uuid → spaces | PK part |
| `user_id` | uuid (auth user) | PK part |
| `added_by_user_id` | uuid | |
| `added_at` | timestamptz default now() | |

General is open ⇒ **no rows** (everyone is implicitly a member). Membership rows exist
only for private spaces. The owner is auto-inserted as a member on create.
Index on `user_id` (sidebar lookup: "my spaces").
**Membership keys on `user_id`** ⇒ only employees with a linked `auth_user_id` (login)
can be members/owners. Login-less Podium staff cannot be space members (they can still
be a task **owner** inside General as today).

### `docket.programs`
| col | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text NOT NULL | case-insensitive unique among non-archived (avoid dup labels) |
| `color` | text NULL | optional swatch (UI nicety) |
| `created_by_user_id` | uuid | |
| `created_at` | timestamptz default now() | |
| `archived_at` | timestamptz NULL | |

### `docket.space_history` (append-only audit)
| col | type | notes |
|---|---|---|
| `id` | bigint identity PK | |
| `space_id` | uuid → spaces | |
| `action` | text | `created`/`member_added`/`member_removed`/`renamed`/`archived`/`ownership_transferred`/`admin_recovered` |
| `actor_user_id` | uuid | |
| `note` | text NULL | e.g. old→new name, target member |
| `at` | timestamptz default now() | |

Membership, ownership, and break-glass events are all logged here.

### `docket.tasks` (altered)
- Add `space_id` uuid **NOT NULL** FK → `docket.spaces`, **DEFAULT = General's id**.
- Add `program_id` uuid **NULL** FK → `docket.programs`.
- Indexes: `tasks(space_id)`, `tasks(program_id)`.
- Sub-tasks inherit the parent's `space_id` (one level, always same space).

## 4. Visibility & permission model

### 4.1 Accessible spaces (drives the sidebar)
`accessibleSpaces(user)` = **General** + every private space where the user is the
**owner** or appears in `space_members`. Archived spaces are excluded from the sidebar
but their tasks remain (read-only-ish; no new tasks).

### 4.2 Who can READ tasks
- **General** (`is_default`): unchanged from today — baseline = own + collaborator +
  own-department; `docket_view_all`/`docket_admin` see all of General.
- **Private space:** member (or owner) sees **all** tasks in that space — no dept
  sub-gating inside a private space. **Non-members, including `docket_admin` and
  `docket_view_all`, see nothing** (not in lists, not in dashboard, not in search).

### 4.3 Who can EDIT a task
- **General:** existing rule — task owner / creator / (legacy assignee) / `docket_admin`.
- **Private space:** must be a member, **and** be the task owner/creator **or the space
  owner**. Global `docket_admin` is **not** special inside a private space unless they
  have broken-glass into membership (§8).

### 4.4 Space management authority
- **Create** private space: any authenticated user → becomes owner (+ auto-member).
- **Rename / archive / add member / remove member / transfer ownership:** space **owner**
  only. (Or a `docket_admin` who has recovered the space — §8.)
- **General** is system-managed: not renamable/archivable; membership is implicit.

### 4.5 Programs
- **Create:** any user (inline). **Assign to a task:** anyone who can edit that task.
- Rename/archive of programs: deferred to a small admin action (low priority, §10).

## 5. Worker (`docketops`) changes

`verifyJWT` stays first. New/changed handlers (all wrapped per PATTERN-087 — read
`body.data || body`):

**GET**
- `getMe` (changed): also returns `spaces: [{ id, name, is_private, is_owner }]`
  (= accessible spaces, General first) for the sidebar.
- `getTasks` (changed): accepts `space_id` (default General). Calls `list_tasks` with
  the space; rejects/empties if the caller can't access it. Adds a `program` filter.
  Hydration also returns each task's `program` `{id,name,color}`.
- `getTask` (changed): includes `program` + `space` `{id,name,is_private}`; enforces
  space access before returning.
- `getDashboard` (changed): accepts `space_id`. General → `view_all`-gated org-wide (as
  today). Private space → any member. Calls `dashboard_stats(space_id)`.
- `getPrograms` (new): the global program list (non-archived).
- `getSpaces` (new): caller's accessible spaces (+ membership/owner detail for the
  settings popover). Admin variant `getAllSpaces` (metadata only — names/owner/counts,
  **never tasks**) powers `/admin/spaces` for break-glass.

**POST**
- `createTask` / `createSubtask` (changed): accept `space_id` (validated: caller must be
  able to access it; subtask forced to parent's space). Default General.
- `updateTask` (changed): `program_id` added to allowed fields → per-field history
  (`program_changed`). `space_id` is **not** mutable here — use `moveTask`.
- `moveTask` (new): `{ id, space_id }` — move a task (and its sub-tasks) to another
  space. Caller must be able to edit the task in its current space **and** access the
  target. Logs `task_history` `space_changed`.
- `createProgram` (new): `{ name, color? }` — any user; case-insensitive de-dupe.
- `createSpace` (new): `{ name }` — creator = owner, `is_private=true`, auto-member;
  logs `space_history.created`.
- `renameSpace` / `archiveSpace` (new): owner (or recovered admin); General rejected.
- `addSpaceMember` / `removeSpaceMember` (new): `{ space_id, user_id }` — owner only;
  logged. Removing the owner is rejected (transfer first).
- `transferSpaceOwnership` (new): `{ space_id, new_owner_user_id }` — current owner only;
  new owner must already be a member; logged.
- `recoverSpace` (new, break-glass): `{ space_id, new_owner_user_id? }` — `docket_admin`
  only. Adds the admin (and/or names a new owner) as owner+member; logs
  `space_history.admin_recovered`. The deliberate, audited exception to strict
  separation. Surfaced only from `/admin/spaces`.

Guards: `canAccessSpace`, `canEditTaskInSpace`, `isSpaceOwner`, `requireAdmin`.

## 6. RPC changes (`docket` schema)

- `docket.list_tasks(...)` gains `p_space_id uuid`. Logic:
  - General → existing visibility predicate (baseline dept OR `p_view_all`).
  - Private → `space_id = p_space_id` for **all** rows (membership already proven by the
    worker before the call; the RPC also takes `p_is_member` / resolves membership).
  - Plus existing filters + new `p_program_id`.
- `docket.dashboard_stats(p_space_id uuid)` — same shape as today, scoped to one space;
  General path = org-wide (`view_all`), private path = that space (member).
- Both keep the single-subrequest design (no per-row awaits).

## 7. Frontend (`apps/docket`)

### 7.1 Sidebar (ClickUp-style)
- `nav.js`/`layout.js`: the **TASKS** group becomes partly dynamic. Under the static
  `Tasks` item (= General, route `/tasks`, no `space` param), inject one item per
  accessible **private** space (route `/tasks?space=<id>`), then a **＋ New space**
  affordance. Active detection must include the `space` query param, not just pathname.
  - ⚠️ **Implementation unknown to confirm in the plan:** whether the shared
    `@throttle/ui` `Sidebar` supports query-param routes + active-by-query and a
    dynamic sub-list. If not, extend `Sidebar` additively (opt-in), mirroring the
    `commitOnTab` precedent — zero blast radius to other apps.

### 7.2 Tasks page (`/tasks`)
- Reads `space` from the query string (default = General). Passes `space_id` to
  `getTasks`. The Needs-Setup tray, board, group-by, and search all scope to the
  current space. Header shows the space name; if the user is the space owner, a small
  **settings** affordance (rename / members / transfer / archive) opens a popover.
- QuickCapture + `createTask` create in the **current** space.
- **Program**: group-by gains "Program"; the filter popover gains a Program filter; a
  **Program** cell is added to the row (inline `Combobox`, create-on-type via
  `createProgram`). Keep the row single-line — Program likely shares space with/replaces
  a low-value column on narrow widths (decide in layout pass).

### 7.3 Space settings (owner)
Popover/modal: rename, member list (add/remove via employee Combobox → resolves to
`user_id`; login-less employees are non-selectable with a hint), transfer ownership,
archive. All call the §5 actions; reflect `space_history` is server-side only (no UI v1).

### 7.4 Per-space dashboard
`/dashboard?space=<id>` — General dashboard stays `view_all`-gated (nav item unchanged);
a space member opens their space's dashboard from the space's settings/header. Same tiles,
scoped via `dashboard_stats(space_id)`.

### 7.5 Admin: `/admin/spaces` (docket_admin)
Lists **all** spaces (metadata only: name, owner, member count, task count, archived) —
**no task contents**. Provides the **Recover (break-glass)** action → `recoverSpace`.
This is the only place an admin sees that a private space exists. (Accepted minor
metadata exposure for governance; flagged for the user.)

## 8. Orphaned-space handling (owner leaves)

Two layers, as chosen:
1. **Primary — ownership transfer.** Owners can `transferSpaceOwnership` to a member
   before leaving. Encouraged in the settings UI.
2. **Fallback — audited admin break-glass.** If transfer didn't happen, a `docket_admin`
   uses `recoverSpace` from `/admin/spaces` to reassign/gain access. Every recovery
   writes `space_history.admin_recovered` (who, when). This is the deliberate, logged
   exception to "space wins even over admin."

## 9. Migration plan

One migration (`docket_programs_and_spaces_v1`):
1. Create `spaces`, `space_members`, `programs`, `space_history` (+ RLS on + service_role
   grants + indexes).
2. Seed **General** (`is_default=true, is_private=false, owner_user_id=null`).
3. `ALTER TABLE docket.tasks ADD COLUMN space_id uuid` → backfill all rows to General's id
   in the same migration (capture id in a `DO` block / CTE), then `SET NOT NULL` + FK +
   `DEFAULT` General id; `ADD COLUMN program_id uuid NULL` + FK.
4. Replace `list_tasks` + `dashboard_stats` with the space-aware versions.
5. `docket` is already on the PostgREST exposed-schemas list — no change.
6. Advisor pass (RLS/policy) after apply, as with `docket_v1`.

No new `store.sequences` keys (spaces/programs use uuids; tasks keep `DKT-NNNN`).

## 10. Out of scope / deferred (YAGNI)

- Program rename/archive UI + colors management (create + assign only in v1).
- Multiple *open* spaces (only General is open in v1).
- Space nesting / folders / lists-within-spaces (ClickUp's deeper hierarchy).
- Moving the dept-baseline INTO private spaces (private = flat, all members see all).
- Notifications on space invite / task move.
- Cross-space task links, per-space custom fields, saved per-space filters.

## 11. Business rules to add

- **RULE-DOCKET-003 (Spaces):** every task lives in exactly one space; General is the
  open default (current behaviour); private spaces are membership-gated and hide tasks
  even from `docket_admin`/`view_all`; in-space visibility is flat (all members see all);
  edit = task owner/creator or space owner; orphan recovery = owner transfer + audited
  admin break-glass (`space_history`).
- **RULE-DOCKET-004 (Programs):** a global, org-wide grouping label; zero-or-one per task;
  created inline by any user; no access effect; a third group-by axis.

## 12. Open questions

None blocking. Two items to confirm during planning, not design:
- `@throttle/ui` `Sidebar` capability for dynamic/query-param items (§7.1) — extend
  additively if needed.
- Exact row layout once a Program column is added (which column yields on narrow widths).
