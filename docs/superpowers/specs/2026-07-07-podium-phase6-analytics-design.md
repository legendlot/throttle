# Podium Phase 6 — Analytics (design spec)
> Created 2026-07-07 (Session 196). Closes the "analytics" half of the original Phase 6
> ("Google Workspace sync + analytics + polish" — the sync half shipped S97).
> Companion docs: `2026-06-02-podium-design.md` (system design),
> `2026-07-06-podium-salary-vault-design.md` (comp access model, RULE-PODIUM-002).

## What it is

A read-only **`/analytics`** page in Podium with three report families, powered by three
set-based Postgres RPCs (aggregates only) and three gated podiumops GET actions. No new
tables, no crons, no writes. Pattern precedent: `public.f_factory_cost_*` (RULE-COST-001) —
aggregation happens in Postgres; per-person rows (especially salary) never cross the worker.

Decisions locked with Afshaan (S196):
- **Scope: all three families in v1** — Org & Headcount, Comp & Payroll Cost, Performance.
- **Audience: the page is HR/admin-gated** (`podium_hr` or `podium_admin`); the comp section
  is additionally gated to the `podium.comp_access` allow-list (RULE-PODIUM-002).
- **Placement: new `/analytics` page** with its own nav entry; `/dashboard` untouched.
- **Cost basis: plan now, actuals overlay** — monthly cost trend derives from
  `compensation_events` (the CTC plan, complete since the S195 seed), with
  `podium.payouts` actuals drawn as an overlay series where rows exist. The future
  RazorpayX connector only densifies the actuals series — no rework.
- **Architecture: Option A** — Postgres RPCs + thin worker reads (vs worker-side
  aggregation or snapshot tables).

## Data layer — migration `podium_analytics_v1`

Three functions in the `podium` schema. Each returns a single `jsonb` document so each
section costs the worker exactly one PostgREST call. `EXECUTE` revoked from
`public`/`anon`/`authenticated`, granted to `service_role` only.

**Schema-verification note:** exact column names (`date_joined`, exit-date column, `status`
values, `payouts.period_key` format, appraisal side columns) MUST be checked against
`reference/db-schema.md` + live `information_schema.columns` before writing the SQL
(workspace schema rule). Shapes below are the contract; column spellings are indicative.

### `podium.f_analytics_org(p_months int default 12)`

Over `podium.employees` (+ `departments`):

- `headcount`: active employees (login-less included) — `total`, `by_department[]`
  (`{department, count}`), `by_employment_type[]`, `by_legal_entity[]`.
- `joiners_exits[]`: one row per month for the trailing `p_months` —
  `{month, joiners, exits}` from `date_joined` / exit date (IST month grain).
- `tenure_buckets[]`: active employees bucketed `<6mo / 6–12mo / 1–2y / 2–3y / 3y+`
  by `date_joined`.
- `attrition`: `{trailing_12mo_pct, series[]}` — exits in trailing 12 months ÷ average
  headcount ((start + end)/2 approximation), plus a monthly-rate series.
- Employees with null `date_joined` are excluded from tenure/attrition math but counted
  in headcount.

### `podium.f_analytics_comp(p_months int default 12)` — aggregates ONLY

Over `compensation_events` + `payouts` + `employees`/`departments`:

- `totals`: `{annual_ctc_total, monthly_plan_cost, employees_with_comp, employees_without_comp}` —
  latest **effective** comp event per active employee (effective-dated pick, not merely
  latest-created). Build-time checksum: `annual_ctc_total` must reconcile to the known
  ₹4.88 cr from the S195 seed.
- `by_department[]`: `{department, annual_ctc_total, headcount_with_comp}`.
- `distribution[]`: annual-CTC histogram buckets, fixed edges
  `<3L / 3–6L / 6–12L / 12–24L / 24L+` (hardcoded in the RPC; revisit only if the live
  spread makes a bucket useless).
- `increments[]`: per appraisal anchor (effective_date), `{anchor, count, avg_increment_pct}`
  from increment-type events.
- `monthly_trend[]`: `{month, plan_cost, actuals_employee, actuals_vendor}` —
  - **plan**: Σ (CTC in force that month ÷ 12) over employees active that month
    (effective-dated join to comp events);
  - **actuals**: Σ `payouts.amount` grouped by month (`period_key` for monthly rows;
    `paid_on` month for ad-hoc/one-time), split `payee_type` employee vs vendor
    (vendor = contract-labour bulk rows). Sparse until RazorpayX lands — rendered as an
    overlay, absence is expected.
- **No k-anonymity suppression needed**: every viewer is on the comp allow-list and can
  already read any individual's pay via `getCompensation`. Small-department sums reveal
  nothing the viewer can't already see.

### `podium.f_analytics_perf(p_cycles int default 4)`

Over `appraisal_cycles`/`appraisals` + `observations`/`accomplishments`/`one_on_ones`:

- `cycles[]`: the most recent `p_cycles` cycles —
  `{cycle, appraisal_date, status, rating_distribution: {1..5 counts}, avg_final_rating,
  pip_count, funnel: {enrolled, self_submitted, manager_submitted, finalized, acknowledged}}`.
- `activity[]`: per month trailing 12 —
  `{month, observations_positive, observations_neutral, observations_constructive,
  wins, one_on_ones}`.
- Aggregate counts only — no per-person ratings or observation bodies in the payload.

## Worker layer — podiumops (3 new GET actions)

| Action | Gate | Notes |
|---|---|---|
| `getAnalyticsOrg` | `podium_hr` OR `podium_admin` | passes `months` param through (clamped, default 12) |
| `getAnalyticsComp` | **`canComp` (allow-list) only** | RULE-PODIUM-002 single-chokepoint; writes a `comp_access_log` row (action `getAnalyticsComp`) — it is a cross-person comp read even though aggregated |
| `getAnalyticsPerf` | `podium_hr` OR `podium_admin` | passes `cycles` param through (clamped, default 4) |

Each handler: gate → single RPC call → return jsonb. RULE-011 (guard first line) applies.
`getAnalyticsComp` deliberately does NOT also require HR — the allow-list is the salary
gate everywhere else; a non-HR allow-list member hitting the API directly sees only
aggregates of data they can already read person-by-person.

`getMe` must expose the caller's `compAccess` boolean (verifyJWT already resolves it —
surface it in the response if not already there) so the frontend can decide whether to
render/fetch the comp section.

## Frontend — `apps/podium`

- New route `(auth)/analytics/page.js` + nav entry **Analytics** (`requires: 'podium_hr'`;
  the `admin` system role carries all keys so admins pass). Sits in the nav near
  Appraisals (HR cluster).
- **Single scrolling page, three sections**, each independently self-fetching with its own
  loading / error / empty state — a comp 403 (or non-member) simply hides that section,
  never blanks the page.
  1. **Org & Headcount** — KPI tiles (headcount, joiners 30d, exits 12mo, attrition %);
     charts: headcount-by-department bar, joiners-vs-exits monthly paired bar, tenure
     buckets, attrition line.
  2. **Payroll Cost** (comp allow-list only) — KPI tiles (annual CTC total, monthly plan
     cost, latest avg increment %); charts: cost-by-department bar, CTC distribution
     histogram, monthly plan-vs-actuals trend (plan line + employee/vendor actuals bars).
  3. **Performance** — KPI tiles (latest closed cycle avg rating, PIP count, participation
     %); charts: rating distribution per cycle (grouped bar), participation funnel,
     activity volume lines.
- **Recharts** added to `apps/podium`'s own package.json (same move Throttle made in S161;
  app-local, zero blast radius on other monorepo apps). Styling via Pit Wall v2 tokens +
  existing `components/ui.js` atoms (KpiTile, FilterChip); chart colors from the token ramp.
- In-app **System Manual**: add a short "Analytics" chapter to `apps/podium/docs/manual/`
  + rebuild PDF + web data (S105 upkeep rule — manual travels with the code, same PR).

## Error handling

- RPC/worker failure → section-level error card with retry; other sections unaffected.
- Empty actuals series renders an empty overlay (expected until RazorpayX/manual entry).
- Months/cycles params clamped server-side (1..36 / 1..10) — no unbounded scans.

## Explicitly out of scope (v1)

- Manager-subtree-scoped analytics (org analytics for "my team" — future ask).
- Factory blue-collar analytics (`factory_*` is COGS-side, already served by Redline Costs).
- Export/CSV, scheduled email digests, OKR analytics (Phase 4 dependency).
- Any write path. Any new permission key (existing keys + allow-list only).

## Verification plan

1. RPCs: run via `execute_sql`, reconcile against live truths — headcount vs directory
   count, `annual_ctc_total` ≈ ₹4.88 cr (52 seeded events), rating counts vs the closed
   cycle's appraisal rows, payouts sums vs `/admin/payouts` totals.
2. Worker: deploy, curl each action with a real JWT — verify gates (403 for non-HR on org/perf,
   403 for non-allow-list on comp) + a `comp_access_log` row lands for `getAnalyticsComp`.
3. Frontend: `next build` all apps green; commit → auto-deploy.
4. Authenticated browser smoke (Afshaan) — goes to the standing pending list.
