# Podium Phase 4 — OKR Engine (design spec)
> Created 2026-07-10 (Session 206). Closes Roadmap Phase 4 ("OKRs — objectives/KRs
> cascade, check-ins, scoring; link to appraisals/observations").
> Companion docs: `2026-06-02-podium-design.md` (system design),
> `2026-06-03-podium-appraisal-engine-design.md` (RULE-PODIUM-008 — cadence + relationship
> scoping this reuses), `2026-06-03-podium-permission-layer-design.md` (RULE-PODIUM-006).

## What it is

An **OKR module** in Podium: objectives with measurable key results, cascading
**company → department → individual**, updated through ad-hoc check-ins, auto-scored from KR
metrics, and given a **manual final grade** at cycle close. OKR cycles are anchored to the same
**Apr 1 / Oct 1** dates as appraisals; the cycle's individual OKR scores are **surfaced read-only**
on the appraisal detail (never weighted into the rating).

New `podium` tables + podiumops actions + `apps/podium` pages. **No new permission key** —
reuses the `podium_view`/`podium_hr`/`podium_admin` layer + the `employees.manager_id` chain,
exactly like Phase 2 (performance capture) and Phase 3 (appraisals).

## Decisions locked with Afshaan (S206)

- **Cadence: 6-monthly, aligned to appraisals.** OKR cycles anchor to `appraisal_date`
  (Apr 1 / Oct 1). Separate table from `appraisal_cycles` — the two lifecycles move
  independently (an OKR cycle can be in `scoring` while the appraisal cycle is still `active`).
- **Cascade: Company + Department + Individual** (three-tier `level` enum). Alignment to a
  parent objective is **optional but encouraged** — not enforced (best practice; forcing
  alignment produces box-ticking links).
- **Scoring: auto-progress + manual final grade.** KR auto-score = progress fraction from
  start/current/target; objective auto-score = weighted KR average (live during the cycle).
  At `scoring`, the owner sets a **final graded score 0.0–1.0** + reflection; the auto-score is
  shown beside it as reference.
- **Appraisal link: surface, don't weight.** The subject's individual objectives + scores for
  the OKR cycle whose anchor == the appraisal's `appraisal_date` render read-only on
  `/appraisals/detail`. No effect on `final_rating` or increment.
- **Individual-OKR visibility: conservative (consistent with the rest of Podium).** Company +
  department objectives are org-visible (any `podium_view`); **individual** objectives are
  visible only to self + the manager chain (ancestors) + HR/admin — same as the full profile.
  (Not the fully-transparent classic-OKR model, by Afshaan's call.)

## Non-goals (v1)

- No OKR weighting into appraisal ratings (surfacing only — locked above).
- No enforced check-in cadence / no reminder notifications (staleness is *surfaced*, not pushed;
  reminders ride the future Podium notifications track, same as the appraisal/checklist reminders).
- No Phase-5 OKR (that's the separate roadmap item). No cross-cycle objective carry-over
  (a new cycle starts fresh; an owner may copy-forward manually — copy helper is a fast-follow).
- No public "company OKR wall" outside Podium.

## Cadence & lifecycle

`okr_cycles.status`: `draft → active → scoring → closed` (mirrors the appraisal cycle shape).

- **draft** — HR is building the cycle + seeding company/department objectives; nothing visible
  to non-HR yet.
- **active** — the working window. Objectives + KRs editable by their owners/managers; check-ins
  accepted; auto-scores live. This is the bulk of the 6 months.
- **scoring** — end-of-cycle grading. Owners enter the final graded score + reflection per
  objective. Check-ins still allowed (final data point). Auto-score frozen for display is not
  needed — it's always computed live from KR values.
- **closed** — read-only archive. Feeds the appraisal-detail surface.

Anchor derivation (same helper shape as appraisals, `lib/appraisals.js` precedent): given
`appraisal_date` Apr 1 → `period_start` = Oct 1 prior year, `period_end` = Mar 31; Oct 1 →
`period_start` = Apr 1, `period_end` = Sep 30. HR can override the two period dates at create.
Only **one non-closed cycle at a time** is expected but not hard-enforced (HR may pre-stage the
next `draft` while the current is `scoring`); the app defaults views to the latest non-draft cycle.

## Data model — migration `podium_okr_engine_v1`

Four new tables in the `podium` schema. All **RLS-on, service_role-only, no anon/authenticated
grants** (RULE-RLS-001); `GRANT ALL … TO service_role` on each (monorepo rule). FKs to
`podium.employees(id)`.

**Schema-verification note:** column spellings below are the contract; the SQL author MUST
confirm against live `information_schema.columns` before writing DDL. Verified live 2026-07-10:
`appraisal_cycles.appraisal_date` (date), `departments.head_employee_id` (uuid),
`employees.manager_id`/`status`(text, `'exited'` sentinel)/`date_exited`, `settings` is a
singleton with jsonb config columns.

### `okr_cycles`
| col | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `name` | text NOT NULL | e.g. "H1 FY26-27 (Apr 2026)" |
| `anchor_date` | date NOT NULL | Apr 1 / Oct 1 — mirrors `appraisal_cycles.appraisal_date` |
| `period_start` | date NOT NULL | |
| `period_end` | date NOT NULL | |
| `status` | text NOT NULL default `'draft'` | CHECK in (draft, active, scoring, closed) |
| `created_by` | uuid | auth user id |
| `created_at`/`updated_at` | timestamptz default now() | |

### `objectives`
| col | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `cycle_id` | uuid NOT NULL → `okr_cycles(id)` ON DELETE CASCADE | |
| `level` | text NOT NULL | CHECK in (company, department, individual) |
| `owner_employee_id` | uuid → `employees(id)` ON DELETE SET NULL | required in practice; company objectives owned by a founder/designated owner |
| `department_id` | uuid → `departments(id)` ON DELETE SET NULL | set for `level='department'`; else null |
| `parent_objective_id` | uuid → `objectives(id)` ON DELETE SET NULL | the cascade/alignment link (optional) |
| `title` | text NOT NULL | |
| `description` | text | |
| `status` | text NOT NULL default `'active'` | CHECK in (active, closed) — per-objective, distinct from cycle status |
| `final_score` | numeric(3,2) | manual grade 0.00–1.00, set at cycle `scoring` |
| `final_confidence` | text | CHECK in (on_track, at_risk, off_track) or null |
| `reflection_note` | text | end-of-cycle reflection |
| `sort_order` | int default 0 | |
| `created_by` | uuid | |
| `created_at`/`updated_at` | timestamptz | |

Constraints/validation (enforced in the worker, not just DDL):
- `level='department'` ⇒ `department_id` NOT NULL; `level='individual'` ⇒ `owner_employee_id` NOT NULL.
- **Alignment ordering** — `parent_objective_id`, if set, must point *up*: individual → dept or
  company; dept → company; company → null. Same-cycle only. Worker validates; no cross-level-down links.
- Index `(cycle_id, level)`, `(owner_employee_id)`, `(department_id)`, `(parent_objective_id)`.

### `key_results`
| col | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `objective_id` | uuid NOT NULL → `objectives(id)` ON DELETE CASCADE | |
| `title` | text NOT NULL | |
| `metric_type` | text NOT NULL | CHECK in (number, percentage, currency, milestone) |
| `start_value` | numeric | milestone: 0 |
| `target_value` | numeric NOT NULL | milestone: 1 |
| `current_value` | numeric NOT NULL default 0 | denormalised latest — mirror of the newest check-in for cheap reads |
| `unit` | text | free label e.g. "units", "₹", "%" |
| `direction` | text NOT NULL default `'increase'` | CHECK in (increase, decrease) |
| `weight` | numeric NOT NULL default 1 | objective auto-score = Σ(kr_score·weight)/Σweight |
| `status` | text NOT NULL default `'active'` | CHECK in (active, closed) |
| `sort_order` | int default 0 | |
| `created_at`/`updated_at` | timestamptz | |

`current_value` is the **denormalised** latest check-in value so directory/list reads don't
aggregate `okr_checkins`; the newest check-in is the source of truth and always rewrites it.

### `okr_checkins`
| col | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `key_result_id` | uuid NOT NULL → `key_results(id)` ON DELETE CASCADE | |
| `author_employee_id` | uuid → `employees(id)` ON DELETE SET NULL | |
| `value` | numeric NOT NULL | new `current_value` at this check-in |
| `confidence` | text NOT NULL | CHECK in (on_track, at_risk, off_track) |
| `note` | text | |
| `checked_in_on` | date NOT NULL default (now() AT TIME ZONE 'Asia/Kolkata')::date | |
| `created_at` | timestamptz default now() | append-only |

Index `(key_result_id, created_at desc)`.

## Scoring math (single source of truth — a Postgres helper, mirrored in JS for optimistic UI)

- **KR score** ∈ [0,1]:
  - `increase`: `clamp((current − start) / nullif(target − start, 0), 0, 1)`
  - `decrease`: `clamp((start − current) / nullif(start − target, 0), 0, 1)`
  - `milestone`: `current >= target ? 1 : 0`
  - degenerate `target == start` ⇒ 0 (avoid div-by-zero).
- **Objective auto-score** = `Σ(kr_score · weight) / Σ(weight)` over active KRs; no KRs ⇒ null.
- **Objective displayed score** = `final_score` if set (cycle `scoring`/`closed`), else the
  live auto-score.
- **Rollup (display only, not stored):** a parent objective may show the avg of its own
  auto-score + aligned children's scores as a "cascade progress" figure in the tree view.
  Not persisted; computed in the read RPC.

The canonical computation lives in the read path (`getOkrCycle`/`getObjective` RPC or worker),
so the number is identical everywhere; the JS mirror (`lib/okrs.js`) is only for instant
feedback while typing a check-in.

## Permissions & visibility (no new key)

**Cycle admin** (`createOkrCycle`/`setOkrCycleStatus`/delete) — `podium_hr` or `podium_admin`.

**Objective authorship / edit:**
- `company` — HR/admin only.
- `department` — HR/admin **or** the department's `head_employee_id` (the head owns their dept's
  objectives). A dept head with no elevated role still authors via this relationship check.
- `individual` — the owner themselves (self-serve) **or** an ancestor manager of the owner
  (`canManage`, the same chain used by observations/1:1s) **or** HR/admin.
- **Final grade** (`gradeObjective`) — same authorship rule as edit (owner grades own; manager
  may grade reports'; HR/admin any). Light-touch — no separate calibration step like appraisals.

**KR + check-in authorship** — same as the parent objective's edit rule.

**Reads / visibility (enforced server-side in the list/detail handlers — never client-side):**
- `company` + `department` objectives (and their KRs/check-ins) → any `podium_view`.
- `individual` objectives → **self + manager chain (ancestors) + HR/admin** only. A peer or a
  down-chain report cannot see another individual's OKRs. Mirrors `canSeeFull` for profiles.
- Participation actions (view/check-in/grade **own** OKRs) are **relationship-scoped, NOT
  `podium_view`-gated** — surfaced on `/me`, exactly like appraisal participation
  (RULE-PODIUM-008). `getMyOkrs` takes no employee-id param → structurally self-only. The
  cross-person `getObjective`/`getOkrCycle` apply the visibility filter above.

So a no-Podium-role employee (`{}` permissions, self-only baseline) can still view + check-in +
grade **their own** individual OKRs and see the company/dept OKRs their manager surfaces to
them via `/me` — but reaches no one else's individual OKRs. (Same "full baseline OR self-scoped"
gate: `getMyOkrs`, `recordCheckin`-on-own, `gradeObjective`-on-own live in `SELF_SERVE_*`.)

## Staleness nudge (surfaced, not pushed)

During an `active` cycle, a KR whose newest check-in `checked_in_on` (or, if none, the KR
`created_at`) is **> 14 days** ago is flagged `stale:true` in the read payload. Surfaced as a
badge on `/me` (my OKRs) + a count on the `/okrs` cycle header. No cron, no notification — a
visual prompt only. (Threshold `settings`-driven is a fast-follow; hardcode 14 in v1.)

## Worker actions (podiumops)

Patterns reused verbatim from the existing worker: `sb()` targets `podium`
(`Accept-Profile`/`Content-Profile: podium`); RPC via `sb('/rest/v1/rpc/<fn>', …)`; gates
`isHr(auth)` / `canManage(auth, subjectId)` / `callerEmployee(auth)`; `SELF_SERVE_GET` /
`SELF_SERVE_POST` bypass `podium_view` but stay self-scoped in-handler; `normalizePodiumPerms`
footgun guard unchanged (no new key to add).

**GET**
- `getOkrConfig` — cycles list (id/name/anchor/status) + the current cycle + whether the caller
  can admin. Cheap bootstrap for the OKR pages.
- `getOkrCycles` / `getOkrCycle(cycleId)` — HR: full cycle with company + dept objectives
  (+ KRs + latest check-in + computed scores + staleness). Non-HR: company/dept objectives only
  (individual objectives excluded from the cross-person read — those come via `getMyOkrs`/
  `getTeamOkrs`/`getObjective`).
- `getObjective(objectiveId)` — one objective + KRs + full check-in history + score; visibility-
  gated (individual → self/chain/HR).
- `getMyOkrs` — self only, no param: the caller's individual objectives (across the current
  cycle) + KRs + check-ins + staleness + their surfaced company/dept objectives. Powers the
  `/me` OKR block.
- `getTeamOkrs` — a manager's reports' individual objectives (descendants via the chain) +
  progress, for `/team`. Chain-scoped.

**POST**
- `createOkrCycle` / `updateOkrCycle` / `setOkrCycleStatus` / `deleteOkrCycle` — HR/admin;
  delete blocked once objectives exist (or cascade with an explicit confirm flag — default block).
- `createObjective` / `updateObjective` / `deleteObjective` — authorship-gated per level (above);
  validates level↔department_id/owner and the alignment-ordering rule.
- `createKeyResult` / `updateKeyResult` / `deleteKeyResult` — parent-objective-authorship-gated.
- `recordCheckin` — writes an `okr_checkins` row and rewrites the KR `current_value`; authorship
  = parent objective's rule; own-individual path is self-serve.
- `gradeObjective` — sets `final_score` + `final_confidence` + `reflection_note`; only when the
  cycle is `scoring` or `closed`; authorship-gated.

All list reads annotate rows with `_can_edit` / `_can_grade` (compute the chain once server-side,
same as Phase 2's `_can_edit`/`_can_delete`) so the UI needn't recompute.

## Appraisal surfacing (read-only)

On `/appraisals/detail`, when viewing a subject's appraisal for a cycle with
`appraisal_date = D`, fetch the subject's **individual** objectives from the `okr_cycles` row
where `anchor_date = D` (if any) and render a collapsed **"OKRs this period"** panel: objective
titles, displayed score, confidence, reflection. Read-only; no write path from the appraisal
screen; does not touch `final_rating`/increment. Implemented as a small addition to the existing
appraisal detail read (`getAppraisal` returns an `okrs` array) — gated by the appraisal's own
relationship scope (the reviewer already has manager-chain/HR access to the subject, which is a
superset of individual-OKR visibility, so no new leak).

## Frontend (apps/podium)

- **`/okrs`** — cycle picker + overview. A **cascade tree**: company objectives → aligned dept
  objectives → (for the viewer's own / their reports') individual objectives, each with a
  progress bar (displayed score) + confidence dot + stale badge. HR sees all company/dept;
  everyone sees company/dept + their own + reports' individual.
- **`/okrs/cycle`** — HR dashboard: create/seed company + dept objectives, status transitions
  (draft→active→scoring→closed), progress tiles, a light scoring grid at `scoring`.
- **`/okrs/detail`** — one objective: KR list with start/current/target + progress, inline
  check-in (value + confidence + note), check-in history, and the grade panel (final score +
  reflection) when the cycle is `scoring`/`closed`.
- **`/me`** — new **OKR block** (my individual objectives + KRs + check-in CTA + stale nudges +
  the company/dept objectives surfaced to me), beside the existing Appraisals block.
- **`/team`** — reports' OKR progress (fold into the existing team feed or a tab).
- **Nav** — new **"OKRs"** item in the PERFORMANCE group, `requires: 'podium_view'` (self-only
  users still reach their own via `/me`, same as appraisals having no nav item but living on `/me`;
  here we add the nav item but the browse pages are `podium_view`-gated while `/me` is not).
- **`lib/okrs.js`** — level/confidence/metric-type labels, the JS score mirror, staleness helper,
  anchor-date helpers (reuse the appraisal anchor logic).
- Reuse `components/ui.js` atoms (KpiTile, GridTable, StatusBadge dot-pill), the Combobox for
  the parent-objective + owner pickers (`portal` inside cards), Recharts for progress bars if
  wanted (dep already present).

## System Manual

Add an **OKRs** chapter to `apps/podium/docs/manual/` (spine → content fragment), rebuild
`manual.json` + PDF (`scripts/build-manual-web.py podium` + `docs/manual/build.py`), commit the
generated artifacts (CI only runs `next build`). Manual bumps to v1.2.0. (Per CORE.md the manual
travels with the code — not a separate backlog item.)

## Rollout / safety

- Migration is **additive** (four new tables, no ALTER of existing) — auto-runs, no sql-gate prompt.
- No lotopsproxy involvement (blast radius = Podium only, one worker + one app).
- `apps/podium` is a static export → auto-deploys on push; podiumops = `cd … && npx wrangler deploy`.
- Build all monorepo apps (`npx turbo build`) — the OKR work is app-local but the shared-package
  check is cheap insurance.
- Empty-state correctness: every read returns `[]`/nulls cleanly with zero cycles/objectives
  (the pages render a real "no OKR cycle yet" state, like `/analytics` did for zero appraisal cycles).

## New rule

**RULE-PODIUM-009** (to add to `systems/podium.md`): OKR engine — 6-monthly cycles anchored to
appraisal dates; company/dept/individual cascade with optional up-only alignment; auto-progress +
manual final grade; individual-OKR visibility = self + manager chain + HR (conservative);
surfaced read-only on appraisals, never weighted; no new perm key (reuses `podium_view`/`hr`/
`admin` + the manager chain). Migration `podium_okr_engine_v1`.
