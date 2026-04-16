# Throttle — Technical Build Document
**Version:** 5.0 | **Last Updated:** April 2026 (Phase 5)
**Purpose:** Technical reference for the Throttle brand team work OS.
Feed this file when continuing development in a new session.

> **Note:** This file now lives inside the repo at `05_Throttle/THROTTLE_BUILD.md`.
> It syncs automatically across laptops via git. Always `git pull` before starting a session.
> Home laptop path: `/Users/afshaansiddiqui/Documents/00_Claude/05_Throttle/THROTTLE_BUILD.md`
> Office laptop path: `/Users/afshaansiddiqui/Documents/Claude/05_Throttle/THROTTLE_BUILD.md`

---

## 1. Stack

| Layer | Technology | Details |
|---|---|---|
| Database | Supabase (Postgres) | `jkxcnjabmrkteanzoofj.supabase.co` — same project as LOT. `brand` schema. |
| API | Cloudflare Worker | `throttleops.afshaan.workers.dev` — separate worker from lotopsproxy |
| Frontend | Next.js 14 static export | `throttle.legendoftoys.com` — GitHub Pages, repo `legendlot/throttle` |
| Auth | Supabase Auth — Google OAuth | @legendoftoys.com domain-restricted. Trigger auto-creates brand.users on sign-in. |
| Drag & Drop | @dnd-kit/core | Kanban board |
| Table | TanStack Table v8 | Task table view |
| Calendar | FullCalendar React | Installed, not yet used — sprint timeline uses custom 7-col grid |
| State | Zustand | Client-side state |
| Notifications | Slack Incoming Webhooks | Two channels: #throttle-ops (admin) + #throttle-team (personal) |
| CI/CD | GitHub Actions | Push to main → build → deploy to gh-pages |

---

## 2. Local Folder Structure

```
05_Throttle/                          ← repo root (legendlot/throttle)
├── THROTTLE_BUILD.md                 ← THIS FILE — now in repo, syncs across laptops
├── worker/
│   ├── src/index.js                  ← all Worker handlers
│   ├── wrangler.toml                 ← includes cron trigger
│   └── package.json
└── app/
    ├── src/
    │   ├── app/
    │   │   ├── page.js               ← redirects to /requests/ after auth
    │   │   ├── layout.js
    │   │   ├── login/page.js
    │   │   ├── auth/callback/page.js
    │   │   ├── requests/page.js
    │   │   ├── requests/new/page.js
    │   │   ├── requests/approval/page.js
    │   │   ├── board/page.js
    │   │   ├── sprints/page.js
    │   │   ├── dashboard/page.js     ← stub, Phase 6
    │   │   └── settings/page.js
    │   ├── components/
    │   │   ├── Layout.js             ← role-aware nav shell
    │   │   ├── TaskSidePanel.js      ← stage/priority/assignees/submit-for-review/approval
    │   │   ├── ProductSelector.js
    │   │   └── RequestStatusBadge.js
    │   └── lib/
    │       ├── supabase.js
    │       ├── worker.js
    │       ├── auth.js
    │       ├── requestTypes.js       ← 8 types × template field config
    │       ├── taskConfig.js         ← stages, priorities, transitions, deliverable types
    │       └── sprintUtils.js        ← date helpers for sprint management
    ├── .github/workflows/deploy.yml
    ├── next.config.js                ← output: 'export'
    └── .env.local                    ← NOT committed — recreate manually on each machine
```

---

## 3. Supabase — brand schema

Same Supabase project as LOT. All Throttle tables in `brand` schema.
Worker uses `Accept-Profile: brand` / `Content-Profile: brand` headers.

### Tables (all created manually — Phase 1)
- `brand.users` — role defaults to requester on first Google sign-in
- `brand.requests` — intake submissions
- `brand.request_products` — links requests to public.product_master.product_code
- `brand.sprints` — weekly Thu–Wed, enforced by DB CHECK constraints
- `brand.tasks` — core work unit with deliverable_type for reporting
- `brand.task_assignees` — many-to-many
- `brand.task_attachments` — files and links (currently URL-only, no direct file upload)
- `brand.approvals` — work review decisions (approved/rejected + feedback)
- `brand.activity_log` — immutable ledger, INSERT via Worker only

### Security definer function
`brand.get_my_role()` — reads caller's role as postgres, bypasses RLS recursion.
**All RLS policies that check role must use this function. Never subquery brand.users in a policy.**

### Product reference
Reads from `public.product_master` (LOT table, same Supabase project).
Columns used: `product_code`, `product`, `sku`, `is_active`.

### RLS
Enabled on all brand tables.
Worker uses service_role key — bypasses RLS (trusted server-side writes).
Client uses anon key — RLS enforces all reads.

---

## 4. Auth Flow

1. User hits throttle.legendoftoys.com → redirected to /login if no session
2. Clicks "Sign in with Google"
3. Supabase OAuth → Google → /auth/callback/
4. Trigger `on_auth_user_created` → creates brand.users row (role: requester)
5. Admin promotes role via Settings UI
6. JWT on all requests. Worker validates JWT on every call.
7. `hd: 'legendoftoys.com'` restricts to @legendoftoys.com accounts only

**Note:** If user already existed in auth.users (e.g. linked Google to existing email account),
the trigger doesn't fire. Manually INSERT into brand.users with correct role.

---

## 5. Worker Pattern

```
POST https://throttleops.afshaan.workers.dev/?action=<actionName>
Authorization: Bearer <supabase_jwt>
Content-Type: application/json
{ ...body }
```

All actions: validate JWT → get brand.users role → role guard → execute → return JSON.
Errors: `{ error: "message" }` with appropriate HTTP status.

### Implemented actions (Phase 5)
- `getMe` — returns calling user's brand.users record (service role, RLS bypass)
- `updateUserRole` — admin only
- `updateUserProfile` — any user (own name/slack_id)
- `submitRequest` — any authenticated user
- `approveRequest` / `rejectRequest` / `requestMoreInfo` — admin/lead
- `updateTaskStage` — member (own tasks, limited transitions) or admin/lead (all)
- `updateTaskPriority` — admin/lead
- `assignTask` — admin/lead
- `abandonTask` — admin/lead
- `flagExtBlocked` — assignee or admin/lead
- `createSprint` — admin/lead
- `closeSprint` — admin/lead
- `addTaskToSprint` — admin/lead
- `removeTaskFromSprint` — admin/lead
- `submitForReview` — assignee or admin/lead (attachment URL required)
- `approveWork` — admin/lead (creates approval record, moves to done)
- `rejectWork` — admin/lead (feedback required, moves back to in_progress)

### Worker secrets (set via wrangler secret put — never in files)
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_ANON_KEY
- SLACK_WEBHOOK_OPS — #throttle-ops channel
- SLACK_WEBHOOK_TEAM — #throttle-team channel

---

## 6. Environment Reference

> ⚠️ Do not commit secrets to git.

- **Supabase URL:** `https://jkxcnjabmrkteanzoofj.supabase.co`
- **Supabase anon key:** `sb_publishable_1Dd-r3h9Mou2Wqgn6t24Dw_lmWdBtLh`
- **Worker URL:** `https://throttleops.afshaan.workers.dev`
- **Frontend:** `https://throttle.legendoftoys.com`
- **GitHub repo:** `legendlot/throttle`
- **Office laptop path:** `/Users/afshaansiddiqui/Documents/Claude/05_Throttle/`
- **Home laptop path:** `/Users/afshaansiddiqui/Documents/00_Claude/05_Throttle/`

### .env.local (recreate on each machine — not in git)
```
NEXT_PUBLIC_SUPABASE_URL=https://jkxcnjabmrkteanzoofj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_1Dd-r3h9Mou2Wqgn6t24Dw_lmWdBtLh
NEXT_PUBLIC_WORKER_URL=https://throttleops.afshaan.workers.dev
```

---

## 7. Technical Decisions Log

| Decision | Choice | Reason |
|---|---|---|
| Separate Cloudflare Worker | `throttleops` not extending `lotopsproxy` | LOT peaks 35k req/day on free tier (100k/day). Separate worker = independent budget. No LOT risk. Different deploy cadence. |
| Next.js static export | `output: 'export'` | GitHub Pages deployment. No SSR needed — all routes behind auth. Same hosting pattern as LOT. |
| brand schema | Separate from public + store | Isolates Throttle from LOT tables. Same Supabase project, zero extra cost. |
| Product registry | Read from public.product_master | No double-entry. product_code as FK. New LOT products immediately available in intake. ProductSelector hardcodes 25 active car products (Apr 2026) to avoid cross-schema client query. |
| RLS enabled | Full policies per table | Multi-user web app. Proper row-level security required. Worker uses service_role for writes. |
| `brand.get_my_role()` security definer | All role-check policies use this function | Prevents infinite recursion — any RLS policy on brand.users that subqueries brand.users loops forever. Function runs as postgres (bypasses RLS), reads role once, returns it. |
| Google OAuth domain restriction | `hd: 'legendoftoys.com'` | Internal tool. Admin assigns role after first sign-in. |
| Sprint DB constraints | CHECK (DOW=4 start, DOW=3 end, end-start=6) | Enforced at DB level. Cannot create sprint with wrong dates even via direct SQL. |
| No Vercel | GitHub Pages + GitHub Actions | Free. Consistent with LOT. Static export makes it possible. |
| brand schema exposed in Supabase | Added `brand` to Data API exposed schemas list | Without this all PostgREST calls fail with PGRST106 "Invalid schema: brand". Same requirement as LOT's store schema. Setting: Integrations → Data API → Settings. |
| `brand.users` trigger + existing auth.users | `on_auth_user_created` fires on INSERT only | If a user's auth.users row already existed (prior email login), Google OAuth links to that row without firing the trigger. Fix: manually INSERT into brand.users. |
| `getMe` Worker action | Fetches brand.users via service role | Client-side direct query to brand.users was blocked by RLS (406). Worker bypasses RLS with service_role — clean pattern for all user-identity lookups. |
| RLS recursion fix (Phase 2) | `brand.get_my_role()` security definer function | admin/lead policies on brand.users originally used `EXISTS (SELECT 1 FROM brand.users...)` subquery — causes infinite recursion. Fixed across all tables in Phase 2 post-fix. |
| Drag and drop | HTML5 native drag API | No dnd-kit used on kanban — native API sufficient. @dnd-kit installed but used only for sprint board drag. Fewer deps. |
| Stage transitions | Validated in Worker (source of truth) AND `canMoveTask` client-side | Client blocks invalid drags UX-only. Worker is the real enforcement. |
| Drag to ext_blocked / abandoned | Opens side panel instead of inline drop | Both stages require `blocked_reason`. Drop event has no text-capture UI. Board detects target stage and pre-opens side panel. |
| Optimistic stage moves | Board updates card immediately, reverts on Worker error | Drag-to-stage is latency-sensitive. Revert on catch. Side-panel moves are not optimistic (panel IS the confirmation UI). |
| Settings: load team on demand | Users list fetched on button click, not on mount | Admin-only page, low frequency. Avoids loading all user rows on every navigation. |
| Worker `logActivity` helper | Single helper, try/catch isolated | Audit failures don't break the task operation. Errors surface in wrangler tail only. |
| Sprint auto-close via Cloudflare Cron | `[triggers] crons = ["29 18 * * 3"]` in wrangler.toml | Wed 18:29 UTC = Wed 23:59 IST. No separate scheduler. Single weekly run closes sprint, flags spillovers, creates next sprint. |
| `[triggers]` not `[[triggers]]` | Single TOML table | `[[triggers]]` creates `triggers[0].crons` — wrong. Cloudflare expects `[triggers]` with `crons = [...]`. Cron silently unregistered under doubled form. |
| Sprint close guard | Abort if >1 active sprint | Prevents health score + spillover corruption. If guard fires: manual fix required. |
| Spillover rollover: batch via IN filter | PATCH in slices of 40 | Respects Cloudflare 50-subrequest limit. Typical sprint < 30 tasks = 1 call. |
| Per-task spillover_count increment | Individual PATCH per task | PostgREST has no bulk increment without RPC. Acceptable at current scale. |
| Auto next-sprint creation at close | `closeSprintById` creates next sprint in same run | Closes Thursday gap. Spillovers arrive already `stage = in_sprint` in new sprint. |
| Due date at sprint-add time | Drag-to-sprint opens due-date modal | Populates timeline view. Optional — can skip. |
| Sprint timeline visualization | 7-column flex grid | Simple for 7-day window. FullCalendar deferred to later phase. |
| First sprint creation is manual | `runSprintClose` only fires if active sprint exists | Bootstrap: admin clicks "+ Create Sprint" once. Cron handles all subsequent handoffs. |
| Slack two-channel pattern | SLACK_WEBHOOK_OPS + SLACK_WEBHOOK_TEAM | Ops: admin/management events (new requests, approvals, blockers, sprint summary). Team: personal events (assignment, work approved/rejected). Reduces noise for team members. |
| submitForReview attachment | URL link required — no direct file upload | Files hosted in Drive/Figma/etc. Direct upload to Supabase Storage deferred. |
| Work approval flow | in_review → done (approve) or in_review → in_progress (reject with feedback) | Both create an approvals record + log activity. Rejection requires feedback. |
| Review indicator on board | Cyan badge shows in_review count | Admin/lead only. Disappears when queue is empty. |
| getNextThursday fix | `day < 4` condition (was `day <= 4`) | Old code included Wednesday in the "before Thursday" branch, returning next day (Thursday) correctly — but when day=3 (Wed), `4-3=1` added to today gave tomorrow. Actually the bug was `day <= 4` caused Sunday (0), Monday (1), Tuesday (2), Wednesday (3), **Thursday (4)** to all use the formula — Thursday got `4-4=0` added, returning today. Fixed: explicit `if (day === 4) return d` for Thursday, then formula for all other days. |
| THROTTLE_BUILD.md moved into repo | Now at `05_Throttle/THROTTLE_BUILD.md` | Was at `Documents/Claude/THROTTLE_BUILD.md` (office) only — not in git, not on home laptop. Moving into repo ensures it syncs automatically with the codebase. |

---

## 8. Build Status

### Phase 1 — Foundation ✅
- [x] Local folder structure created
- [x] GitHub repo legendlot/throttle created and pushed
- [x] Worker scaffolded and deployed (throttleops.afshaan.workers.dev)
- [x] Worker health check confirmed
- [x] Supabase brand schema created (manual — all tables, enums, RLS, triggers)
- [x] Next.js app scaffolded with static export
- [x] supabase.js, worker.js, auth.js created
- [x] Login page, auth callback, home page (auth-gated) created
- [x] GitHub Actions pipeline created and first deploy succeeded
- [x] GitHub Pages enabled (gh-pages branch, manual activation)
- [x] Google OAuth enabled in Supabase dashboard
- [x] `brand` schema added to Supabase Data API exposed schemas
- [x] First real sign-in tested and brand.users row confirmed
- [x] Afshaan promoted to admin role
- [x] CNAME throttle.legendoftoys.com added in GoDaddy ✅

### Phase 2 — Intake ✅
- [x] Pre-task bridge: rename `useAuth().user` → `brandUser`; `workerFetch` accepts session-or-token; `sbFetch` honors `options.prefer`
- [x] `Layout` component — role-aware top nav, auth gate, sign-out
- [x] `RequestStatusBadge`, `ProductSelector` (25 products), `requestTypes.js` (8 types × template fields)
- [x] `/requests/` list view with 5 status filters
- [x] `/requests/new/` type selector → dynamic template form → product scoping → success screen
- [x] `/requests/approval/` admin/lead queue with approve / reject / info-needed
- [x] Worker: submitRequest, approveRequest, rejectRequest, requestMoreInfo
- [x] RLS recursion fix: `brand.get_my_role()` security definer function applied across all tables

### Phase 3 — Board + Task Operations ✅
- [x] `taskConfig.js` — stages, priorities, transitions, deliverable types
- [x] Worker: updateTaskStage, updateTaskPriority, assignTask, abandonTask, flagExtBlocked, updateUserRole, logActivity helper
- [x] `TaskSidePanel` — stage moves, priority, assignees, abandon
- [x] `/board/` — 7 kanban columns, drag-and-drop with optimistic UI, table view toggle
- [x] `/settings/` — team role/discipline management

### Phase 4 — Sprints + Auto-close Cron ✅
- [x] `sprintUtils.js` — 8 date helpers
- [x] Worker: createSprint, closeSprint, addTaskToSprint, removeTaskFromSprint, closeSprintById, runSprintClose cron
- [x] Cloudflare Cron Trigger: `29 18 * * 3` (Wed 23:59 IST)
- [x] `/sprints/` — timeline, split sprint/backlog, drag-and-drop, search, due-date modal

### Phase 5 — Work Approval + Slack Notifications ✅
- [x] Slack two-channel setup: SLACK_WEBHOOK_OPS + SLACK_WEBHOOK_TEAM (SLACK_WEBHOOK_URL deleted)
- [x] `slackOps()`, `slackTeam()`, `slackBoth()` helpers replace old `slackNotify()`
- [x] All console.log('[Slack]...') placeholders replaced with real channel calls
- [x] Worker: submitForReview, approveWork, rejectWork implemented
- [x] TaskSidePanel: Submit for Review section (assignees), Work Approval section (admin/lead), Attachments section
- [x] Board: review queue indicator (cyan badge, admin/lead only)
- [x] getNextThursday bug fixed
- [x] THROTTLE_BUILD.md moved into repo (this file)

### Pending
- Phase 6: Manager dashboard + deliverables reporting table
- Phase 7: Polish + QA + full role testing

---

## 9. Manual Steps Completed (reference)

- **DNS CNAME** — GoDaddy: `throttle` → `legendlot.github.io` ✅
- **Supabase Data API exposed schemas** — added `brand` alongside `public, graphql_public, store` ✅
- **Google OAuth** — LOTsignin project, Supabase Auth → Providers → Google ✅
- **GitHub Pages** — gh-pages branch, manual activation ✅
- **First admin promotion:**
  ```sql
  INSERT INTO brand.users (id, name, email, role)
  VALUES ('107ea993-f5ed-4221-ba97-b08e38dcd00c', 'Afshaan Siddiqui', 'afshaan@legendoftoys.com', 'admin');
  ```
- **RLS recursion fix SQL** — run manually in Supabase SQL editor (Phase 2 post-build) ✅

---

## 10. Open Questions

1. ~~Slack workspace webhook URL~~ ✅ Done — Phase 5
2. Team member Slack IDs — needed for DM notifications (future phase). Store in brand.users.slack_id via Settings UI.
3. ProductSelector list will need refresh if new products are added to LOT, or swap to a dynamic fetch from public.product_master.
4. `increment_spillover_count` RPC — if any sprint regularly has 20+ spillovers, the per-task PATCH loop will approach the 50-subrequest cap. Add `brand.increment_spillover_count(task_ids uuid[])` RPC.
5. Closed-sprint history + health view — health_score JSONB written on close, no UI yet. Phase 6 dashboard.
6. File uploads — only URL links supported for deliverables. Supabase Storage bucket for direct file upload deferred.
7. Slack DMs per user — current notifications go to channels. Future: use brand.users.slack_id for direct DMs to specific assignees.
8. FullCalendar — installed but unused. Sprint timeline uses custom 7-col grid. Upgrade to FullCalendar when month/quarter range views are needed.
9. getNextThursday fix — confirmed correct: explicit Thursday check + formula for all other days. Sunday (0) → +4, Monday (1) → +3, Tuesday (2) → +2, Wednesday (3) → +1, Thursday (4) → today, Friday (5) → +6, Saturday (6) → +5.

---

*Update at end of every build session.*
