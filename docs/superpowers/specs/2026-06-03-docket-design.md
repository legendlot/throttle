# Docket — Org Task Manager · V1 Design

> System: **Docket** (NEW) · Worker: **docketops** · Schema: **docket** (shared `lot-production` DB)
> App: `apps/docket` · Domain: `docket.legendoftoys.com` · Deploy repo: `legendlot/docket`
> Date: 2026-06-03 · Status: approved design, pre-implementation
> Origin: Afshaan — org-level task manager sitting alongside the other Throttle-monorepo apps,
> own user management + own worker, shared DB with its own schema.

Build mirrors the **Podium / Snorkel** stack 1:1 (own worker, own permission layer in `store`,
own schema, GH-Pages app, shared `@throttle/*` packages). Where a decision matches an existing
LOT convention, this spec follows it rather than inventing a new one.

## 1. Purpose & scope

An **organisation-wide task tracker** for LOT — create/assign/track work across every department,
with a founder-level review dashboard. Categorised by **team/department** (sourced live from
Podium), with owners, assignees, collaborators, sub-tasks, document links, comments, and a fully
**auditable history** of deadline revisions and status changes.

- **In scope (V1):** task CRUD (no delete — see below), owner/assignee/collaborators, parent⇄child
  sub-tasks (one level), multiple document **links**, flat comments (Throttle-style), immutable
  created-date + immutable original deadline + revisable deadline (audited), 5-state status,
  priority P0–P3, list view (filterable + groupable by person/department), founder review dashboard,
  own permission/role layer.
- **Explicitly NOT in scope (V1):** notifications (Slack/email), kanban board, arbitrary sub-task
  nesting (one level only), custom-field **UI** (the `custom_fields` column ships as the hook),
  file uploads (links only — no storage bucket), cross-links to Garage/Pitstop/Throttle work items.

**A task is never deletable or cancellable.** The only terminal "stop" is **Abandoned** (= "not
required"), which is logged in history like every other status change.

## 2. Stack

| Layer | Detail |
|---|---|
| Worker | `docketops` — `docketops.afshaan.workers.dev`. Source `05_Throttle/docketops-worker/src/index.js`. Deploy `cd 05_Throttle/docketops-worker && npx wrangler deploy`. Own blast radius (one system). |
| Frontend | `apps/docket/` (Next.js static export, like podium) → `legendlot/docket` gh-pages → `docket.legendoftoys.com`. New workflow `.github/workflows/deploy-docket.yml`. |
| Auth | Supabase Google OAuth, `@legendoftoys.com` only (RULE-010). `verifyJWT` resolves identity from `store.users_profile`, **permissions from Docket's own layer** `store.docket_user_roles → docket_roles.permissions` (mirrors Podium RULE-PODIUM-006 / Snorkel RULE-SNORKEL-002). Caller's `podium.employees` row resolved via `auth_user_id` for department scoping. |
| DB | Supabase `lot-production`, **new `docket` schema**. Reads `podium.departments` + `podium.employees` cross-schema (service_role). No new storage bucket (links only). |
| Packages | Shared `@throttle/ui` (Sidebar/Modal/Topbar/Toast/hooks) + `auth` (AuthProvider/useAuth/hasPermission) + `db` (`garageFetch` GET / `workerFetch` POST). |
| Secrets | `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ANON_KEY` (same project). |

**`docket` MUST be added to the Supabase Data API → Exposed Schemas list** (current:
`public, graphql_public, store, brand, ignition, podium` → add `docket`) or PostgREST returns
HTTP 500 `PGRST106` (PATTERN-092 / RULE-IGN-007).

RLS enabled on every new `docket` table, **service_role-only**, no anon/authenticated grants
(RULE-RLS-001). The worker is the only DB client; the public GH bundle holds no data.

## 3. People & departments (sourced from Podium)

The assignable people pool and the team/department list are **read live from Podium** — Docket
does not maintain its own roster.

- **Departments** = `podium.departments` (20 seeded). Stored on a task as `department_id`.
- **People** (owner / assignee / collaborators) = `podium.employees` (54; 44 login-linked, 10
  login-less). Stored as `*_employee_id`. Login-less staff **can be assigned** (work is tracked
  against them) but only login-linked employees can act in-app.
- **Caller → employee**: the worker maps the authenticated user to `podium.employees` via
  `auth_user_id`. This yields the caller's `employee_id` (default owner/assignee on new tasks) and
  `department_id` (drives baseline visibility). A caller with no linked employee row still sees
  tasks they created/own/are assigned/collaborate on — just no department lens.

**Coupling:** `department_id` / `*_employee_id` are real FKs to the `podium` tables (same DB,
foundational + stable). If a referenced employee/department is ever removed, the task still loads
with an "unknown" label (worker tolerates the null join) rather than erroring.

## 4. Data model (`docket` schema)

All tables: **RLS on, service_role-only**, `GRANT ALL ON docket.<table> TO service_role`.

### `docket.tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `task_no` | text UNIQUE | **`DKT-NNNN`**, atomic from `store.sequences` key `docket_task` via `docket.next_task_seq()`. **Immutable.** |
| `title` | text NOT NULL | |
| `description` | text NULL | |
| `department_id` | uuid FK → `podium.departments(id)` | the "team" |
| `owner_employee_id` | uuid FK → `podium.employees(id)` | single accountable DRI |
| `assignee_employee_id` | uuid NULL FK → `podium.employees(id)` | single person doing the work |
| `status` | text | CHECK `not_started`\|`in_progress`\|`done`\|`blocked`\|`abandoned`, default `not_started` |
| `priority` | text | CHECK `P0`\|`P1`\|`P2`\|`P3`, default `P2` (P0 immediate · P1 urgent · P2 normal · P3 low) |
| `parent_task_id` | uuid NULL FK → `docket.tasks(id)` | one-level sub-task link (see §6) |
| `created_by_user_id` | uuid | auth user. **Immutable.** |
| `created_at` | timestamptz | default `now()`. **Immutable (creation date).** |
| `deadline` | timestamptz NOT NULL | **set at creation, immutable thereafter (original commitment).** |
| `revised_deadline` | timestamptz NULL | changeable any number of times; **every change logged** (§5). |
| `completed_at` | timestamptz NULL | stamped when status → `done` |
| `abandoned_at` | timestamptz NULL | stamped when status → `abandoned` |
| `abandoned_by` | uuid NULL | auth user |
| `abandon_reason` | text NULL | required when abandoning |
| `custom_fields` | jsonb NOT NULL default `'{}'` | **extensibility hook** ("add columns later") — no UI in V1 |
| `updated_by` | uuid NULL | |
| `updated_at` | timestamptz NULL | |

**Effective deadline** = `coalesce(revised_deadline, deadline)` (used for overdue/at-risk).
Indexes: `task_no` (unique), `status`, `priority`, `department_id`, `owner_employee_id`,
`assignee_employee_id`, `parent_task_id`, `created_by_user_id`, and `(coalesce(revised_deadline,deadline))`
for the overdue scan.

### `docket.task_collaborators`
`(task_id uuid FK → tasks ON DELETE CASCADE, employee_id uuid FK → podium.employees, added_by uuid, added_at timestamptz)`, **UNIQUE(task_id, employee_id)**. Many collaborators per task.

### `docket.task_documents`
`(id uuid PK, task_id FK → tasks ON DELETE CASCADE, title text, url text NOT NULL, added_by uuid, added_at timestamptz)`. URL validated (`http(s)://`) in the worker. Multiple links per task.

### `docket.task_comments`
`(id uuid PK, task_id FK → tasks ON DELETE CASCADE, author_user_id uuid, body text NOT NULL, created_at, edited_at NULL, deleted_at NULL)`. Flat list (mirrors Throttle). Author edits/deletes own; admin deletes any. **Soft-delete** (`deleted_at`) to preserve the thread/audit.

### `docket.task_history` (append-only audit)
`(id uuid PK, task_id FK → tasks ON DELETE CASCADE, actor_user_id uuid, event_type text, field text NULL, old_value text NULL, new_value text NULL, note text NULL, created_at timestamptz default now())`.

`event_type` ∈ `created`, `status_changed`, `deadline_revised`, `owner_changed`,
`assignee_changed`, `department_changed`, `priority_changed`, `parent_changed`,
`collaborator_added`, `collaborator_removed`, `document_added`, `document_removed`,
`title_changed`, `abandoned`. Deadline revisions store `old_value`/`new_value` + the reason in
`note`. **Never updated or deleted** — the auditable record behind requirements #9 and #11.

### Sequence
`store.sequences` gets a `docket_task` row (seed 0). `docket.next_task_seq()` UPSERTs/increments
it and returns `'DKT-' || n` (mirrors `podium.next_employee_seq()` → `store.sequences`).
Unpadded integer; uniqueness, not padding, matters (same convention as EMP/GP/AST).

## 5. Deadline & status rules (the audited invariants)

- **`deadline` is required at creation and immutable.** `updateTask` strips `deadline`,
  `task_no`, `created_at`, `created_by_user_id` from any patch (PROTECTED set).
- **Revising the deadline** is a dedicated action `reviseDeadline(task_id, new_deadline, reason)` —
  reason **required** — which sets `revised_deadline` and writes a `deadline_revised` history row
  (`old_value` = prior effective deadline, `new_value` = new, `note` = reason). Repeatable; the
  dashboard counts revisions per task from these rows.
- **Status** changes via `changeStatus(task_id, status, note?)` — writes a `status_changed` history
  row, stamps `completed_at` on `done`. `abandoned` goes through `abandonTask(task_id, reason)`
  (reason required) which stamps `abandoned_*` and writes an `abandoned` history row. All five
  states are reachable in both directions by an authorised editor (re-activating an abandoned task
  is allowed and logged); there is **no delete/cancel** path anywhere.

## 6. Sub-tasks (parent ⇄ child, one level)

- A sub-task is a **full task** (own owner/assignee/status/deadline/priority/comments/docs/history)
  carrying `parent_task_id`.
- **One level only (V1):** the worker rejects (HTTP 422) setting a parent on a task that already
  has children, and setting a parent that itself has a parent.
- **Bidirectional:** parent detail lists its children with a roll-up (`done / total`); child detail
  shows a "↑ parent DKT-NNNN" link.
- **Link/unlink after creation:** `setParent(task_id, parent_task_id|null)` re-parents (or detaches)
  an existing task; logged as `parent_changed`. `createSubtask` is a convenience that creates a task
  with the parent pre-set.

## 7. Permission model (own layer in `store`)

Mirrors Podium RULE-PODIUM-006 — Docket runs its **own** permission layer, isolated from
`store.roles`, managed in-app.

- `store.docket_roles` (`role_key` UNIQUE, `label`, `description`, `permissions` jsonb,
  `is_system` bool) + `store.docket_user_roles` (`user_id` uuid PK → `role_key`, `assigned_by`,
  `assigned_at`). Both RLS-on, service_role-only.
- Permission keys (booleans in `permissions`):
  - **`docket_admin`** — role/user management + settings + see all tasks + edit/abandon/re-parent **any** task. Implies `docket_view_all`.
  - **`docket_view_all`** — org-wide task visibility + the **founder review dashboard** (`/dashboard`).
  - **Baseline (no role / empty permissions)** — create tasks; **see own + collaborator + own-department** tasks; edit / change-status / revise-deadline / abandon tasks they **own, are assigned, or created**; comment + add docs + add sub-tasks on any task they can see.
- Seeded roles: **`admin`** (`docket_admin`+`docket_view_all`, system, undeletable) · **`employee`**
  (empty = baseline default, system) · preset **`reviewer`** (`docket_view_all`, editable — for
  founders / dept heads who review but don't administer). **Bootstrap Afshaan + Vinay → `admin`**
  (resolve `user_id` from `auth.users` by `@legendoftoys.com` email).
- `normalizeDocketPerms` forces `docket_view_all:true` whenever `docket_admin` is on (footgun
  guard, mirrors Podium). System roles' permissions immutable; can't delete a system role or one
  with assigned users; empty role on assign = unassign → baseline.
- **Edit authority on a task** (worker-enforced, RULE-011 — guard first): owner, assignee, creator,
  or `docket_admin`. **Collaborators** can comment + add docs + create sub-tasks, but not change
  core fields/status/deadline. Visibility ≠ edit.

## 8. Visibility (baseline scoping)

Callers **with** `docket_view_all`/`docket_admin` see all tasks. **Baseline** callers see a task iff:
`owner_employee_id = me` **OR** `assignee_employee_id = me` **OR** `created_by_user_id = me` **OR**
caller ∈ `task_collaborators` **OR** `department_id = my department`.

Implemented via a Postgres function **`docket.list_tasks(p_user uuid, p_employee uuid, p_dept uuid,
p_view_all bool, <filter args>)`** that applies the visibility predicate + filters + sort server-side
(one subrequest — avoids PostgREST OR-across-join pain and the 50-subrequest trap). The worker passes
`p_view_all` from the resolved permissions.

## 9. Worker API (`docketops`, `05_Throttle/docketops-worker/src/index.js`)

`verifyJWT` first on every action; mutations re-check edit authority (§7). Batch multi-row work
(50-subrequest limit). Wrap numeric reads in `Number()`, integer inserts in `Math.round()`.

| Action | Type | Guard | Notes |
|---|---|---|---|
| `getMe` | GET | auth | perms + linked employee + department; always reachable post-auth |
| `getDepartments` | GET | auth | from `podium.departments` (+ optional headcount) — picker + grouping |
| `getEmployees` | GET | auth | from `podium.employees` (active) — owner/assignee/collaborator picker |
| `getTasks` | GET | auth | RPC `docket.list_tasks` — visibility + filters (`status`, `department_id`, `employee_id` for person, `priority`, `overdue`, `revised`, `parent_id`, `lens=mine`, `q`) + `group_by` (`person`\|`department`\|none); capped, ordered |
| `getTask` | GET | auth + can-see | single task + children (roll-up) + parent ref + collaborators + documents + comments (non-deleted) + full history |
| `getDashboard` | GET | `docket_view_all` | overdue/at-risk, status distribution, throughput, per-department + per-person breakdown, deadline-revision flags (aggregate RPCs) |
| `getDocketRoles` | GET | auth | role metadata (feeds assign dropdown); full list for admin |
| `getDocketUsers` | GET | `docket_admin` | users + auth emails + current docket role |
| `createTask` | POST | auth | mints `DKT-NNNN`; requires `title`,`department_id`,`owner_employee_id`,`deadline`; optional assignee/collaborators/priority/parent/docs; writes `created` history |
| `updateTask` | POST | edit-auth | core fields (title/desc/department/owner/assignee/priority); PROTECTED set stripped; per-field history |
| `changeStatus` | POST | edit-auth | status + optional note → `status_changed`; stamps `completed_at` |
| `reviseDeadline` | POST | edit-auth | `revised_deadline` + **required reason** → `deadline_revised` |
| `abandonTask` | POST | edit-auth | status→`abandoned` + **required reason** → `abandoned` |
| `setParent` | POST | edit-auth | link/unlink parent (one-level guard) → `parent_changed` |
| `createSubtask` | POST | auth | createTask with parent pre-set |
| `addCollaborator` / `removeCollaborator` | POST | edit-auth | → history |
| `addDocument` / `removeDocument` | POST | edit-auth (collab may add) | URL-validated → history |
| `addComment` / `editComment` / `deleteComment` | POST | can-see (author/admin to edit/delete) | soft-delete |
| `createDocketRole` / `updateDocketRole` / `deleteDocketRole` / `assignDocketRole` | POST | `docket_admin` | permission admin (mirrors Podium) |

## 10. Frontend routes (`apps/docket`)

Detail pages take query-string params (static export — PATTERN-074). Nav gated by perms.

- **`/`** — landing: baseline → `/tasks?lens=mine` (My Tasks); `docket_view_all` → `/dashboard`.
- **`/tasks`** — list view: **filters** (status, department, person, priority, overdue, deadline-revised, my-tasks) + **group by** person / department (expandable list later). Each row: `DKT-NNNN`, title, dept, owner/assignee, status badge, priority badge, effective deadline (overdue highlight), comment/subtask/doc counts. Visibility-scoped.
- **`/tasks/new`** — title, description, department, owner, assignee, collaborators, **deadline (required)**, priority (default P2), document links (multiple), optional parent task.
- **`/tasks/detail?id=`** — header (DKT-NNNN, title, badges, ↑parent link); fields + inline edit; **status control**; **Revise deadline** (reason modal → logged); collaborators; document links (add/remove); **Sub-tasks** (children list + roll-up + "Add sub-task"); **Comments** (flat, add/edit/delete own); **History/Audit** tab (full `task_history`, incl. every deadline revision with reason).
- **`/dashboard`** (gated `docket_view_all`) — Overdue/at-risk · Status distribution + throughput · By-department & by-person breakdown · Deadline-revision flags.
- **`/admin/roles`** + **`/admin/users`** (gated `docket_admin`) — permission matrix + per-user role assign (mirrors Podium `/admin/*`).
- **`/login`**.

Toast: `const { showToast } = useToast()` + `showToast(msg, 'success'|'error')` (NOT the
`toast(msg,'ok')` shape — the latent bug fixed across 15 pages in S91).

## 11. Branding

Name **Docket**. Logo supplied separately by Afshaan before app build (favicon + sidebar logo,
same slots as Podium: `apps/docket/public/{favicon.svg,favicon.png,apple-touch-icon.png}` + the
sidebar/login logo). Until provided, scaffold with a placeholder and swap in at build step 3.

## 12. Out of scope (V2+)

Notifications (Slack/email on assign / overdue / revision); kanban board view; arbitrary sub-task
nesting; custom-field **UI** + per-field defs table (the `custom_fields` jsonb hook ships now);
file uploads to a private bucket (V1 is links only); recurring tasks; task templates; cross-system
links to Garage/Pitstop/Throttle items; @mention notifications in comments; saved filter views.

## 13. Build sequence

1. **Migration `docket_v1`:** create `docket` schema; tables `tasks`, `task_collaborators`,
   `task_documents`, `task_comments`, `task_history` (RLS-on, service_role grants); FKs to
   `podium.departments`/`employees`; `docket.next_task_seq()` + `store.sequences` `docket_task`
   seed; `docket.list_tasks(...)` + dashboard aggregate RPCs. `store.docket_roles` +
   `store.docket_user_roles` (RLS-on) + seed `admin`/`employee`/`reviewer` + bootstrap Afshaan +
   Vinay → `admin`. **Add `docket` to Supabase Exposed Schemas.** Verify advisors clean
   (0 `rls_disabled`).
2. **`docketops` worker** (§9) — new `05_Throttle/docketops-worker/` (clone podiumops scaffold:
   wrangler.toml, verifyJWT, perm-layer loader, `sbStore`/`sbDocket`/`sbPodium` helpers).
   `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ANON_KEY`. edit → commit → push →
   `cd 05_Throttle/docketops-worker && npx wrangler deploy`.
3. **`apps/docket`** (§10) — clone podium app scaffold (auth, nav, `docketopsFetch.js`, layout),
   build pages. `npx turbo build --filter=docket` (zero errors). Branding (§11).
4. **Deploy pipeline** — `legendlot/docket` repo (gh-pages) + `.github/workflows/deploy-docket.yml`
   (clone deploy-podium.yml) + GitHub secret for `docketops` URL + DNS `docket.legendoftoys.com` +
   enable Pages + HTTPS enforce.
5. **Smoke:** create a task (DKT-0001), assign owner/assignee/collaborator, add a doc link + comment,
   create a sub-task (verify one-level guard + roll-up), revise the deadline (verify history + reason),
   change status through to done, abandon another (verify reason + no-delete), confirm baseline
   visibility vs `view_all`, confirm the founder dashboard tiles, assign a role via `/admin/users`.
