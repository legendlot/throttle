# Podium Phase 4 — OKR Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Podium's OKR module — objectives with key results cascading company → department →
individual, ad-hoc check-ins, auto-progress + manual final grade, surfaced read-only on the
appraisal detail. New `podium` tables + podiumops actions + `apps/podium` pages. No new
permission key.

**Architecture:** Migration `podium_okr_engine_v1` creates 4 tables (`okr_cycles`, `objectives`,
`key_results`, `okr_checkins`) + a scoring helper. podiumops adds GET reads (visibility-filtered)
+ POST writers (authorship-gated per level), reusing the existing `isHr`/`canManage`/
`callerEmployee`/`SELF_SERVE_*` machinery. apps/podium adds a PERFORMANCE nav item + `/okrs`,
`/okrs/cycle`, `/okrs/detail`, a `/me` OKR block, and a `/team` surface. The appraisal detail
read gains a read-only `okrs` array.

**Tech Stack:** Supabase Postgres (`podium` schema), Cloudflare Worker (podiumops), Next.js static
export (apps/podium), Recharts 2.12 (already a dep).

**Spec:** `docs/superpowers/specs/2026-07-10-podium-okr-engine-design.md`

**Ground truth verified 2026-07-10 (live DB):**
- `podium.appraisal_cycles.appraisal_date` (date) — the anchor to mirror; `status` text.
- `podium.departments`: `id`, `head_employee_id` (uuid), `parent_department_id`, `active`.
- `podium.employees`: `id`, `auth_user_id` (nullable), `full_name`, `department_id`, `manager_id`
  (self-FK), `status` (text; `'exited'` sentinel), `date_exited`. `canManage`/`descendantsOf`
  already walk `manager_id`.
- `podium.settings` is a singleton (id smallint) with jsonb config cols — no OKR settings added in
  v1 (staleness threshold hardcoded 14d).
- podiumops helpers to reuse (confirm exact names in `05_Throttle/podiumops-worker/src/index.js`
  before wiring): `sb()` (targets `podium` via `Accept-Profile`/`Content-Profile`), `sbStore()`,
  `isHr(auth)`, `canComp`, `canSeeFull`, `canManage(auth,id)`, `descendantsOf`, `inManagerChain`,
  `callerEmployee(auth)`, `SELF_SERVE_GET`/`SELF_SERVE_POST` sets, GET requires `podium_view`
  unless self-serve.
- apps/podium: `lib/podiumopsFetch.js`, `lib/nav.js` (PERFORMANCE group), `lib/appraisals.js`
  (anchor-date helpers to mirror), `components/ui.js` atoms, `components/PerformancePanels.js`
  (the `/me` + `/team` self-fetching-panel precedent), Recharts already in `package.json`.

**Conventions (monorepo CLAUDE.md):** PostgREST numerics come back as strings → `Number()` before
math, `Math.round()` integer inserts. Every new `podium`/`store` table needs `GRANT ALL … TO
service_role`. RLS on at creation (RULE-RLS-001). Commit + push after each confirmed change;
podiumops deploy = `cd 05_Throttle/podiumops-worker && npx wrangler deploy`; apps auto-deploy on
push. Never touch `wrangler.toml`.

---

### Task 1: Migration `podium_okr_engine_v1` — tables + scoring helper

**Files:** none in-repo — applied via Supabase MCP `apply_migration` (name `podium_okr_engine_v1`),
like every prior Podium migration. Additive DDL → auto-runs, no sql-gate prompt.

- [ ] **Step 1: verify no name collision** — `SELECT table_name FROM information_schema.tables
  WHERE table_schema='podium' AND table_name IN ('okr_cycles','objectives','key_results',
  'okr_checkins');` (expect 0 rows).
- [ ] **Step 2: apply the migration.** Create the four tables per the spec's data model, with:
  - PK `id uuid DEFAULT gen_random_uuid()`; the FKs + ON DELETE actions from the spec.
  - CHECK constraints: `okr_cycles.status`, `objectives.level`/`status`/`final_confidence`,
    `key_results.metric_type`/`direction`/`status`, `okr_checkins.confidence`.
  - `objectives.final_score numeric(3,2)`; `okr_checkins.checked_in_on` default
    `(now() AT TIME ZONE 'Asia/Kolkata')::date`.
  - Indexes: `objectives(cycle_id, level)`, `(owner_employee_id)`, `(department_id)`,
    `(parent_objective_id)`; `key_results(objective_id)`; `okr_checkins(key_result_id, created_at desc)`.
  - `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on all four; **no** anon/authenticated policies;
    `GRANT ALL ON podium.{table} TO service_role` on each.
  - **Scoring helper** `podium.f_okr_kr_score(metric_type text, start_v numeric, target_v numeric,
    current_v numeric, direction text) RETURNS numeric` (IMMUTABLE) implementing the clamp math
    (increase/decrease/milestone, div-by-zero → 0). Used by the read RPC in Task 2.
- [ ] **Step 3: verify** — re-run the `information_schema.columns` check for the 4 tables; confirm
  `f_okr_kr_score` exists and spot-check: `SELECT podium.f_okr_kr_score('number',0,100,25,'increase')`
  = 0.25; `('decrease',100,50,75,'decrease')` = 0.5; `('milestone',0,1,0,'increase')` = 0;
  degenerate `('number',10,10,10,'increase')` = 0.

### Task 2: Read RPC `podium.f_okr_cycle(p_cycle_id uuid)` — assembled cycle document

Keep the worker thin + the score math single-sourced: one RPC returns the cycle + objectives +
KRs + latest check-in + computed scores + staleness, as a `jsonb` document. The worker then
**filters individual objectives by visibility** (it can't push the caller's manager-chain into SQL
cheaply) and strips as needed.

- [ ] **Step 1: apply migration `podium_okr_cycle_rpc_v1`** — `f_okr_cycle(p_cycle_id)` returns
  jsonb `{ cycle, objectives:[ { …objective, owner:{id,full_name}, department:{id,name},
  parent_objective_id, key_results:[ { …kr, kr_score, latest_checkin:{value,confidence,checked_in_on},
  stale:bool } ], auto_score, displayed_score } ] }`. Uses `f_okr_kr_score`; `stale` = active cycle
  AND newest check-in (or kr.created_at) > 14 days before IST today; `auto_score` = weighted KR avg;
  `displayed_score` = coalesce(final_score, auto_score). `SET search_path=podium, public`;
  `EXECUTE` revoked from public/anon/authenticated, granted `service_role`.
- [ ] **Step 2: verify** — call with a hand-inserted throwaway cycle+objective+KR+checkin (then
  delete), confirm scores/staleness compute; confirm empty cycle returns `objectives: []` not error.

### Task 3: podiumops — GET reads (visibility-filtered)

**File:** `05_Throttle/podiumops-worker/src/index.js`.

- [ ] **Step 1** — add the action names to the GET dispatch; put `getMyOkrs` (+ `recordCheckin`,
  `gradeObjective` for own) in `SELF_SERVE_GET`/`SELF_SERVE_POST` so no-role users reach their own.
- [ ] **Step 2: `getOkrConfig`** — list cycles (id/name/anchor/status) + current cycle
  (latest non-draft, or latest for HR) + `can_admin` (isHr). `podium_view`-gated.
- [ ] **Step 3: `getOkrCycle(cycleId)`** — call `f_okr_cycle`; then in the worker **drop
  `level='individual'` objectives the caller can't see** (keep if HR/admin, or caller is the owner,
  or caller is an ancestor via `inManagerChain`/`descendantsOf`). Company/dept always kept.
  Annotate each objective `_can_edit`/`_can_grade` (per the authorship rules). Non-HR callers still
  get company+dept; their own/reports' individual come through here too (post-filter).
- [ ] **Step 4: `getObjective(objectiveId)`** — one objective + KRs + **full** check-in history +
  scores; visibility-gated (individual → self/chain/HR, else 403). `_can_edit`/`_can_grade`.
- [ ] **Step 5: `getMyOkrs`** — no param; `callerEmployee(auth)` → their individual objectives in
  the current cycle (+ KRs + check-ins + staleness) + the company/dept objectives (surfaced). 403
  `no_employee_record` if the caller has no employee row (same as Phase 2).
- [ ] **Step 6: `getTeamOkrs`** — `descendantsOf(callerEmployee)` → reports' individual objectives +
  displayed scores + staleness. Chain-scoped; HR/admin may pass an optional `employeeId` to scope to
  a subtree.
- [ ] **Step 7: verify** — `curl` each with a real JWT (an HR token + a plain-employee token if
  available) against a seeded test cycle; confirm a plain employee cannot see a peer's individual
  objective via `getObjective` (403) but sees company/dept + own.

### Task 4: podiumops — POST writers (authorship-gated)

**File:** `05_Throttle/podiumops-worker/src/index.js`. Add a helper
`canAuthorObjective(auth, {level, department_id, owner_employee_id})`:
- company → `isHr(auth)`;
- department → `isHr(auth) || departments.head_employee_id === callerEmployee.id`;
- individual → `isHr(auth) || owner === callerEmployee.id || canManage(auth, owner)`.

- [ ] **Step 1: `createOkrCycle` / `updateOkrCycle` / `setOkrCycleStatus` / `deleteOkrCycle`** —
  `isHr`-gated. Derive `period_start/end` from `anchor_date` (mirror `lib/appraisals.js` logic;
  HR override allowed). `setOkrCycleStatus` validates the `draft→active→scoring→closed` transitions
  (no skipping backwards except HR reopen scoring→active, allow). `deleteOkrCycle` blocked if
  objectives exist unless `{confirm:true}`.
- [ ] **Step 2: `createObjective` / `updateObjective` / `deleteObjective`** — `canAuthorObjective`.
  Validate: level↔department_id/owner required-ness; **alignment ordering** (parent must be up-level,
  same cycle) — reject otherwise with a clear error. `updateObjective` strips `final_score`
  (that's `gradeObjective` only) and never lets level/cycle change.
- [ ] **Step 3: `createKeyResult` / `updateKeyResult` / `deleteKeyResult`** — gated by the parent
  objective's `canAuthorObjective`. `Math.round` not needed (numerics), but coerce numeric inputs.
  On create, `current_value` defaults to `start_value`.
- [ ] **Step 4: `recordCheckin`** — insert `okr_checkins` (author = callerEmployee) **and** update
  the KR `current_value = value` (two writes; parent-authorship-gated; own-individual path
  self-serve). Reject if the cycle is `closed`.
- [ ] **Step 5: `gradeObjective`** — set `final_score`(0–1 clamp)/`final_confidence`/
  `reflection_note`; only when the cycle is `scoring` or `closed`; `canAuthorObjective`-gated.
- [ ] **Step 6: deploy + verify** — `cd 05_Throttle/podiumops-worker && npx wrangler deploy`;
  `curl` a full create-cycle → objective → KR → checkin → grade round-trip; confirm the alignment-
  ordering rejection + a non-author 403.

### Task 5: Appraisal-detail surfacing (read-only)

**File:** `05_Throttle/podiumops-worker/src/index.js` (`getAppraisal`).

- [ ] **Step 1** — in `getAppraisal`, after loading the appraisal + its cycle `appraisal_date`,
  look up `okr_cycles WHERE anchor_date = <that date>`; if found, fetch the **subject's individual**
  objectives (+ KRs + displayed score + confidence + reflection) and attach as `okrs:[…]`. The
  reviewer already has manager-chain/HR access to the subject (superset of individual-OKR
  visibility) so no extra gate needed; return `okrs: []` when no matching cycle.
- [ ] **Step 2: deploy + verify** — confirm `getAppraisal` returns `okrs` (empty until a cycle
  exists with the same anchor; non-empty once seeded). No change to `final_rating`/increment paths.

### Task 6: apps/podium — lib + nav + OKR pages

**Files:** `apps/podium/src/lib/okrs.js` (new), `lib/nav.js`, `app/(auth)/okrs/page.js`,
`app/(auth)/okrs/cycle/page.js`, `app/(auth)/okrs/detail/page.js` (all new).

- [ ] **Step 1: `lib/okrs.js`** — LEVELS/CONFIDENCE/METRIC_TYPE label maps; `krScore()` +
  `objectiveScore()` JS mirror (must match `f_okr_kr_score`); `isStale(kr)`; anchor-date helpers
  (reuse/adapt `lib/appraisals.js`); progress-bar colour by confidence.
- [ ] **Step 2: nav** — add `{ id:'okrs', label:'OKRs', route:'/okrs', requires:'podium_view',
  group:'PERFORMANCE', icon: <Target> }` (lucide) to `nav.js`, ordered near Appraisals.
- [ ] **Step 3: `/okrs`** — cycle picker (default latest non-draft) + cascade tree: company →
  aligned dept → viewer's own + reports' individual, each a row with title, progress bar
  (displayed score), confidence dot, stale badge. Self-fetch via `getOkrConfig` + `getOkrCycle`.
  Real empty state when no cycle. Combobox `portal` for any in-card pickers.
- [ ] **Step 4: `/okrs/cycle`** — HR dashboard: create cycle (name/anchor/period), seed company +
  dept objectives (owner + optional parent Combobox), status-transition buttons with confirms,
  progress tiles, a scoring grid (per-objective final_score input) enabled at `scoring`.
  `can_admin`-gated UI (non-HR: friendly no-access, zero writes).
- [ ] **Step 5: `/okrs/detail`** — objective header (level/owner/parent/scores), KR list
  (start/current/target + progress + inline check-in: value+confidence+note), check-in history,
  grade panel (final score + reflection) shown when cycle `scoring`/`closed` and `_can_grade`.
  Edit/add KR + objective edit gated by `_can_edit`.
- [ ] **Step 6: build** — `npx turbo build --filter=podium` (zero errors).

### Task 7: apps/podium — `/me` OKR block + `/team` surface

**Files:** `app/(auth)/me/page.js`, `app/(auth)/team/page.js`,
`components/PerformancePanels.js` (or a new `OkrPanel.js`).

- [ ] **Step 1: `/me` OKR block** — self-fetch `getMyOkrs`; my individual objectives (KRs +
  inline check-in + stale nudge) + the surfaced company/dept objectives (read-only), beside the
  Appraisals block. Reachable by self-only users (no `podium_view`).
- [ ] **Step 2: `/team`** — a reports'-OKR tab/section via `getTeamOkrs` (progress + stale counts;
  drill to `/okrs/detail`). Fold into the existing team feed.
- [ ] **Step 3: build** — `npx turbo build --filter=podium`; then `npx turbo build` (all apps) as
  the shared-package insurance check.

### Task 8: System Manual — OKRs chapter

**Files:** `apps/podium/docs/manual/manual.json` + `content/okrs.html` (new), generated
`src/data/manual.json` + `public/manual/*.pdf`.

- [ ] **Step 1** — author an **OKRs** chapter (what OKRs are here, the 6-month cadence, how to
  write objectives/KRs, checking in, scoring/grading, who sees what). Add to the manual spine.
- [ ] **Step 2** — `python3 apps/podium/docs/manual/build.py` (PDF) + `python3
  scripts/build-manual-web.py podium` (in-app JSON). Bump manual to **v1.2.0**. **Commit the
  generated `src/data/manual.json` + `public/manual/*.pdf`** (CI only runs `next build`).

### Task 9: Verify, deploy, document

- [ ] **Step 1: verify** — run the `verify` skill / an end-to-end round-trip against the deployed
  worker: HR creates a cycle → seeds a company + a dept objective → an individual creates their own
  objective aligned to the dept one + adds a KR + checks in → HR moves cycle to `scoring` → owner
  grades → confirm `/me`, `/okrs`, `/okrs/detail`, and the appraisal-detail `okrs` panel all read
  correctly; confirm a peer 403s on another's individual objective.
- [ ] **Step 2: deploy** — podiumops already deployed in Tasks 3–5; ensure final version deployed;
  push apps/podium (auto-deploy). Confirm live worker version.
- [ ] **Step 3: knowledge files** — update `systems/podium.md` (Roadmap Phase 4 → Live; DB section;
  worker actions; frontend routes; add **RULE-PODIUM-009**), flip the BACKLOG `[podium]` Phase 4
  line to done/remove, append to `archive/SESSIONS.md`. Bump `Last updated` on touched files.
- [ ] **Step 4: commit + push** all repos with changes (monorepo + root knowledge). Confirm clean
  state. **Browser smoke** (needs real Google logins across an HR + a plain-employee account) is
  Afshaan's — hand off a checklist: HR sees all; a manager sees reports' individual OKRs but not
  peers'; a self-only user reaches only their own via `/me`; the appraisal panel shows OKRs read-only.

---

## Risks / watch-items

- **Visibility filter correctness** — the individual-OKR gate is the sensitive bit (this is Podium).
  The filter lives ONLY in the worker read handlers (Task 3/4), single-sourced; do NOT add a
  client-side filter that could drift (RULE-PODIUM-005 lesson). Test the peer-403 explicitly.
- **Score math drift** — `f_okr_kr_score` (SQL) is canonical; `lib/okrs.js` is a mirror for typing
  feedback only. If they disagree, SQL wins; add a quick parity check in verification.
- **Two-write check-in** — `recordCheckin` writes the log row AND the denormalised KR
  `current_value`; if the second write fails the KR is stale but not wrong (next check-in fixes).
  Acceptable; note it. (Could be one RPC later.)
- **Delete semantics** — cascades are wired (cycle→objectives→KRs→check-ins). `deleteOkrCycle`
  guarded behind an explicit confirm to avoid nuking a populated cycle.
- **Blast radius = Podium only** (one worker, one app, additive migration) — low risk vs a
  lotopsproxy change. Still build all apps once.
