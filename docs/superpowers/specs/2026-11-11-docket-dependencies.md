# Docket — task dependencies (F7), modelled on ClickUp

> 2026-11-11 · Status: **✅ SETTLED 2026-11-11 — all §6 recommendations accepted ("Yes, build it"); building** · Reverses one line of
> `2026-11-09-docket-functionality.md` §4 ("Dependencies — not proposed, `blocked` used on 6 tasks"):
> Afshaan asked for it ahead of moving the team onto Docket "in a big way".

## 1. How ClickUp does it (read 2026-11-11, help.clickup.com)

| ClickUp behaviour | Detail |
|---|---|
| **Two dependency types** | *Blocks* (this task prevents another from being completed) and *Waiting on / Blocked by* (another task must be completed first). One link, seen from both ends. |
| **Plus plain links** | *Relate a task* — a link with no ordering meaning. Lives in the same "Related" section. |
| **Where you add one** | Task view → Related section → **+** → "This task blocks" / "This task is blocked by" → search or create a task. Also the task's **⋯ → Relationships** menu, and a **+** on hover over an existing dependency. Slash commands `/blocking` `/waiting` `/link to`. Automations. Gantt: drag a connector between bars. |
| **Where it shows** | In the task, a dependencies strip **above the description**. In List / Board / Calendar, a **dependency icon next to the task name**; clicking it (or right-click → Dependencies) opens a modal to add/remove. Optional **Dependencies column** in List view. Gantt draws arrows. |
| **When is a blocker "cleared"** | When it is in a **Done** status. Links stay visible after both tasks close. |
| **Closing a waiting task** | **Dependency Warning** ClickApp (admin toggle, per Space): a *warning* when you close a task still waiting on another. It does **not** stop you. |
| **Rescheduling** | **Reschedule Dependencies** ClickApp (separate toggle): moving a blocker's start/due shifts every waiting task's start+due by the same days. Needs a blocker due date and a waiting-task start date. Bulk edits bypass it. |
| **Notifications** | On link added, unlinked, and when a task becomes unblocked. |
| **Scope** | Across Lists/Spaces in the Workspace. Anyone with edit permission. Duplicating a task copies its dependencies; templates keep only internal ones. Not on mobile. |

## 2. What Docket has today

- A **`blocked` status** (5th status). Manual, says nothing about *what* it's blocked on. After the 11 Nov cleanup, 0–1 tasks use it.
- **Sub-tasks**, one level (`parent_task_id`). A grouping, not an order.
- **No start date** — only `deadline` + audited `revised_deadline` (RULE-DOCKET-001: every revision needs a reason).
- **No Gantt, no notifications** (S309 declined), no automations, no templates, no duplication (F6 unbuilt).
- **⌘K cross-space search** (F5, `docket.search_tasks`) with the exact visibility gate — the picker comes for free.

## 3. What we build — ClickUp's model, Docket's constraints

### 3.1 Concepts (copy ClickUp)
- **Waiting on** / **Blocking** — one directed link, shown from both ends.
- **Related** — an undirected link with no rules. (Decision G1: ship it in v1 or not.)
- A blocker is **cleared** when it is `done`. An **abandoned** blocker is also cleared, but labelled "Blocker abandoned" (G2).
- A task is **Waiting** while it has ≥1 uncleared blocker. Derived, never stored. **The `blocked` status stays a separate, manual choice**, exactly as ClickUp keeps status and dependency apart; we do not auto-set it.

### 3.2 Data — migration `0013_task_links.sql`
```
docket.task_links
  id uuid pk, kind text check (kind in ('blocks','relates')),
  from_task_id uuid → tasks on delete cascade,   -- 'blocks': from BLOCKS to
  to_task_id   uuid → tasks on delete cascade,   -- 'relates': stored least/greatest
  created_by_user_id uuid, created_at timestamptz default now()
  unique (kind, from_task_id, to_task_id), check (from_task_id <> to_task_id)
```
- RPC **`docket.add_task_link(p_kind, p_from, p_to, p_user)`**: refuses self-links, recurring (Checklist) tasks, and **cycles** (a recursive CTE refuses `A blocks B` if B already reaches A through `blocks` links). Takes an advisory lock so two concurrent adds can't form a loop between them. Writes a `task_history` row on **both** tasks (`link_added`).
- RPC **`docket.links_for_tasks(p_ids uuid[], …visibility args)`** → per task: `waiting_open`, `waiting_total`, `blocking_open`, and the visible other-side rows. One call feeds `hydrateTasks`, so list/board/my-tasks get counts with no per-row loop.
- service_role only, like every docket RPC; `GRANT` written explicitly.

### 3.3 Worker (`docketops-worker`)
- `getTask` adds `waiting_on[]`, `blocking[]`, `related[]` (task_no, title, status, owner, effective deadline, space name).
- `hydrateTasks` adds `waiting_open`, `blocking_open` to every row.
- New `addTaskLink` / `removeTaskLink`:
  - **Add**: you must be able to edit this task (`canEditTask`) AND see the other one (same gate as search).
  - **Remove**: edit rights on either end. Logged on both.
- `changeStatus` → `done` on a Waiting task returns **409 `waiting_on`** with the open blockers unless `force: true`. The same applies to the board drag and to `bulkUpdateTasks` (one combined count). That is ClickUp's Dependency Warning, as a warning (G3).
- When a task goes `done` or `abandoned`, every task it was blocking whose LAST open blocker that was gets a history row: "Unblocked — DKT-123 done". This replaces ClickUp's unblock notification, because S309 declined notifications.
- Abandoned tasks stay read-only (F1/G3): no links can be added or removed on them; existing links stay visible.

### 3.4 Screens
- **Task view** — a **Dependencies** strip above the description, as in ClickUp:
  - Two groups, *Waiting on* and *Blocking*. Each row shows status dot, DKT no, title, owner, due, and an ✕ to unlink.
  - **+ Add** asks "This task is waiting on… / This task blocks… / Related to…" and then opens the ⌘K-style search picker, which reuses `search_tasks`.
  - Also reachable from the **⋯ → Relationships** menu and from ⌘K ("Add dependency").
- **List row and board card** — an icon next to the title, as in ClickUp:
  - Red "waiting" icon with a count when the task is Waiting.
  - Neutral "blocking" icon with a count when it blocks open tasks.
  - Hover lists the tasks; click opens the same add/remove popover.
  - A grey (cleared) icon when every blocker is done.
- **Filters** — *Waiting on others* and *Blocking others* on the task list and My Tasks. ClickUp's dependency filter only checks whether a link exists; ours checks whether the blocker is still open.
- **Date clash hint** (Docket-specific) — amber text on a waiting task whose blocker is due *after* it: "DKT-123 is due 30 Nov, after this task (25 Nov)". This stands in for ClickUp's auto-reschedule (see §4).
- **Can't-see rule** — a linked task in a space you can't open shows as "1 task you can't see". No title, number or owner leaks. This is the same rule as F5's parent crumb.

### 3.5 Manual + tests
- Manual 1.6.0: task-detail and task-list chapters.
- Unit tests: client-side only (`apps/docket/src/lib/deps.test.mjs`). docketops-worker has no test harness. The cycle check, visibility masking, 409/force and unblock history were verified in a rolled-back DB transaction and in the live smoke, not by a suite.
- Hostile review before commit.

## 4. Deliberately not copied

| ClickUp feature | Why not (now) |
|---|---|
| **Reschedule Dependencies** (auto-shift dates) | Docket has no start date, and every deadline change needs a *reason* (RULE-DOCKET-001). A silent cascade would write revisions nobody explained. Instead: the date-clash hint. Later customisation: a "Shift N waiting tasks too?" option inside Revise deadline, using the same reason for all (G4). |
| Gantt arrows / drag connectors | No Gantt in Docket (functionality spec §4: no signal). |
| Notifications on link/unblock | S309 — declined. History rows instead. |
| Slash commands, Automations, Dependencies column | No such systems in Docket. The icon and the popover cover it. |
| Copy deps on duplicate/template | No duplication (F6) or templates (S343). Add only if F6 is built. |
| MCP gateway tools | Read-only `waiting_on`/`blocking` in `docket_tasks` is a small follow-up once this lands. |

## 5. Size
One package, about one session including review, deploy and manual:
- migration 0013;
- 3 worker handlers plus the `changeStatus`/bulk guard;
- `DependenciesPanel`, the row/card icon and popover, the warning dialog and 2 filters;
- tests and manual 1.6.0.

Nothing existing changes shape. Tasks with no links render exactly as today.

## 6. Decisions — ✅ all recommendations accepted 2026-11-11

- **G1 — Related links in v1?** Recommended **yes**. It comes almost free with the same table and picker, and ClickUp users expect it.
- **G2 — Does an abandoned blocker clear the wait?** Recommended **yes**, labelled "Blocker abandoned" so the waiting owner knows the work wasn't actually done.
- **G3 — Closing a waiting task:** **warn + "Mark done anyway"** (recommended, = ClickUp), or a hard block. ClickUp makes it an admin toggle. Recommended: always warn for now, no toggle until someone asks.
- **G4 — Rescheduling:** recommended **hint only in v1**. The "shift waiting tasks too" option inside Revise deadline is a v1.1 customisation if the team wants it.
- **G5 — Cross-space links?** Recommended **yes** (ClickUp allows them across the workspace). The can't-see rule covers privacy.

Sources: ClickUp Help — *Intro to Dependency Relationships*, *Create Dependency Relationships in tasks*,
*Create Dependency Relationships in views*, *Dependency Warnings*, *Rescheduling dependencies*, *Create
relationships on tasks* (help.clickup.com, read 2026-11-11).

## 7. API contract (build reference)

**Link item** (a task on the other end, visible to the caller):
`{ link_id, kind: 'blocks'|'relates', id, task_no, title, status, owner_name, due, space_name, cleared }`
— `due` = effective deadline (revised ?? deadline) or null; `cleared` = status is done or abandoned.

**`links` object**:
`{ waiting_on: [item], blocking: [item], related: [item], hidden: { waiting_on, blocking, related }, hidden_links: [{ link_id, direction }], waiting_open, blocking_open }`
— `hidden_links` = ids only, so the editable end can still remove a link to a task it can no longer open.
— `hidden.*` = links whose other task the caller can't open (rendered "N task(s) you can't see", never a number/title);
`waiting_open` / `blocking_open` count open (not done/abandoned) other ends INCLUDING hidden ones.

| Call | Shape |
|---|---|
| `getTask` | adds `links` (object above) |
| GET `getTaskLinks?id=` | `links` only — same gate as getTask (for the row/card popover) |
| every list row (`getTasks`, `getMyTasks`, `getProgramTasks`, `getStaleTasks` via hydrateTasks) | adds `waiting_open`, `waiting_total`, `blocking_open`, `related_count` (ints, hidden included) |
| list filter param | `deps=waiting` (waiting_open>0) · `deps=blocking` (blocking_open>0) on getTasks / getMyTasks / getProgramTasks |
| POST `addTaskLink` `{ id, other_id, kind: 'waiting_on'\|'blocks'\|'relates' }` | → `{ link_id }`. Refusals: 404 `not_found` · 403 `forbidden` (can't edit `id`) · 403 `forbidden_other` (can't open `other_id`) · 422 `self_link` · `cycle` · `already_linked` · `recurring_task` · `archived_task` · `abandoned_read_only` (this task) · `other_abandoned` |
| POST `removeTaskLink` `{ link_id }` | → `{ removed: true }`. Needs edit rights on a non-abandoned end; 404 `not_found`, 403 `forbidden` |
| POST `changeStatus` `{ id, status: 'done', force? }` | a task with `waiting_open > 0` and no `force: true` → **409** `{ ok:false, error:'waiting_on', blockers:[{ task_no, title, status }], hidden_open }` |
| POST `bulkUpdateTasks` `{ field:'status', value:'done', force? }` | any target waiting and no `force` → **409** `{ ok:false, error:'waiting_on', waiting_count, waiting_ids }` |

**History events** (task_history, shown in the task's history panel): `link_added` / `link_removed`
(`field: 'dependency'`, `note`: `waiting on` | `blocks` | `related to`, value = the other task rendered by the
worker as `DKT-n · title` or `a task you can't see`), and `unblocked` on a waiting task when its last open
blocker becomes done/abandoned (value = the blocker, rendered the same way).
