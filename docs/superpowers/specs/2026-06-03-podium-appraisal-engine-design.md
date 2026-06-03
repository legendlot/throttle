# Podium Appraisal Engine (Phase 3) — design

> Date: 2026-06-03 (Session 97)
> System: Podium — `podiumops` worker + `apps/podium`
> Builds on: Phase 1 (employees/job_roles/role_kpis/compensation_events/settings),
> Phase 2 (performance capture), RULE-PODIUM-001 (tiered access), RULE-PODIUM-005/006.

## Goal

The 6-monthly appraisal: two-sided hybrid reviews → lightweight calibration → banded
increment (→ `compensation_events`) → share + acknowledge → print letters; PIP flag for
low ratings. Designed so **every employee participates regardless of Podium role** (most
managers are self-only) — participation is relationship-scoped, not `podium_view`-gated.

## Locked decisions

- **Review flow:** self first → manager (sees self-review) → calibration → share → acknowledge.
- **Calibration:** lightweight — HR/founder set a calibrated FINAL rating + note per person, then finalize + share. No quotas/curves.
- **Letters:** client-rendered print views (appraisal + increment). Save-to-vault deferred.
- **PIP:** flag/outcome only (final rating ≤ threshold → `outcome='pip'` + worklist). Structured PIP later.
- **Increment:** banded suggestion, **pro-rated by review-period length** (× period_months ÷ 6), comp-overridable. Vault OFF → % + bonus only, no CTC.

## Cadence, eligibility & review period (LOT-specific)

- **Appraisal date anchor:** every cycle is anchored to **Apr 1** (reviews run in April after March close) or **Oct 1** (after Sept close). The anchor is also the increment **`effective_date`** (Apr 1 → shows in April salary paid May 1; Oct 1 → Nov 1).
- **Nominal window** auto-derives: Apr cycle ⇒ prior Oct 1 – Mar 31; Oct cycle ⇒ Apr 1 – Sep 30.
- **Eligibility:** `eligibility_cutoff = appraisal_date − 3 calendar months`; eligible iff **`date_joined < eligibility_cutoff`** (strict). Oct 1 cycle ⇒ cutoff Jul 1 ⇒ a Jul-1 joiner is **not** eligible ("misses by a day"); Jun 30 is in. Enrollment preview **flags borderline** joins (within 7 days *after* the cutoff) as "borderline — exception?" and **null `date_joined`** as "unknown — include?"; HR has a manual include/exclude either way.
- **Per-employee review period (catch-up):** each appraisal carries `review_period_start` = **the appraisal date of that employee's most recent prior appraisal, else their `date_joined`**; `review_period_end` = the cycle's appraisal date. So an Aug-1 joiner who misses Oct is enrolled in the next Apr cycle covering **Aug 1 → Apr 1 = 8 months**; a recurring employee gets the standard 6. `review_period_months` is shown to managers/calibrators.
- **Increment proration:** `suggested_pct = round(band.default_pct × review_period_months ÷ 6, 2)`; the raw band (min/mid/max) is shown for reference; comp enters the actual % + bonus (override).

## Data model (3 new `podium` tables + `settings` additions)

### `appraisal_cycles`
`id uuid pk`, `name text` ("H1 2026" / "Apr 2026"), `appraisal_date date NOT NULL` (Apr 1 / Oct 1),
`period_start date`, `period_end date` (nominal window), `eligibility_cutoff_date date` (default `appraisal_date − 3 months`),
`self_review_due date`, `manager_review_due date`,
`status text` (`draft`|`active`|`calibration`|`closed`, default `draft`),
`created_by uuid`, `created_at`, `updated_at`. RLS-on, service_role-only.

### `appraisals`  (one per cycle+employee; UNIQUE(cycle_id, employee_id))
`id uuid pk`, `cycle_id` fk, `employee_id` fk, `manager_id uuid` (snapshot at enroll),
`review_period_start date`, `review_period_end date`,
`status text` (`self_review`|`manager_review`|`calibration`|`shared`|`acknowledged`, default `self_review`),
self side: `self_overall_rating int`(1–5), `self_did_well text`, `self_improve text`, `self_focus text`, `self_submitted_at timestamptz`,
manager side: `manager_overall_rating int`, `manager_did_well text`, `manager_improve text`, `manager_focus text`, `manager_submitted_at timestamptz`,
calibration: `final_rating int`, `calibration_note text` (HR-internal, never shown to subject), `calibrated_by uuid`, `calibrated_at timestamptz`,
`outcome text` (`standard`|`pip`, set at finalize), `shared_at timestamptz`, `acknowledged_at timestamptz`, `ack_note text`,
`created_at`, `updated_at`. RLS-on, service_role-only. Rating CHECKs 1–5.

### `appraisal_kpi_ratings`  (optional per-KPI sub-ratings)
`id uuid pk`, `appraisal_id` fk (cascade), `role_kpi_id uuid` (nullable), `kpi_name text` (snapshot), `weight numeric` (snapshot),
`self_rating int`, `manager_rating int`, `sort_order int`, `created_at`. Snapshotted from the employee's `role_kpis` at enrollment so later KPI edits never rewrite history.

### `settings` additions
- `increment_bands jsonb` — default `[{rating:5,label:'Outstanding',min:8,mid:12,max:15},{4,'Exceeds',6,8,10},{3,'Meets',3,5,6},{2,'Below — PIP',0,2,3},{1,'Unsatisfactory — PIP',0,0,0}]`.
- `appraisal_prompts jsonb` — default `["What went well","What could have gone better","Focus for the next period"]`.
- `pip_rating_threshold int` default `2` (final rating ≤ this → `outcome='pip'`).

Increment links via the existing `compensation_events.appraisal_id` (no comp data duplicated in `appraisals`).

## State machines

- **Cycle:** `draft` (create + enroll) → `active` (reviews open) → `calibration` (reviews locked; HR finalizes/shares) → `closed`. Worker rejects review submissions unless cycle `active`.
- **Appraisal:** `self_review` → `manager_review` (on self submit; manager may also start directly) → `calibration` (on manager submit) → `shared` (HR finalize sets final_rating+outcome, then Share) → `acknowledged` (employee acks).

## Access model (RULE-PODIUM-001 extended)

Participation is **relationship-scoped, not `podium_view`-gated** (most managers have no Podium role):
- **Subject (any employee, incl. self-only):** view/submit own self-review; after `shared`, see `final_rating` + manager prompts + **own** increment %/bonus; acknowledge. **Never** sees manager review before share, **never** sees `calibration_note`, never others' data.
- **Manager (self or any ancestor via `manager_id` chain):** view/submit manager reviews for reports; see reports' self-reviews; see reports' results after finalize. No comp unless `podium_comp`. Cannot calibrate.
- **HR/admin (`podium_hr`):** cycles, enrollment, calibration, finalize, share; see all appraisals (no comp $ unless `podium_comp`).
- **Comp (`podium_comp`):** the increment %/bonus + `applyIncrement`. Vault still OFF → reuse the existing CTC-strip guard.

## Worker actions (`podiumops`)

**Self-serve (added to SELF_SERVE sets; each enforces relationship internally):**
- GET `getMyAppraisals` (subject = caller), `getAppraisal` (subject OR manager-chain OR HR; strips manager-side/comp per viewer + stage), `getTeamAppraisals` (caller's reports in a cycle), `getAppraisalConfig` (bands/prompts/threshold).
- POST `submitSelfReview` (subject only; cycle active), `submitManagerReview` (canManage; cycle active), `acknowledgeAppraisal` (subject only; status `shared`).

**HR/admin (requireHr):** `getAppraisalCycles`, `getAppraisalCycle` (+progress counts), `getAppraisals` (cycle, filters, calibration grid), `createAppraisalCycle` (derives window+cutoff from anchor), `enrollAppraisalCycle` (eligibility + per-employee period + KPI snapshot; idempotent; include/exclude lists), `setCycleStatus` (activate/calibration/close), `finalizeAppraisal` (final_rating + note → outcome), `shareAppraisal`.

**Comp (requireComp):** `applyIncrement` → inserts `compensation_events` (`event_type='increment'`, `increment_pct`, `amount` bonus, `effective_date`=cycle anchor, `currency`, `reason`, `appraisal_id`, `approved_by`). CTC stripped unless vault on.

Subrequest care: enrollment uses array-insert (one insert for appraisals, one for KPI snapshots), not per-row loops.

## Frontend (`apps/podium`)

- **`/me`** — new **Appraisals** block (reaches every employee, role or not): your current self-review CTA, "reviews you owe" (if you manage anyone), and past shared results.
- **`/appraisals`** — nav (PERFORMANCE group, `requires: podium_hr`): cycle list + "New cycle" (pick Apr/Oct + year).
- **`/appraisals/cycle?id=`** — HR dashboard: enrollment (preview w/ eligibility + borderline/null flags, include-exclude), self/manager progress counts, the **lightweight calibration grid** (row per employee: self & manager overall, set `final_rating` + note, suggested pro-rated %, Finalize, Share), status transitions.
- **`/appraisals/detail?id=`** — relationship-routed (not nav): self form / manager form / combined result, per-KPI sub-ratings, increment panel (comp-gated, shows band + pro-rated suggestion + apply), acknowledge (subject), print-letter links.
- **`/appraisals/letter?id=&type=appraisal|increment`** — print-styled letter (browser Save-as-PDF); increment letter comp/subject-only.
- Lib `lib/appraisals.js` (status/rating/band helpers, period-month math), component(s) for the review form + calibration grid.

## New business rule

**RULE-PODIUM-008** (to add): Appraisals run twice yearly anchored to **Apr 1 / Oct 1** (= increment effective date). Eligibility = `date_joined < appraisal_date − 3 months` (strict; borderline/null flagged for HR exception). Each appraisal's review period runs from the employee's **last appraisal date (else join date)** to the anchor, so a missed cycle is caught up next time (e.g. 8 months). The banded increment suggestion is **pro-rated × period_months ÷ 6**. Participation is relationship-scoped (subject/manager-chain), NOT `podium_view`-gated; calibration notes are HR-internal and never shown to the subject; appraisal is hidden from the subject until `shared`.

## Out of scope (later)

Save-letters-to-vault; structured PIP (goals/check-ins); rating-distribution/9-box calibration; OKR linkage; auto-creating cycles on a schedule; appeals workflow.
