# Factory Cost & Productivity Tracking — Design

> Status: DESIGN (approved forks; pending user review of this spec)
> Date: 2026-07-01 (Session in progress)
> Systems: Redline (views) · Podium (cost source-of-truth) · lotopsproxy (cost engine)
> Author: Claude Code + Afshaan

## 1. Purpose

Track **manpower productivity** and **cost per unit of production** on a day-to-day basis
so the production team (Assembly + QC + Packaging) can manage per-unit conversion cost as
they fine-tune floor efficiency, and so leadership can see a monthly fully-loaded per-unit
cost to add on top of COGS.

Three cost views + one productivity view:

1. **Monthly loaded ₹/unit** — all factory costs for a month ÷ all cars packed that month.
2. **Daily production-only ₹/unit** — per day, per product (assembly+qc+packaging + fixed).
3. **Daily full ₹/unit** — per day, per product (V2 + store + dispatch + admin + security).
4. **Per-operator productivity** — per-capita units/operator/day by department.

Runs are not yet stabilised, so **the grain is per DAY (not per run)**. Labor-per-product
attribution is explicitly deferred; v1 allocates shared cost across products by unit-share.

## 2. Definitions & invariants

- **Units produced** = distinct **cars** (`units.component_type='car'`) scanned at the
  **PKG_OUT** station, non-voided, on the given **IST day**
  (`(scans.timestamp AT TIME ZONE 'Asia/Kolkata')::date`). Remotes ride along the box and
  are **not** counted (consistent with RULE-009). Product = `units.product` (join
  `scans.upc → units.upc`). Verified path (2026-07-01): Shadow ~350–500/day, Knox ~150–250, etc.
- **Working days** = Mon–Sat in the calendar month (`EXTRACT(DOW) <> 0`), reusing the
  RULE-ATT-001 working-day definition. No holiday calendar (revisit if one is added).
- **Daily rate** of any monthly amount = `monthly_amount ÷ working_days_in_that_month`.
- **Present that day** = the operator has ≥1 `public.operator_attendance` row for that date.
  (An operator marked `day_status` Absent/Leave is NOT present — exclude those.)
- **Overtime pay** = `overtime_minutes ÷ 60 × OT_RATE`, where in v1 `OT_RATE = avg(96, 103) =
  ₹99.50/hr` (in-house ₹96, contract ₹103). Both rates stored; segregation deferred.
  `operator_attendance.overtime_minutes` already exists (RULE-ATT-001 amendment, S131/132).
- **Product split** = unit-share: a day's pooled cost is allocated to product P as
  `pool × (cars_P ÷ total_cars)`. Consequence: the **conversion ₹/unit is uniform across
  products for a given day** — per-product differentiation in the *loaded* cost comes from
  each product's own COGS (added downstream by the user). This is intentional for v1.
- **Confidentiality (hard rule):** individual salaries live only in `podium` and are managed
  only in the Podium admin UI. The cost engine and Redline views expose **aggregates only** —
  never a per-person salary, never a per-dept salary total small enough to back out an
  individual. See §6.

## 3. Cost model (formulas)

Let, for a given date `d` in month `m`:
- `WD(m)` = Mon–Sat working days in month `m`.
- For each present operator `o` on `d` in a department set `D`:
  `daycost(o) = monthly_ctc(o, d) ÷ WD(m) + overtime_minutes(o, d) ÷ 60 × OT_RATE`
  where `monthly_ctc(o, d)` is the effective per-operator pay on date `d`.
- `fixed_daily(d)` = Σ over active `factory_cost_inputs` of kind {rent, electricity, other}
  effective on `d`: `monthly_amount ÷ WD(m)`.
- `overhead_daily(d)` = Σ over active `factory_cost_inputs` of kind {admin, security}
  effective on `d`: `monthly_amount ÷ WD(m)`.
  **Do not double-count: a person is either an attendance-costed operator OR a cost line.**
  The manpower pools (V2/V3) count present operators ONLY in the explicit dept sets
  {assembly,qc,packaging} (V2) and +{store,dispatch} (V3). The `admin`/`security`
  cost-input LINES carry everyone NOT in those sets — the security guard, and the
  `department='admin'` staff (who are excluded from the V2/V3 attendance pools by design and
  represented instead as a flat monthly `admin` line). So admin-dept attendance is used for
  productivity/presence but never attendance-costed.

**View 2 — Daily production-only (per product):**
```
prod_depts = {assembly, qc, packaging}
pool_V2(d) = Σ daycost(o) for present o in prod_depts + fixed_daily(d)
cars(d)    = Σ cars over all products at PKG_OUT on d
perunit_V2(d)      = pool_V2(d) ÷ cars(d)
alloc_V2(d, P)     = pool_V2(d) × cars_P ÷ cars(d)     # per-product allocated cost
```

**View 3 — Daily full (per product):**
```
pool_V3(d) = pool_V2(d) + Σ daycost(o) for present o in {store, dispatch}
                        + overhead_daily(d)            # admin + security lines
perunit_V3(d)  = pool_V3(d) ÷ cars(d)
alloc_V3(d, P) = pool_V3(d) × cars_P ÷ cars(d)
```

**View 1 — Monthly loaded ₹/unit:**
```
month_cost(m) = Σ over working days d in m of [ pool_V3(d) ]        # sums all manpower present
                                                                    # + all fixed + overhead
month_cars(m) = Σ cars over all PKG_OUT car-scans in m
perunit_month(m) = month_cost(m) ÷ month_cars(m)
```
Note V1 is the monthly roll-up of the same daily pool used in V3, so the three views are
consistent by construction. Fixed + overhead months are summed at daily rate across the
working days that actually fell in the month (so a partial month is handled correctly).

**Productivity (per-capita by dept):**
```
For each dept team T in {assembly, qc, packaging, store, dispatch} on day d:
  present(T, d)   = # distinct present operators in T
  cars(d)         = total cars packed that day (shared output signal)
  percap(T, d)    = cars(d) ÷ present(T, d)     # units per operator in T that day
```
Per-capita uses the whole-day car output as the numerator for every production team (line
work — no single person "makes" a unit). Trendable over a date range. (Individual
scan-count throughput is out of scope for v1 per the chosen "Per-capita by dept" basis.)

## 4. Data model — Podium factory module (`podium` schema)

All tables RLS-on, service_role-only, GRANT ALL to service_role. Effective-dated so history
is preserved. Managed only in the Podium admin UI (§5).

### 4.1 `podium.factory_ranks` (classification provision — NOT the pay driver)
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| code | text unique | e.g. `helper`, `operator`, `senior_op`, `line_lead` |
| label | text | display |
| sort_order | int | |
| created_at | timestamptz default now() | |

Pay is per-operator (§4.2); rank is a **grouping/classification** label only (kept as the
provision the user asked for — enables future rank-band reporting / OT segregation).

### 4.2 `podium.factory_workforce`
One row per factory operator, linking the scanner identity to the Podium cost layer.
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| operator_id | uuid | FK → `public.operators.id`, unique |
| rank_id | uuid null | FK → `factory_ranks.id` (classification) |
| employment_type | text | `in_house` \| `contract` (default `in_house`; drives future OT segregation) |
| active | boolean default true | mirrors employment; a left operator → false |
| created_at / updated_at | timestamptz | |

### 4.3 `podium.factory_pay` (effective-dated per-operator monthly cost)
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| operator_id | uuid | FK → `public.operators.id` |
| effective_from | date | |
| monthly_ctc | numeric(12,2) | salary + perks, one all-in monthly figure |
| note | text null | |
| created_at | timestamptz | |
| created_by | uuid null | |

Effective pay on date `d` = the row with the greatest `effective_from ≤ d` for that operator.
Bulk-uploadable from the Excel sheet (§5.3).

### 4.4 `podium.factory_cost_inputs` (effective-dated fixed + overhead monthly lines)
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| kind | text | `rent` \| `electricity` \| `other` \| `admin` \| `security` |
| label | text | display (e.g. "Factory rent", "Night security guard") |
| effective_from | date | |
| monthly_amount | numeric(12,2) | |
| is_estimated | boolean default false | electricity = true in v1 |
| note | text null | |
| created_at / created_by | | |

`fixed_daily` reads kinds {rent, electricity, other}; `overhead_daily` reads {admin, security}.
Multiple concurrent lines of the same kind are allowed (summed); effective-dating picks the
latest per line.

### 4.5 `podium.factory_ot_rates` (config, single effective-dated row set)
| col | type | notes |
|---|---|---|
| id | uuid pk | |
| effective_from | date | |
| in_house_per_hour | numeric(8,2) | 96.00 |
| contract_per_hour | numeric(8,2) | 103.00 |
| created_at | | |

v1 OT_RATE = `avg(in_house_per_hour, contract_per_hour)` effective on the day. When
employment segregation lands, switch to per-operator `employment_type` → matching rate.

## 5. Podium admin UI (`apps/podium` + `podiumops`)

New admin surface (HR / super-admin tier, same confidentiality as the comp vault). Not linked
from any factory-facing app. Sections:

1. **Workforce** — table of factory operators (from `public.operators` where the person is
   floor workforce) with their rank + employment_type + current monthly_ctc; edit inline.
2. **Pay history** — per operator, the effective-dated `factory_pay` timeline; add a new
   effective row (never edit history).
3. **Fixed & overhead costs** — `factory_cost_inputs` CRUD (rent/electricity/other/admin/
   security), with the electricity estimate flagged.
4. **OT rates** — the two rates + a note that v1 uses the average.

### 5.3 Bulk pay upload
An "Upload salaries" action accepting the user's Excel (paste-CSV or file → parsed client-side
to rows `{employee_id | operator name, monthly_ctc, rank?, employment_type?, effective_from?}`).
Matched to `public.operators` by `employee_id` (fallback exact name), previewed with
match/no-match, then one worker call inserts `factory_workforce` (upsert) + `factory_pay` rows.
Unmatched rows surfaced for manual fix. `effective_from` defaults to the month start if omitted.

podiumops handlers (service_role, HR/super-admin gated): `getFactoryWorkforce`,
`setFactoryPay` (append effective row), `setFactoryWorkforce` (rank/type/active),
`bulkUploadFactoryPay`, `getFactoryCostInputs`/`setFactoryCostInput`, `getFactoryOtRates`/
`setFactoryOtRates`.

## 6. Cost engine (`lotopsproxy`) + Redline views

### 6.1 Engine (lotopsproxy, service_role)
New GET handlers. **They read `podium.factory_*` cross-schema via service_role and return
AGGREGATES ONLY — never an individual or dept-level salary.** This is the boundary that keeps
Podium's confidentiality intact even though lotopsproxy technically can read the raw rows.

- `getFactoryCostDaily(date)` → `{ date, working_days, cars_total, per_product:[{product,cars}],
  v2:{ pool, per_unit, per_product:[{product,cars,alloc,per_unit}] },
  v3:{ pool, per_unit, per_product:[...] },
  breakdown:{ prod_manpower, store_manpower, dispatch_manpower, fixed, overhead, ot_total } }`
  — breakdown is by **cost category**, not by person.
- `getFactoryCostMonthly(month)` → `{ month, working_days, cars_total, month_cost, per_unit,
  daily:[{date, cars, v3_pool, v3_per_unit}], categories:{...} }`.
- `getOperatorProductivity(from, to)` → per day per dept `{date, dept, present, cars, per_capita}`.

Implementation notes:
- Batch reads (IN filters / date-range selects); never loop awaits per operator/day
  (50-subrequest Worker limit).
- Attendance present-set + overtime_minutes come from one `operator_attendance` range query
  joined to `operators.department`. Pay resolved by picking the latest `factory_pay.effective_from
  ≤ date` per operator in code (single fetch of all pay rows, resolved in-memory).
- Cars per product per day: one `scans⋈units` aggregate query over the range (PKG_OUT, car,
  non-voided, IST day).

### 6.2 Redline UI (`apps/redline`)
New nav section **"Costs & Productivity"** behind a new permission key `factory_cost_view`
(added to `PERM_DEFS` + enforced in the worker on every handler above). Granted to Afshaan +
production leadership only (verify against `store.roles` before deploy — RULE-011 /
permission-model rule). Pages:
- **Daily costs** — date picker; V2 & V3 per-unit headline + per-product table (cars, allocated
  cost, ₹/unit) + a category breakdown bar (manpower / fixed / overhead / OT). No names, no salaries.
- **Monthly costs** — month picker; loaded ₹/unit headline + month-over-month trend + daily
  V3 ₹/unit sparkline + category split.
- **Productivity** — date-range; per-capita units/operator/day by dept, trend chart + table.

## 7. Permissions

- New perm key `factory_cost_view` (Redline / lotopsproxy) — the three cost views + productivity.
- Podium factory admin surface reuses Podium's existing HR/super-admin tiering
  (RULE-PODIUM-001) — no new key unless a finer split is wanted.
- Every new lotopsproxy handler calls `canRead('factory_cost_view')` as its first line (RULE-011).

## 8. Out of scope (v1)

- In-house/contract OT segregation (data captured via `employment_type` + both rates stored;
  v1 uses the average).
- Electricity capture UI (v1 = estimate flagged `is_estimated`); a meter/bill UI comes later.
- Labor-per-product / per-run costing (runs not stabilised) — v1 splits by unit-share.
- COGS / BOM material cost integration — v1 outputs conversion ₹/unit only; the user adds it
  onto COGS in the existing flow. (`material_master.unit_cost` is widely null anyway.)
- Individual operator throughput (scan-count) productivity — v1 is per-capita by dept.
- Any surfacing of salaries outside Podium.

## 9. Migrations (Podium)

`podium_factory_cost_v1` — create the five tables (§4) + indexes
(`factory_pay(operator_id, effective_from)`, `factory_cost_inputs(kind, effective_from)`,
`factory_workforce(operator_id)` unique) + RLS enable + GRANT ALL to service_role. Additive,
advisor-clean. `podium` is already on the PostgREST exposed-schema list.

## 10. Open items / confirmations still needed

- The Excel sheet columns (to finalise the bulk-upload parser mapping).
- Confirm the initial rank/classification list (or leave `rank_id` null at upload and classify later).
- Confirm rent + electricity(estimate) + any "other" fixed amounts to seed `factory_cost_inputs`.
- Confirm which `public.operators` rows are the security-guard / non-scanner admin people (so
  they're captured as `factory_cost_inputs` lines, not double-counted as attendance operators).

## 11. Implementation phasing

- **Phase A — Podium cost source of truth:** migration `podium_factory_cost_v1`; podiumops
  handlers; Podium admin UI (workforce, pay history, cost inputs, OT rates, bulk upload).
  Seed from the Excel.
- **Phase B — Cost engine + Redline views:** lotopsproxy handlers (aggregate-only) + perm key
  `factory_cost_view`; Redline Daily/Monthly/Productivity pages.

Phase A must precede B (B reads A's tables). Each phase: edit → commit → push → deploy the
affected worker.
