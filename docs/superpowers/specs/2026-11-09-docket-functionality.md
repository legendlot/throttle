# Docket — functionality pass (spec, 2026-11-09)

> Follows the ClickUp UI redesign (P0–P8 live, `2026-11-09-docket-clickup-redesign.md`). That spec was
> UI-only; this one changes what Docket *does*. Nothing here is built until Afshaan picks (§5).

## 1. What the data says (live, 2026-11-09, non-recurring, non-archived tasks)

| Signal | Number | Reading |
|---|---|---|
| Tasks created per month | Jun 625 · Jul 178 · Aug 232 · Sep 66 · Oct 68 | Launch spike, then a steady ~67/month |
| Distinct creators per month | Jun 32 · Jul 16 · Aug 16 · Sep 5 · Oct 8 | Use has narrowed to a core of ~8 people |
| Active users (last seen) | 9 in 7 days · 14 in 30 days · 53 ever | Same |
| Open tasks | 313 | |
| — overdue | 172 (55%) · 152 of them by more than 30 days | The overdue list is mostly old |
| — no deadline (sitting in The Grid) | 143 (46%) | Capture doesn't set a deadline |
| — no owner | 30 | |
| — untouched for 60+ days | 184 | |
| Median creation → done | 1.3 days | What does get closed closes fast |
| Comments | 176 ever · **1 in the last 30 days** | Discussion happens elsewhere (Slack) |
| Sub-tasks | 296 | Used |
| Programs | 4, on 14 tasks | Barely used |
| Custom fields · checklist templates | 0 · 0 | Unused |
| Last 30 days of history events | status 74 · created 48 · owner 43 · deadline set 39 · revised 7 · abandoned 5 | People set owners and deadlines *after* capture, by hand |

Two problems, then. **Tasks are captured incomplete** (no deadline, no owner), and **open work goes stale and
never gets closed out**. Docket's live list is mostly history nobody cleared. The 1.3-day median shows that
when a task is live, people move it.

## 2. Settled calls this spec respects (reference/decisions.md)

- **S309:** no overdue, assignment or deadline-revision notifications, and no weekly Slack digest. Afshaan
  declined these with the overdue numbers in front of him. ⛔ Not re-raised here. Everything below is
  *pull*: inside the app, and only when someone opens it.
- **S288:** checklist adoption is not pursued. The template layer stays dormant. No checklist work here.
- **S343:** the six-item "V2" list is dropped (arbitrary nesting, custom-field UI, file uploads, templates,
  cross-system links, saved views). None of it is proposed. Afshaan can reopen one by name.
- **RULE-DOCKET-001:** the original deadline can't be changed, only revised with a reason. Kept.

## 3. Proposed packages (each ships and deploys on its own)

### F1 — Correctness fixes (recommended, must-do · ~½ session · worker + one RPC)
Found during the redesign and confirmed in `docketops-worker/src/index.js`:
- `createTaskCore` ignores `status` and always writes `not_started`. Adding a task under a status group
  therefore does create + updateTask, which writes two history rows and two requests. Fix: accept `status`
  (not `abandoned`), log a single `created` row.
- Single-task `updateTask` and `reviseDeadline` don't refuse **abandoned** tasks. The bulk paths do, and the UI
  is already read-only. Fix: return 422 `abandoned_read_only` server-side.
- `list_my_tasks`: the owner/collaborator branches don't filter `archived_at`. Verify live, then fix in a
  migration.
- Comment add/edit on an abandoned task: decide with the line above (§5 G3).

### F2 — Capture that lands complete (recommended · 1 session · frontend only)
The worker already accepts `deadline`, `owner_employee_id`, `priority`, `department_id` and `collaborators` on create.
Today's capture row just doesn't send them.
- The "+ Task" capture row grows inline **Owner · Deadline · Priority** chips (Tab between them; Enter saves).
  It defaults owner to *me* on My tasks and to the group's value inside a group.
- **Quick-add tokens** in the title, parsed client-side and shown as chips before saving:
  `@riya` → owner, `!p1` → priority, `today` / `tomorrow` / `fri` / `12 nov` / `5pm` → deadline. Unmatched
  text stays in the title. This is a ClickUp pattern and costs nothing on the server.
- Target: the 46% no-deadline share should fall for tasks created after it ships (measure in 30 days).

### F3 — Triage The Grid (recommended · 1 session · frontend only)
The Grid holds 143 tasks with no owner or deadline. Add a **Triage** button on The Grid header: one task at a
time in the task view, with three keys: **set owner + deadline** (then the next task), **Abandon** (with
reason), or **Skip**. It shows a progress count. It reuses TaskView and the existing writes, with no new endpoint.

### F4 — Stale-work sweep (recommended · 1 session · frontend + maybe one RPC)
A pull-only cleanup screen, so it stays within S309: *My tasks → "Clean up"* lists my open tasks that are
overdue by 30+ days or untouched for 60+. Each row has **Done** / **Revise** (new date and reason) / **Abandon**
(reason), and there are bulk versions through the existing BulkBar. The same view filtered by owner appears
for anyone with `docket_view_all`, so a manager can run it in a review meeting. It sends nothing and nags no one.
It turns "152 tasks overdue by 30+ days" into a ten-minute job.

### F5 — Cross-space search (recommended · 1 session · worker + RPC)
⌘K only finds tasks in the space you've loaded, and there are 58 spaces. Add worker GET `searchTasks(q)`,
backed by an RPC over every space the caller can see. It uses `list_tasks` visibility, matches title and
`DKT-` number with trigram/ILIKE, returns at most 20, and wires into CommandBar's task group.

### F6 — Task moves (optional · 1 session · worker)
**Move to another space** (the target space must be accessible; sub-tasks move with the parent), **Duplicate**
(title, description, team, priority, collaborators; no history or deadline), and **Make sub-task of… /
Promote to task** (still one level only). There's no usage signal for these beyond convenience; build only if
the team asks.

## 4. Deliberately not proposed

| Idea | Why not |
|---|---|
| Notifications, digests, @mention alerts | S309 — declined |
| Comment threads, reactions, @mentions | 1 comment in 30 days. The conversation is in Slack. Polishing comments won't move it |
| Saved views, custom fields, deeper nesting, templates, uploads | S343 — dropped (reopen by name) |
| Checklist improvements | S288 |
| Time tracking, Gantt, calendar view | No signal in the data. Tasks close in a median 1.3 days |
| Dependencies ("blocked by") | `blocked` status is used on 6 tasks |

**Being honest about the ceiling:** creators fell from 32 to about 8 a month. F2 through F4 make the list
cheaper to keep accurate, but none of them brings people back. Whether the wider team uses Docket is set by
whoever runs reviews from it. F4's manager view exists to make that review cheap.

## 5. Decisions for Afshaan

- **G1 — which packages?** Recommended: F1 + F2 + F3 + F4 + F5, in that order. F6 only on request.
- **G2 — quick-add tokens (F2):** parse `@name`, `!p1` and dates out of the title? Recommended: yes.
- **G3 — what locks:** abandoned tasks become read-only server-side (F1). Should comments on abandoned
  tasks also be refused? Recommended: yes, matching the read-only view. Done tasks stay editable (reopening is common).
- **G4 — stale thresholds (F4):** overdue by 30+ days, or untouched for 60+? Recommended: yes, as stated.

## 6. Size
F1 ½ · F2 1 · F3 1 · F4 1 · F5 1 · F6 1, about 4½ sessions for the recommended set. Each package gets a
hostile review before its commit, a deploy, and a live smoke. F1 and F5 need a worker deploy and F5 a migration.
