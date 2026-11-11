# Docket plan layer — themes, milestones, results, the review rhythm (F9)

> **Status:** draft v2, 2026-11-11 — v1 reviewed by Codex against the requirements (25 findings: 5
> blockers, 20 major; all addressed below, ledger in §16). Afshaan accepted the recommendations as a set
> ("take your recommendations as is"); the founders' open calls are in §15.
> **Sources (founders-only, NOT in this repo):** Vinay's operating plan (6 Nov), "The June plan, and your
> part in it" (9 Nov), the founders' 9 Nov agreements, Afshaan's sweep (`LOT General Admin/programs/
> strategy/2026-11-11-june-plan-sweep.md`) and the LOTOps session's requirements digest (11 Nov).
> ⛔ **This spec carries the model, never the plan's content.** No theme targets, milestone titles,
> owners or numbers go in this repo — they live in the database, behind §5.
> **Greenfield rule** (decisions 2026-09-04): a fresh spec, not the dropped V2 list. It **re-opens three
> settled things by name**, each getting a superseding decisions entry in the commit that ships it:
> Slack notifications (§9; dropped 2026-08-25), templates (§11; dropped 2026-09-04) and Programs as the
> grouping axis (§7.1; RULE-DOCKET-004).

---

## 1. Why, in one paragraph

On 6 Nov, 41 of 63 open Docket tasks were overdue, 11 had closed in 30 days and seven owners hadn't
opened Docket in four months. The task rules (one owner, a locked first deadline, every change with a
reason, nothing deleted) were right; nobody looked. From 16 Nov LOT runs on Docket as **the one list**:
a four-level plan above the tasks, a daily/weekly/monthly rhythm, and EA++s and the founders' Claudes
keeping it current. Docket's own history agrees — of done tasks, 46% finished after their deadline; 29%
of all tasks were abandoned; 23% never had a deadline; 0 dependencies were ever used. The gap is
structure and review, not task features.

## 2. Principles

1. **The task engine keeps its rules** (RULE-DOCKET-001; `archived_at` = hidden since the 2026-11-11 reset).
2. **The plan is a layer above tasks**: one table for themes, milestones and results; a task points up to
   one plan item; everything else is derived.
3. **Plan items get task-grade audit**: a date locks when agreed; re-dates and splits carry a reason;
   nothing is deleted; every multi-row change is one transaction.
4. **Weeks are a view, scores are a ledger.** Week lists group tasks by the week of their deadline (no
   week objects). The on-time *score* is computed from a frozen weekly cohort (§8.2), never re-derived
   from today's fields.
5. **Confidentiality is a property of where a task lives and what a plan item is, enforced in the
   database**, not a check at one entry point (§5).
6. **One projection per audience** (§5.3): every read surface — app, search, connector, review pack,
   snapshots, Slack, exports — renders through it.
7. **Slack is the EA++'s work surface** (no email, no WhatsApp).

## 3. Requirements traceability

| Requirement | Where | Phase |
|---|---|---|
| Connector: list, create, update, move a deadline with a reason, comment (ask #1) | live 9 Nov; extended §10 | done / P0+ |
| Bulk upload from a sheet (ask #2) | **dropped** (sweep): one-time seed + connector (§10.3) | — |
| Founder-only themes at the top; teams link tasks up (16 Nov) | §4, §7.1 | **P0** |
| Weekly lists by week-ending date (16 Nov) | §6 | **P0** |
| Access: register, hiring, org stay with the founders (16 Nov) | §5 (incl. today's holes, §5.1) | **P0** |
| Milestones as their own item (#3); results a real level (obs 1) | §4.1, §4.3 | P0 storage / P1 lifecycle |
| Done-when + measured-from, flagged when unmeasurable (obs 2) | §4.4 | P1 flag / P2 auto-check |
| Lifecycle Proposed → Agreed → Done / Re-dated / Split / Dropped (obs 3) | §4.3 | P1 |
| "Should be on the list and isn't" (obs 4) + pre-re-plan risks (plan) | §4.5 | P1 |
| Three-week view (#7); every milestone due in 3 weeks has tasks (plan) | §7.2 | P1 |
| Staleness per owner/team (obs 5); team that stops updating raised next morning (plan) | §8.3, §9.2 | P1 |
| Friday review pack, one view, exportable to Slack (obs 6) | §8 | P1 |
| Weekly on-time score by team (#8; Claude computes until it exists) | §8.2, §14 runbook | P1 score / P2 trend |
| Slack reminders (#9) + capture (obs 8) | §9 | P1 |
| Hand-offs: giver, receiver, date, status; unowned ones in the pack (obs 7, obs 6) | §4.6 | P1 fields + pack / P2 Incoming UI |
| Mixed horizons (obs 9) | §6, §7.2 | P0/P1 |
| Missed checklist items in staleness + review (obs 10) | §8.3 | P1 |
| No leak of founder-only names or siblings (obs 11) | §5 | **P0** |
| Saturday founders' catch-up: cross-team asks, each founder's top 5 (rhythm) | §8.6 | P1 |
| Monthly re-plan: next month's cut + risks (rhythm) | §8.7 | P2 page / §14 runbook before |
| Tree view (#4) | §7.3 | P2 |
| Templates (#5) | §11 | P2 |
| Dependencies (#6) | **live** (F7 `blocks` links) | done |
| Recurring work on checklists, off the board | unchanged (RULE-DOCKET-008/009, F8) | done |
| #10 | "later" (sweep) — out of scope | — |

## 4. The model

### 4.1 `docket.plan_items` — one table, three kinds

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `kind` | text CHECK | `theme` \| `milestone` \| `result` |
| `code` | text unique | `T01…`; milestones keep the founders' sheet IDs `M01…`; results `Mnn.R1…`; split children `Mnna`, `Mnnb` |
| `parent_id` | uuid → plan_items | theme: null · milestone: a theme · result: a milestone (trigger-enforced) |
| `title` | text NOT NULL | |
| `owner_employee_id` | uuid → podium.employees | milestone + result: **NOT NULL**. Theme: the owning founder, or null = both |
| `department_id` | uuid → podium.departments | the owning team (milestone/result), defaults from the owner |
| `target_text` | text | the plan number the item carries |
| `done_when` | text | milestone + result: NOT NULL |
| `measure` | jsonb | §4.4 |
| `due_date` | date (IST) | milestone + result: NOT NULL. Locks at agree (§4.3). Themes: null |
| `revised_due_date` | date | only via `redate` |
| `state` | text CHECK | `proposed` \| `agreed` \| `done` \| `split` \| `dropped`; themes use `agreed` (active) / `dropped` (retired) only |
| `split_from_id` | uuid → plan_items | on a split child |
| `restricted` | bool default false | themes only; the whole subtree is founders-only (§5.2) |
| `sort` | int | order under the parent |
| audit stamps | | `created_by_user_id`, `created_at`, `updated_*`, `agreed_*`, `done_*` (+ `done_evidence`), `dropped_*` (+ `drop_reason`) |

Effective due = `coalesce(revised_due_date, due_date)`.

**`docket.plan_item_history`** — append-only (`item_id, event, old jsonb, new jsonb, note, actor_user_id,
source, at`). Events: `created`, `agreed`, `redated`, `split`, `dropped`, `done`, `reopened`,
`owner_changed`, `field_changed`, `moved`. Every event is written **in the same transaction** as the change
(all plan writes are `docket.plan_*` RPCs, never separate PATCH + history calls).

**Tasks point up:** `docket.tasks.plan_item_id uuid → plan_items`, nullable.
- A **top-level** task links to a theme (allowed at P0 while milestones are agreed), a milestone or a
  result. **Sub-tasks never carry their own link** (`CHECK (parent_task_id is null or plan_item_id is
  null)`); a sub-task's effective link is its parent's — derived, so re-parenting can't diverge it.
  `setParent` clears a child's own link, logged.
- A task may only link to an item in state `proposed` or `agreed`.
- **Unplanned** = top-level, no link. Allowed; counted in the review pack.
- The link's history event stores the **item id, never its title** (§5.3).

### 4.2 Why one table

Themes, milestones and results share owner, date, done-when, lifecycle, history, visibility and rollups;
they differ only in their parent. One table = one history, one projection, one tree query, and a template
is a plain subtree. Results are a **real level** (obs 1): a lead's commitments with a done-when, which tasks
link to.

### 4.3 Lifecycle — the transition matrix

| Action | Theme | Milestone | Result | Who |
|---|---|---|---|---|
| create | `agreed` | `proposed` (or `agreed` if a founder fills owner, date, done-when) | `agreed` — owner, due date, done-when required; parent milestone must be `agreed` | theme/milestone: founders · result: the milestone's owner or founders |
| agree | — | proposed → agreed; owner, due_date, done_when required; **due_date locks** | — | founders |
| edit (title, done_when, measure, sort, target) | ✓ | ✓ while proposed/agreed | ✓ while agreed | founders; result owner for their result's title/done_when/measure |
| change owner | ✓ | ✓ (logged) | ✓ (logged) | founders; milestone owner for results under it |
| redate (reason) | — | agreed only → `revised_due_date`; badge "Re-dated" | agreed only | founders; result: milestone owner or founders |
| split (reason) | — | agreed → `split` + N new `agreed` siblings (§4.3.1) | agreed → `split` + N siblings | founders |
| drop (reason) | agreed → dropped (only with no live children) | proposed/agreed → dropped | agreed → dropped | founders (proposed milestones: founders decline, §4.5) |
| done (evidence) | — | agreed → done | agreed → done | founders; result: its owner or founders |
| reopen (reason) | dropped → agreed | done/dropped → agreed | done/dropped → agreed | founders |

- **Generic edit can never touch** `kind`, `parent_id`, `due_date`, `revised_due_date`, `state`,
  `split_from_id` — those change only through their actions. `split` is terminal and read-only.
- **Re-dated is an event plus a badge, not a state**: the item stays agreed, so every "agreed" filter still
  finds it. All five outcomes in obs 3 remain visible.
- **A proposal's date is a draft** and moves freely; it locks at agree, mirroring a task's first deadline.
- **Results are agreed on creation** (the lead's commitment is the agreement; ≈300 results would otherwise
  queue for two people). Founders keep redate/split/drop/reopen. → Q2.
- **Done** needs an evidence note (pre-filled from the measure reading where one exists). Marking a
  milestone done with open tasks under it lists them in the confirm step; they stay linked and open.
- **Drop**: open tasks linked to the dropped item (or its results) are flagged in the review pack under
  "linked to a dropped item" until re-linked or abandoned — never silently orphaned.

#### 4.3.1 Split, transactionally

`docket.plan_split(item, children[], mapping, reason)` in one transaction:
- children are created as **siblings under the same parent** (milestone children under the theme; result
  children under the milestone), `agreed`, each with owner, date and done-when, `split_from_id` = original;
- **every** descendant is mapped: each result under a split milestone moves to one child (or is dropped
  with a reason); every **open** top-level task linked to the original or to a moved/dropped result is
  re-linked to a child or result (the mapping must cover all of them, or the call fails);
- **done and abandoned** tasks keep their link to the original (history stays where it happened);
- history on the original (`split` → child codes) and each child (`created`, `note: split from Mnn`).

### 4.4 "Done when" and "measured from"

```json
{ "system": "redline" | "garage" | "odo" | "podium" | "manual" | "…",
  "metric": "<registry name>",     // a named metric, never free SQL
  "target": "<comparison>",
  "source_ok": true | false,        // does the system record this today?
  "checked_at": "…", "last_reading": "…" }
```

- A milestone or result can be agreed with `system: "manual"` or `source_ok: false`, but it carries a ⚠
  **No data source** chip everywhere and sits in the review pack's risk list. Reference case (LOTOps
  sweep): a quality-rate milestone whose source system had logged nothing for weeks and whose other input
  was never recorded at all — found at review time; this flags it at creation.
- Metrics are a **named registry** in code (`docketops-worker/src/plan-metrics.mjs`): each entry reads one
  system and reports whether data exists for the window. P1 = registry + flag; **P2** = a daily check that
  fills `last_reading` and puts a reached target in the founders' queue to confirm done.

### 4.5 Proposals — "should be on the list and isn't"

A separate record, so a proposal never has to satisfy milestone constraints and never exposes where it
lands: **`docket.plan_proposals`** (`id, proposer_user_id, title, why NOT NULL, kind_hint milestone|risk,
suggested_theme_id?, suggested_owner_employee_id?, suggested_date?, status submitted|accepted|declined,
decision_note, decided_by, decided_at, accepted_item_id, created_at`).
- Anyone signed in proposes from Docket, Slack (`/docket propose`) or the connector. Founders' **Proposed**
  queue: accept (creates a milestone — proposed or agreed — in a theme the founder picks) or decline (a
  reason the proposer sees).
- The proposer sees **their own submission and its outcome only**: "accepted" (plus the new code/title *only
  if* the item is visible to them under §5.3) or "declined: reason". Never the theme or siblings it joined.
- "Each lead names one thing" reads off this queue (who submitted this week, §8.1); founders' pre-re-plan
  risks use `kind_hint: risk` (§8.7).

### 4.6 Hand-offs

A hand-off is **a task on the giver** (the plan's rule). New task fields:
`handoff_to_department_id` (marks the task as a hand-off), `handoff_to_employee_id` (the named receiver),
`handoff_accepted_at`, `handoff_accepted_by`. The task owner is the giver; the effective deadline is the
hand-off date; the task status is the hand-off status.
- **P1:** the fields, set from the drawer / connector / Slack; the receiver (named person or anyone in the
  receiving team) can **accept**; the review pack lists hand-offs due in the next two weeks that have **no
  named receiver or are not accepted** — that is "unowned" (the giver always owns the task; the receiving
  side is what's missing).
- **P2:** an **Incoming** section on My Tasks and the team list.
- **Receiver visibility is a General-space clause only**: a hand-off in a private space is visible to the
  receiver only if they are a member. It never overrides the membership gate.
- Task-to-task waiting stays the F7 `blocks` link.

## 5. Access (founders' 9 Nov agreement)

### 5.1 Today's holes — closed first, in P0

Codex's review found that today's Docket would not keep a founders-only space private. Verified in source:
**A1–A3 SHIPPED 2026-11-11** (throttle `d65bf607`, migration 0016; also write-by-id gating and sub-task moves) — A4 (move-out of the Founders' space) and A5–A6 remain for P0-a.

| # | Hole | Fix (P0-a) |
|---|---|---|
| A1 | `list_tasks_by_program` and `programs_for_user` let `p_view_all` skip the private-space membership check — a Docket admin can list and count private-space tasks through a program. `list_my_tasks` widens the same way for one's own tasks. | Every cross-space RPC: **private-space rows require membership, always**; `p_view_all` widens only inside General (the shape `search_tasks` already has). |
| A2 | `requireSpaceOwner` lets any Docket admin rename, archive and **add members to** any private space, and `recoverSpace` can take ownership without the space being orphaned — contradicting RULE-DOCKET-003 ("the gate beats admin"). | Admin member/rename/archive paths removed; `recoverSpace` only when the owner is inactive or exited, audited, and **never for a founders-only space** (§5.2). |
| A3 | `setParent` checks neither that the caller can see the parent nor that both tasks share a space — a baseline user can attach their task under any private task id and read its title back. | Require `canSeeTask(parent)` and `parent.space_id = child.space_id`; a sub-task's space and plan link always follow the parent. |
| A4 | `moveTask` / `bulkMoveTasks` check the destination space only. | Require access to the source space too; moving **out of** a founders-only space requires `docket_plan_admin`. |
| A5 | `assignDocketRole` / role edits are gated by `docket_admin`, which five accounts hold. | Roles carrying `docket_plan_admin` can be created, edited or assigned **only by a plan admin**; a non-plan-admin cannot change a plan admin's role. |
| A6 | Docket `admin` (sees every General task) is held by Afshaan, Vinay, **Mohit, Shashwat and "Jarvis"**. The agreement: Mohit and each lead see only their own. | **Answered (Q4):** Mohit and Shashwat keep admin; founders get super admin (`docket_plan_admin`), which alone opens the register. |

### 5.2 Permissions and rules

- **`docket_plan_admin`** — new key, the two founders only; not implied by `docket_admin`. Grants every
  plan action, the register, `target_text`, the Proposed queue, every review pack, membership of the
  Founders' space.
- **`docket_review`** — new key for the Founders' Associates (§5.3 level R). → Q7.
- **Founders' space** — a private space with `is_founders = true`, created at P0. Only plan admins (and
  members a plan admin adds) can be members; admin recovery never applies to it. It holds hiring, org and
  any other founders-only work.
- **Confidentiality is enforced by database triggers on every path**, not at link time:
  - on `tasks` insert/update of `space_id`, `plan_item_id` or `parent_task_id`: a task whose effective plan
    link is inside a **restricted** subtree must be in the Founders' space (`restricted_needs_founders_space`);
  - on `plan_items` update of `restricted` or `parent_id`: refuse if it would leave linked tasks outside the
    Founders' space (the error lists them);
  - a task already in the Founders' space stays founders-only **whether or not it is linked** — so an
    unlinked hiring task is still private. Leaving the space needs a plan admin (A4).
- **What "own" means** (requirement E): *milestones* — strictly the ones you own, plus the results under
  them; *tasks* — the existing baseline (own, created, collaborator, own department), which team check-ins
  need. Nobody outside the founders gets an org-wide task view (A6). If the founders mean "own tasks only",
  that is a one-line change to the baseline → Q8.

### 5.3 One projection per audience

`docket.plan_project(p_viewer…) returns table(item_id, level)` decides the level for every item; one
worker function `projectPlanItem(item, level)` renders it. Nothing returns a plan row without both.

| Level | Who | Sees |
|---|---|---|
| **F** | plan admins | everything |
| **R** | Founders' Associates (`docket_review`) | every **unrestricted** milestone and result: code, title, owner, dates, state, done-when, chips — **never `target_text`, never a restricted subtree** |
| **O** | the item's owner (and the milestone owner for its results) | the full item including done-when, measure and its own history — but not the theme's `target_text` |
| **T** | anyone, for an unrestricted theme | theme code + title only |
| **L** | a viewer who can see a task linked to an item at no higher level | **"Another owner's milestone"** + the theme title — no code, title, owner, date or siblings (→ Q3 to loosen to code + title) |
| **none** | anything in a restricted subtree, for non-founders | nothing — not even that it exists |

Rules every surface follows:
- **Lists of linked tasks are intersected with task visibility.** Seeing a milestone never reveals tasks in
  spaces you're not in. Rollup counts for level F include everything and say "+N in spaces you're not in";
  for other levels they count only tasks the viewer can see.
- **History and hydration** store and return ids for plan references, rendered through the projection at
  read time. Free text (descriptions, comments, revision reasons) can't be redacted, which is why
  confidential work must *live* in the Founders' space rather than be filtered out of General (§5.2).
- **Snapshots** (§8.5) store the full payload; every read re-projects it for the viewer's *current* level.
- **Exports and Slack** render at the **destination's** level: a DM renders at the recipient's level; a
  channel post renders at the lowest level of anyone in the channel (P1: team packs go only to a team's own
  channel at level O/T, the full pack only by DM to founders and Associates).
- **The org dashboard gets no plan-derived data.** The score trend lives on `/review`, behind the same
  levels; restricted-subtree and Founders'-space tasks never enter team aggregates seen below level F.
- **Search, the connector and templates** use the same projection (§10, §11).

Tests (P0, in `docketops-worker/test/plan-access.test.mjs` against the SQL functions + worker): a lead's
task under another owner's milestone shows level L; a lead never receives a sibling, a `target_text`, or any
row of a restricted subtree from any endpoint or connector tool; A1–A5 regressions; a task can't leave the
Founders' space without a plan admin; a restricted re-parent is refused.

## 6. Weeks (P0)

- **Week** = the half-open IST interval [S 00:00, E+1 00:00) where E is the week-ending date. A task's week
  is the week containing the IST date of its effective deadline timestamp.
- The week's last day is `docket.settings.week_end_dow`, **default Sunday** → Q1. Each score snapshot stores
  the `week_end_dow` and scoring version it used, so changing the setting never re-reads old weeks.
- **P0:** the **List** view gains **Group by: Week ending** and a **Week** filter (`This week`, `Next week`,
  `Week ending <date>`, `Overdue`, `No date`). Grid and Board follow in P1.
- **Mixed horizons:** milestone-only months simply have no tasks; the three-week view shows milestones per
  week (P1) so a milestone-only week isn't empty; the monthly re-plan cuts the next month by creating its
  tasks (§8.7).

## 7. Views

### 7.1 The plan on every task (P0)

- The **task drawer** (create + edit) and the **connector** gain a **Plan** field: search themes/milestones/
  results visible to the person, shown as a chain ("<theme> › Mnn › R2"). Quick capture, Grid cells and Board
  cards follow in P1.
- List rows show the link as a chip; filters by theme / milestone / result / **Unplanned**.
- Sidebar: a **Plan** section at the top (founders: the register; everyone else: "My milestones"), above Spaces.
- **Programs retire in P1, not P0** (RULE-DOCKET-004 is superseded by name then): the sidebar section and
  program capture go, `programs` stays (archived tasks reference it), the connector stops offering program
  filters. At P0 they keep working, with A1 fixed.

### 7.2 Three-week view (P1)

`/plan/weeks` — a **rolling** window: **Overdue · this week · next week · the week after** (week-ending
dates from §6). Rows: team (default), person or theme. Each cell lists the milestones and tasks due that week.
Warnings, each with the person who resolves it:
- **No actionable tasks** — an agreed milestone (or result) due in the window with no open, owned, dated
  top-level task linked to it or its results. Resolver: the item's owner.
- **Not agreed yet** — a proposed milestone due in the window. Resolver: the founders.
- **Theme-only links** — tasks linked straight to a theme whose milestones are now agreed. Resolver: the task
  owner (a one-click "link to a milestone" list).
- **Stale** — a task in the window with no qualifying update (§8.3) for 3+ working days.
A founder's default is all teams; a lead's is their own team.

### 7.3 Tree view (P2)

`/plan/tree` — theme → milestone → result → task, collapsible; each node with owner, effective date, state/⚠
chips, open/done/overdue counts and on-time % for its subtree; all through §5.3.

## 8. The rhythm

### 8.1 The review pack (P1)

`/review?week=<week-ending>` — the Friday 15-minute review, ready Thursday evening. Levels F and R see every
team; a lead sees their own team. Per team:

1. **This week, provisional** — committed so far vs done on time, and what's still due before week end
   (§8.2 separates provisional from final).
2. **Last week, final** — the closed score, with the trend of the last 4 weeks.
3. **Slipped** — each committed task not done on time: owner, committed deadline → current deadline, every
   revision reason, times moved.
4. **Milestones** — due this week (done/not), re-dated this week (reason), ⚠ no data source, ⚠ no actionable
   tasks, linked to a dropped item.
5. **Hand-offs** — due in the next two weeks with no named receiver or not accepted; overdue hand-offs.
6. **Staleness** — §8.3.
7. **Next two weeks** — tasks and milestones due, by person.
8. **Proposals** — who submitted a missing item this week; what's waiting for the founders.
9. **Unplanned work** — share of the team's committed tasks with no plan link.

### 8.2 The on-time score — a frozen cohort

**`docket.week_commitments`** (`week_end, task_id, committed_deadline timestamptz, department_id,
owner_employee_id, entered_at, entry_reason`) is the cohort, written by the database, not reconstructed:
- **At week start** (S 00:00 IST, by the cron of §9.1): every top-level, non-recurring, open, non-archived
  task whose effective deadline falls in the week is inserted with its deadline, team and owner **as of
  that moment**.
- **Mid-week entry**, by trigger: a task enters the week's cohort when its *first* deadline is set inside
  the week (a new task, or an old undated task first committed) — `entry_reason: first_commitment`.
  **Re-dating into the week does not enter a task** (a slip from another week is that week's miss), and
  re-dating out of the week does not remove it.
- Team, owner and parentage are frozen at entry, so a later re-parent or department move never rewrites a
  score.
- **Deadline changes are made transactional first (P0):** `reviseDeadline` and first-deadline-set become one
  RPC that writes the task and its `task_history` row together (today they are two calls and a failed history
  insert is ignored). So the cohort and the history agree from 16 Nov.

**Final score**, computed once at week close (E+1 00:00 IST) and stored in `docket.review_snapshots`:
- **On time** = at close, the task is `done` **and** `completed_at ≤ committed_deadline` (the exact
  timestamp — the same rule task views use to show overdue, so the score and the screen never disagree).
- **Miss** = everything else in the cohort: open, re-dated, done late, **abandoned mid-week** (a dropped
  commitment is a miss), or done-then-reopened and not re-done by close.
- A task created already done inside the week is on time (the transactional first-deadline RPC records both).
- Score = on time ÷ cohort, per team and per person.

**Provisional** (the Friday view): the same cohort, read live, showing only deadlines already passed plus
"still due before week end" — never frozen. The Friday **held** button stores the provisional view for the
minutes, labelled provisional; the final score is stored separately at close.

Until the page ships, the **same SQL function** (`docket.week_score(p_week_end)`) is what the founders'
Claude calls for each Friday review (§14); weeks from 16 Nov are exact because the cohort and the
transactional deadlines start at P0.

### 8.3 Staleness and the next-morning escalation (P1)

- **Qualifying update** = a `task_history` row (any event) or a comment on the task. Views don't count.
  `task_history` gains a `source` (`app` | `connector` | `slack` | `system`), so an update made by a
  Claude or the EA++ counts (the point is a current list) but is shown as such.
- **Presence** (`user_activity.last_seen_at`, stamped on every authenticated call) is shown **separately**;
  it is never evidence of list maintenance.
- Per person and per team: last seen · last own update (their history rows or comments on tasks they own) ·
  **touched %** (open committed tasks with a qualifying update this week) · missed checklist items this week
  (from the F8 register's adherence).
- **Working days** = `docket.settings.working_days`, default Mon–Sat; holidays from
  `docket.settings.holidays` (dates).
- **Escalation:** a team with **no qualifying update on any of its open tasks during the last working day**
  is raised at **09:30 IST the next working day** — a DM to both Founders' Associates (owner of the
  follow-up) and a line in the founders' morning DM. It stays on the review pack until the team updates.

### 8.4 Export

**Copy for Slack** (mrkdwn: one message per team plus a summary) and, with §9, **Post**. Rendered at the
destination's level (§5.3).

### 8.5 Snapshots

`docket.review_snapshots (week_end, kind provisional|final, department_id, payload jsonb, scoring_version,
week_end_dow, cutoff_at, created_at, created_by)`. Payloads are full; reads re-project for the viewer. The
weekly on-time score by team (#8) is the series of `final` snapshots — a chart on `/review` (P2).

### 8.6 Saturday founders' catch-up (P1)

`/review/founders?week=` (level F only): **cross-team asks** — open hand-offs between teams and tasks blocked
by another team's task (F7 links) due this or next week; and **each founder's top 5** —
`docket.founder_focus (week_end, founder_user_id, rank 1–5, plan_item_id | task_id, note)`, set by each
founder (or their Claude) for the week. Rendered as one Slack-ready message.

### 8.7 Monthly re-plan (P2; runbook before)

`/plan/replan?month=` (level F): next month's milestones with readiness — agreed? owner? data source? actionable
tasks for its first two weeks? — plus the **risks** submitted as `kind_hint: risk` proposals since the last
re-plan, and the month's final scores. "Cutting the next month" = creating that month's tasks (by leads and
the Claudes), which the readiness list then shows. The 27 Nov and 24 Dec re-plans run on the runbook (§14).

## 9. Slack (P1) — re-opens the 2026-08-25 "no notifications" decision

### 9.1 Plumbing
- A **dedicated "Docket" Slack app** (not the Throttle app, whose webhooks carry other alerts): bot scopes
  `chat:write`, `im:write`, `users:read`, `users:read.email`, `commands`; interactivity (shortcuts, buttons,
  modals) pointed at docketops. Afshaan creates and installs it; `reference/integrations.md` records it.
  Secrets `SLACK_DOCKET_BOT_TOKEN`, `SLACK_DOCKET_SIGNING_SECRET`.
- **Identity:** `docket.slack_identities (employee_id PK, slack_user_id unique, resolved_at)`, filled by
  `users.lookupByEmail` on the work email. A Slack action is accepted only from a mapped user, after
  verifying Slack's signature (5-minute replay window), and runs **as that person** with their Docket
  permissions (`source: slack`).
- **docketops gains a cron trigger** (it has none, by the old decision): week start/close (§8.2) and §9.2.

### 9.2 Reminders (IST; times and recipients in `docket.settings`) → Q5

| When | To | What |
|---|---|---|
| Working days 09:00 | each owner (DM) | due today, overdue, own tasks with no qualifying update in 3 working days — buttons **Done / Move date / Comment** |
| Working days 09:30 | Founders' Associates (DM); one line to founders | the chase list (due in the next 2 working days, not updated in 3); teams raised under §8.3 |
| Thursday 17:00 | each owner (DM) | "Review tomorrow": their committed-this-week not done |
| Thursday 18:00 | founders + Associates (DM) | the ready review pack |
| Friday 18:00 | founders (DM) | Saturday catch-up prep (§8.6) |

No per-event alerts (assign, comment, each change) — the noise the old decision rejected. Every message renders
through §5.3 at the recipient's level.

### 9.3 Capture and update from Slack
- **Message shortcut "Add to Docket"** → modal: title (pre-filled from the message; permalink saved as a link
  attachment), owner, deadline, plan link, hand-off receiver. The EA++'s same-day path from a meeting action or
  a Slack promise to a task.
- **`/docket`** — `add <text>` (the quick-add parser for dates and people), `mine`, `propose <text>`.
- Buttons: **Done**, **Move date** (modal; reason required), **Comment**, **Accept hand-off** — each the same
  docketops action the app calls.
- Claude in Slack with the Docket connector would also work for founders without a build, but needs the org
  connector setting Mohit is blocked on; nothing here depends on it.

## 10. Connector (mcpgateway)

Today it acts **as the person**, single-item writes only, every write audited
(`mcpgateway-worker/src/tools/docket.js`). The additions keep all three rules and render through §5.3.

- **Reads — `docket_plan`** reports: `themes`, `items` (kind/theme/state/owner/due window), `item` (one, with
  children and *visible* linked tasks), `tree`, `proposed` (F), `review` (§8 for a week, at the caller's level),
  `score` (§8.2), `founders` (§8.6, F).
- **Writes:** `docket_create_task` / `docket_update_task` gain `plan_item_id` (P0) and hand-off fields (P1);
  `docket_propose` (anyone, P1); `docket_plan_item` (one action per call — create/edit/agree/redate/split/drop/
  done/reopen — per §4.3's matrix, P1); `docket_add_result` (P1); `docket_founder_focus` (F, P1).
- No bulk tools (ask #2 stays dropped).
- **Loading the plan (§10.3):** the 10 themes and 82 milestones are loaded **once** by this lane from the
  founders' sheet by SQL (snapshot first; every milestone `proposed`; sheet codes kept; owners matched to
  `podium.employees` with an unmatched-name report back to Afshaan before anything loads), not by 92
  confirm-each connector calls.

## 11. Templates (P2) — re-opens the 2026-09-04 drop

`docket.plan_templates (id, name, description, audience founders|leads, created_by)` + `plan_template_nodes
(template_id, parent_node_id, kind milestone|result|task, title, role_label, offset_days, done_when, sort)`.
- **Visibility:** `founders` templates are level F only; `leads` templates are visible to anyone with an
  agreed milestone or result they own. Previews show only node titles.
- **Two kinds of apply:** a **founders** template creates milestones (`proposed`) + results + tasks under a
  theme the founder picks; a **leads** template creates results + tasks under a milestone the lead owns.
  Pick an anchor date and map each role label to a person → dates = anchor + offset.
- **Every generated node runs the normal creation path** (§4.3 matrix, the confidentiality triggers, first
  deadlines lock as usual) in one transaction; nothing bypasses a check because it came from a template.
- Four seeds — launch, US shipment, month-end close, new joiner — written by the owning leads, not this spec.

## 12. Releases (re-cut 2026-11-11 — no due dates)

Afshaan, 2026-11-11: *"I don't care about the due dates … build continuously, as fast as possible, test it to
the limit, then release. Progressive releases."* The 16 Nov / 30 Nov / December phases are dropped; the work
ships as a sequence of releases, each tested hard and released on its own. **Docket is not populated by
this build** — themes and milestones are entered by the founders, item by item, in the container R1 ships.

| Release | Ships |
|---|---|
| **R1 — the container** ✅ SHIPPED 2026-11-11 (`44444e8e`) | Super admin (`docket_plan_admin`, Afshaan + Vinay) + role-grant guard (A5) · `plan_items` + `plan_item_history`, all writes via transactional RPCs · create/edit themes, milestones, results; agree / redate / drop / done / reopen (§4.3 minus split) · `/plan` register (super admins: everything; others: "My milestones" + results under them) · projection levels F / O / T (§5.3) · `restricted` themes invisible below F |
| **R2 — tasks link up** ✅ SHIPPED 2026-11-11 (`ead8c9df`) | `tasks.plan_item_id` + Plan field (drawer, quick capture, Grid, Board) + chips + filters + Unplanned · level L redaction in hydration/search/connector · Founders' space + confidentiality triggers + A4 · connector `docket_plan` read + `plan_item_id` |
| **R3 — lifecycle depth** ✅ SHIPPED 2026-11-12 (`227507a5`) | split (§4.3.1) · done-when/measure + ⚠ no data source · proposals + queue (§4.5) |
| **R4 — weeks** ✅ SHIPPED 2026-11-12 (`1468205e`) | week-ending group-by + Week filter (all views) · three-week view + warnings (§7.2) |
| R5 — the score | transactional deadline RPC · `week_commitments` cohort · `week_score()` · connector `score` |
| R6 — review | review pack (provisional/final) + staleness + export + snapshots · Saturday founders' page · level R (Associates) |
| R7 — Slack | Docket Slack app, identities, cron, reminders, shortcut, `/docket`, buttons |
| R8 — hand-offs | fields + accept + pack section + Incoming |
| R9 — | tree view · templates · measure auto-check · score trend · re-plan page · Programs retired |

Order can change release to release; each is hostile-reviewed and smoked live before the next starts.

## 13. Out of scope

Time tracking, sprints/points, docs and whiteboards, custom fields, an automation builder, bulk import (ask
#2), per-event notifications, editing the founders' sheet from Docket, #10.

## 14. Runbook until the views exist

| Date | Ritual | How it runs |
|---|---|---|
| Thu 19 Nov | review prep | the founders' Claude calls `docket_plan report=score` for the week ending 22 Nov (provisional) and drafts the pack from `docket_tasks` + `docket_plan items` (due in 3 weeks, no tasks), posting it to both founders by DM |
| Fri 20 Nov | first Friday review | that draft; actions captured as tasks the same day (connector) |
| Sat 21 Nov | founders' catch-up | each founder's Claude lists cross-team blocked tasks + their top 5 in a DM |
| Thu 26 / Fri 27 Nov | review + monthly re-plan | as 19–20 Nov, plus December's milestones with owner/date/actionable-task readiness and risks gathered in chat → proposals once P1 lands |
| from 30 Nov | — | the P1 pages and Slack replace the runbook; 24 Dec re-plan uses the runbook unless the P2 page is in by 20 Dec |

## 15. Open questions (founders)

- **Q1 — Week ends on which day?** Default Sunday (Mon–Sun). Friday's review then reads a provisional week
  with two days left; Friday-ending weeks would close before the review.
- **Q2 — Do results need founder agreement?** Default no: agreed when the lead commits; founders keep
  redate/split/drop.
- **Q3 — May a teammate see the code + title of a milestone they don't own when they can see a task under
  it?** Default no ("Another owner's milestone").
- **Q4 — ANSWERED 2026-11-11 (Afshaan):** Mohit and Shashwat **keep Docket admin** (General task visibility);
  Afshaan and Vinay are **super admins** (`docket_plan_admin` on top of admin) — only they see the whole
  register and targets. "Jarvis" is Afshaan's agent principal; losing access is fine, handled separately.
- **Q5 — Reminder times, recipients, and which Slack channels team packs post to** (§9.2 defaults).
- **Q6 — Theme targets visible to anyone below the founders?** Default no.
- **Q7 — Do the Founders' Associates see the whole unrestricted register (level R) to run the reviews?**
  Default yes, never targets or restricted themes.
- **Q8 — "Only their own tasks" — strictly own, or own + team (today's baseline)?** Default own + team,
  because the daily team check-in needs the team's list.

## 16. Codex review ledger (v1 → v2)

| # | Finding (severity) | Resolution |
|---|---|---|
| 1 | Cross-space RPCs bypass private spaces via `p_view_all` (blocker) | §5.1 A1, P0-a — verified in source |
| 2 | Admin can add self to / recover any private space; role grants (blocker) | §5.1 A2, A5; Founders' space excluded from recovery — verified in source |
| 3 | `setParent` leaks private parent titles (blocker) | §5.1 A3 — verified in source |
| 4 | Link-time enforcement doesn't hold on moves/unlinks (blocker) | §5.2 triggers + Founders' space by location, §5.1 A4 |
| 5 | "Only their own" not implemented; Mohit's admin (blocker) | §5.2 definition, A6 + Q4 before 16 Nov, Q8 |
| 6 | Visible-id set can't express field policy | §5.3 levels + one projection |
| 7 | Plan access must not grant linked private tasks | §5.3 intersection; §4.6 General-only receiver clause |
| 8 | History/free text leaks after unlinking | ids in history, render-time projection; confidential work lives in the Founders' space |
| 9 | Packs/snapshots/Slack audiences | levels F/R/O; snapshots re-projected; destination-level rendering |
| 10 | Dashboard sharing as a disclosure surface | no plan data on the org dashboard; trend on `/review` |
| 11 | Templates have no access model | §11 audience, two apply modes, normal creation path |
| 12 | Week-start deadline not reliably reconstructible | §8.2 frozen cohort + transactional deadline RPC at P0 |
| 13 | Denominator holes and mutable membership | §8.2 entry rules, frozen team/owner/parentage, abandoned = miss |
| 14 | `completed_at` and reopened work | §8.2 evaluated at close: done at close and on time |
| 15 | IST dates vs timestamped deadlines | §6 half-open IST weeks; §8.2 exact timestamp, same as task views |
| 16 | Friday freezes unfinished weeks; setting changes | §8.2 provisional vs final; snapshots carry period/version/dow |
| 17 | Split ignores results and descendants | §4.3.1 transactional split over the full subtree, siblings |
| 18 | Lifecycle permissions incomplete | §4.3 matrix; protected fields; theme states |
| 19 | Proposal flow contradicts constraints | §4.5 separate `plan_proposals` + safe outcome |
| 20 | Sub-task inheritance semantics | §4.1 derived link, CHECK, setParent clears |
| 21 | Three-week warning too weak | §7.2 actionable tasks, not-agreed, theme-only, resolvers, rolling window |
| 22 | Staleness/escalation undefined | §8.3 qualifying update + source, presence separate, working days, owner, time |
| 23 | Unowned hand-offs missing in P1 | §4.6 fields + accept + pack section in P1; Incoming UI P2 |
| 24 | No bridge for 20/27 Nov, Saturday, re-plan | §8.6, §8.7, §14 runbook |
| 25 | P0 not bounded; fallback dropped access | §12 P0-a/P0-b split, Programs + polish moved to P1, access never cut |
