# Podium Phase 2 — Performance Capture (design spec)
> Created 2026-06-02 (Session 95). Builds on Phase 1 (`2026-06-02-podium-design.md`).
> See `systems/podium.md` for current truth. Mirrors Phase 1 conventions 1:1.

## What it is

Phase 2 of Podium: the **capture** layer that feeds the Phase 3 appraisal engine. Three
surfaces, all sharing the Phase 1 manager-chain + HR access model:

1. **Continuous observations** — managers/HR log dated, sentiment-tagged notes about people
   they manage. The anti-recency-bias engine. Visibility-tiered.
2. **Accomplishments / wins** — employees self-record wins (the brag doc); visible to their
   manager chain + HR.
3. **1:1 notes** — manager-authored per-meeting notes with a shared section, a manager-private
   section, and an action-item checklist.

No new permission keys — authorship and visibility derive entirely from the existing
`employees.manager_id` graph + `isHr`/`isAdmin`, under the `podium_view` baseline gate.

## Locked decisions (S95 brainstorm)

- **Observation authorship**: HR/admin (anyone) or an ancestor manager of the subject. Employees
  cannot observe others. Cannot observe yourself.
- **Observation visibility tiers**: `private` / `shared_with_managers` / `shared_with_employee`.
  `private` = author + HR/admins only (HR is fully all-seeing across all tiers). The subject
  **never** sees `private`.
- **Observation content**: free-text `body` + 3-way `sentiment` (positive/neutral/constructive)
  + free-form `tags[]`. No KPI link in v1.
- **Wins**: self-recorded only; always visible to self + manager chain + HR.
- **1:1s**: manager-authored. `shared_notes` + `action_items` visible to report + chain + HR;
  `private_notes` to authoring manager + HR only. Report views, does not edit (one-sided v1).
- **Edit/delete (all three)**: author edits/deletes own (edits stamp `updated_at`); HR/admin
  delete any. Hard delete.
- **UI**: profile tabs on `/people/detail` + a self-service `/me` (My Performance) page + a
  manager `/team` (Team feed) page.

## Data model — 3 new `podium` tables

All: RLS enabled, service_role-only, no anon/authenticated grants (RULE-RLS-001). `GRANT ALL …
TO service_role`. FKs to `podium.employees(id)` (uuid).

### `observations`
- `id` uuid pk default gen_random_uuid(), `created_at` timestamptz default now(), `updated_at` timestamptz
- `subject_employee_id` uuid not null → employees(id)
- `author_employee_id` uuid not null → employees(id)
- `body` text not null
- `sentiment` text not null CHECK in (`positive`,`neutral`,`constructive`)
- `tags` text[] not null default '{}'
- `visibility` text not null default `shared_with_managers` CHECK in (`private`,`shared_with_managers`,`shared_with_employee`)
- `observed_on` date not null default current_date
- `created_by` uuid (auth user id, provenance)
- Index: `(subject_employee_id, observed_on desc)`, `(author_employee_id)`.

### `accomplishments`
- `id`, `created_at`, `updated_at`
- `employee_id` uuid not null → employees(id)  (= author, self-recorded)
- `title` text not null, `description` text, `tags` text[] default '{}'
- `achieved_on` date not null default current_date
- `created_by` uuid
- Index: `(employee_id, achieved_on desc)`.

### `one_on_ones`
- `id`, `created_at`, `updated_at`
- `report_employee_id` uuid not null → employees(id)
- `manager_employee_id` uuid not null → employees(id)  (= author)
- `met_on` date not null default current_date
- `shared_notes` text, `private_notes` text
- `action_items` jsonb not null default '[]'  (array of `{ text, done }`)
- `created_by` uuid
- Index: `(report_employee_id, met_on desc)`, `(manager_employee_id)`.

## Access rules (enforced in worker; consistent with Phase 1 helpers)

New helper: `canManage(edges, subjectId, auth)` = `isHr(auth) || (me && inManagerChain(edges, subjectId, me.id) && me.id !== subjectId)` where `me = callerEmployee(edges, auth.userId)`. (For "can see / manage someone below me, or I'm HR".)

### Observations
- **Create** (`createObservation`): require `subject_employee_id`; require caller is HR/admin OR an ancestor manager of subject (`canManage`, with `me.id !== subject`). `author_employee_id` = caller's employee row (must exist → else 403 `no_employee_record`).
- **Read** (`getObservations?employee_id=`): fetch all rows for subject, then **per-row visibility filter** by viewer:
  - HR/admin → all rows.
  - viewer is the row's `author_employee_id` → see it (any tier).
  - viewer is in subject's manager chain (ancestor) → `shared_with_managers` + `shared_with_employee`.
  - viewer **is** the subject → `shared_with_employee` only.
  - else → drop.
- **Update/Delete**: author-only edit (`updateObservation` patch body/sentiment/tags/visibility/observed_on); HR/admin or author delete (`deleteObservation`).

### Accomplishments (wins)
- **Create** (`createAccomplishment`): `employee_id` = caller's own employee row (self only; ignore any client-supplied employee_id). 400 if caller has no employee record.
- **Read** (`getAccomplishments?employee_id=`): allowed only if `canSeeFull(auth, edges, employee_id)` (self + manager chain + HR) — else 403. Returns all rows.
- **Update/Delete**: author (= the employee) edits/deletes own; HR/admin delete any.

### 1:1s
- **Create** (`createOneOnOne`): require `report_employee_id`; caller must be HR/admin OR ancestor manager of report (`canManage`). `manager_employee_id` = caller's employee row.
- **Read** (`getOneOnOnes?employee_id=`): allowed if `canSeeFull(auth, edges, report)` (self/chain/HR) — else 403. Project each row: keep `private_notes` ONLY if viewer is the row's `manager_employee_id` or HR; else strip to null + flag `_private_hidden`.
- **Update/Delete**: authoring manager edits/deletes own (incl. `action_items`, notes, met_on); HR/admin delete any.

### Team feed
- `getTeamActivity`: resolve caller's employee; compute `descendants` = all employees whose chain includes caller (BFS over edges). Pull recent observations (subject ∈ descendants, visibility-filtered as above), wins (employee ∈ descendants), 1:1s (report ∈ descendants, private-stripped) — each capped (e.g. 50) and merged by date desc. HR/admin: scope to everyone (cap higher) or to a `?employee_id=` filter. Subrequest-safe: 3 list queries with `in.()` filters, no per-row awaits.

## Worker actions (podiumops) — additions

GET: `getObservations`, `getAccomplishments`, `getOneOnOnes`, `getTeamActivity`, `getMyPerformance`
(convenience: resolves caller's employee then returns own wins + shared-with-me observations +
own 1:1s + flattened open action items in one call).

POST: `createObservation`/`updateObservation`/`deleteObservation`,
`createAccomplishment`/`updateAccomplishment`/`deleteAccomplishment`,
`createOneOnOne`/`updateOneOnOne`/`deleteOneOnOne`.

Helpers: `canManage`, `descendantsOf(edges, rootEmpId)`, `filterObservationsForViewer(rows, auth, edges, subjectId)`, `projectOneOnOne(row, auth, me)`. Field-pick lists like Phase 1 (`pickFields`/`pickPatch`). All mutations register in `POST_ACTIONS`; reads in `GET_ACTIONS`; both already behind the `podium_view` gate.

## UI surfaces (apps/podium)

1. **`/people/detail` tabs** — convert the detail page to tabbed: **Profile** (existing) | **Observations** | **Wins** | **1:1s**. Each tab lazy-loads its list via the worker (visibility already enforced server-side). Action buttons shown by capability returned in the read payload: "Log observation" (if `can_add`), "Add win" (only on own profile), "Log 1:1" (if manager of this person). Inline create/edit modals; sentiment chips; tag input; visibility selector on observations; action-item checklist editor on 1:1s.
2. **`/me` — My Performance** — self-service landing: my wins (add/edit/delete), observations shared with me (read-only cards, sentiment chips), my 1:1s (shared notes + action items, read-only; check-state visible), and an "open action items" summary. Resolves caller employee via `getMyPerformance`.
3. **`/team` — Team feed** — manager view: merged recent activity across reports with type/person/date filters + a quick "Log observation" entry. Empty-state for users with no reports.

Nav (`lib/nav.js`): new **PERFORMANCE** group → `My Performance` (`/me`, no `requires`) + `Team` (`/team`, no `requires` — empty if no reports). Profile tabs need no nav change.

Lib: add `lib/performance.js` (typed fetch wrappers + sentiment/tag/action-item formatting helpers); reuse `podiumopsFetch`.

## Build sequence

1. **Migration** `podium_phase2_performance_capture` — 3 tables + indexes + RLS enable + service_role grants. Verify `podium.employees.id` type first (schema-verification rule).
2. **Worker** — helpers + 5 GET + 9 POST actions + dispatch registration. Deploy (`cd 05_Throttle/podiumops-worker && npx wrangler deploy`).
3. **App** — profile tabs, `/me`, `/team`, nav group, `lib/performance.js`. `npx turbo build --filter=podium` (zero errors), commit, push (auto-deploy).
4. **Knowledge files** — `systems/podium.md` (Phase 2 → Live, tables, actions, access matrix, new RULE-PODIUM-005 for observation visibility), `BACKLOG.md` (mark Phase 2 items done), `BUSINESS_RULES.md` (RULE-PODIUM-005). Bump dates.

## Testing / verification

- Migration verified via `information_schema` reads + an advisor check (0 new `rls_disabled_in_public`).
- Worker access logic verified by close static read of the filter/projection helpers (same method as the Phase 1 S95 audit) — CLI can't exercise JWT-gated actions.
- `/health` + `?action=ping` smoke after deploy.
- **Live browser verification remains a human task** (same as Phase 1 P1): log observations at each tier and confirm a subject sees only `shared_with_employee`, a manager sees `shared_with_managers` but not others' `private`, HR sees all, 1:1 `private_notes` hidden from the report.

## Out of scope (later phases)

Peer/360 observations; two-sided collaborative 1:1s; observation→KPI linking; cross-team
action-item dashboard; soft-delete/archive audit trail; appraisal rollup (Phase 3 consumes
these tables).
