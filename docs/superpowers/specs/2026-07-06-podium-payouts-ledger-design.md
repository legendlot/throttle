# Podium Payouts Ledger — Design

> Date: 2026-07-06 · System: Podium (People & Performance OS) · Author: Claude + Afshaan
> Status: Approved (design) → implementation plan next
> Builds on the S195 salary vault ([[project_podium_salary_vault]], `2026-07-06-podium-salary-vault-design.md`).
> Phase 1 of 2. Phase 2 (Odo SG&A / P&L feed) is a SEPARATE later spec.

## 1. Purpose & context

Podium currently stores **entitlement** (CTC) in `podium.compensation_events` — the *plan*: fixed +
variable target, the target 90/10 fixed/variable split. It does **not** record **actual payouts** —
what was really disbursed to each person, by type, each period.

Afshaan needs the actuals because **this salary information feeds the SG&A line of the Odo P&L** — the
recorded people-cost must be the real amount paid, with full history. Beyond variable, the profile must
capture **all** payout kinds: fixed, variable, one-time bonus, perks, and any other payout.

So this build generalises the originally-scoped "variable calculation" into a single **payouts ledger**:
the system of record for actual people-cost. The variable calculator becomes one entry method into it.

### Two ledgers, kept distinct
- **`compensation_events` (existing)** — entitlement / CTC. The contract. Unchanged by this build; used
  only as the *source of defaults* (a person's current `monthly_fixed` / `monthly_variable` /
  `variable_yearly` / `bonus_type` from their latest event's `components`).
- **`podium.payouts` (new)** — actuals. Every rupee actually paid, by type, by period. Feeds Odo SG&A
  (Phase 2).

### P&L boundary (avoid double-counting)
This register is **office/staff → SG&A**. The **factory-floor operators** are a *separate* payroll
(`podium.factory_pay`) that already feeds **COGS / conversion cost** (Redline cost module, RULE-COST-001).
Two payroll sources → two P&L lines. This ledger is the SG&A one and does NOT include factory operators.

### Confirmed decisions (Afshaan, 2026-07-06)
- Achievement % / payout is **manual entry by Finance** (not KPI-derived).
- Cadence is **per-person from `bonus_type`** (Monthly vs Half-Yearly), read from the CTC components.
- **No approval/paid workflow** — just record the numbers (a `paid_on` date is captured for P&L timing,
  but there are no draft/approved/paid states).
- Employees **see their own** payouts on `/me` (own-only), same posture as own salary.
- **Fixed payouts: auto-generate monthly** from CTC `monthly_fixed`, Finance adjusts.
- **Odo SG&A feed = separate Phase 2 spec.**
- Half-year boundaries = **Apr–Sep (H1) / Oct–Mar (H2)** (fiscal, matching the appraisal cadence).
- A payout row is **standalone** — it never writes into `compensation_events` (ledgers stay separate).

## 2. Non-goals (this phase)
- Odo SG&A aggregation / read (Phase 2).
- KPI- or appraisal-derived achievement % (manual only for now).
- Approval / paid-status workflow.
- Non-cash perk valuation logic (a perk is recorded as an amount + note; no imputed-value math).
- Factory-operator pay (stays in `factory_pay`).
- Payroll disbursement / bank integration.

## 3. Data model — `podium.payouts`

```sql
CREATE TABLE podium.payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES podium.employees(id) ON DELETE CASCADE,
  payout_type    text NOT NULL CHECK (payout_type IN ('fixed','variable','one_time_bonus','perk','other')),
  period_type    text NOT NULL CHECK (period_type IN ('monthly','half_yearly','one_time')),
  period_key     text,                    -- 'YYYY-MM' | 'FY26-27-H1' | 'FY26-27-H2' | NULL (ad-hoc)
  period_start   date,
  period_end     date,
  target_amount  numeric,                 -- variable base / scheduled fixed; NULL for ad-hoc
  achievement_pct numeric,                -- variable only; NULL otherwise
  amount         numeric NOT NULL,        -- THE ACTUAL PAYOUT (feeds P&L)
  currency       text NOT NULL DEFAULT 'INR',
  paid_on        date,                    -- actual disbursement date (P&L timing); NULL = not yet dated
  note           text,
  source         text NOT NULL DEFAULT 'manual'  -- 'manual' | 'variable_calc' | 'fixed_autogen'
    CHECK (source IN ('manual','variable_calc','fixed_autogen')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- One periodic row per (employee, type, period); ad-hoc rows (NULL period_key) are unconstrained.
CREATE UNIQUE INDEX payouts_period_uniq
  ON podium.payouts (employee_id, payout_type, period_key)
  WHERE period_key IS NOT NULL;
CREATE INDEX payouts_emp_idx    ON podium.payouts (employee_id);
CREATE INDEX payouts_period_idx ON podium.payouts (period_key);
ALTER TABLE podium.payouts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON podium.payouts TO service_role;
REVOKE ALL ON podium.payouts FROM anon, authenticated;
```

**Semantics:**
- `amount` is the **cost basis** (gross, as in the register's "Monthly Fixed"/"Variable"), not employee
  net-of-deductions. Summed per period across a person = their people-cost for that period.
- `target_amount` + `achievement_pct` are informational for `variable` rows (payout = target × pct/100,
  but `amount` is authoritative and overridable). For `fixed`, `target_amount` = the scheduled
  `monthly_fixed`; `amount` = what's actually paid (auto = target, Finance may adjust).
- Ad-hoc types (`one_time_bonus`/`perk`/`other`) use `period_type='one_time'`, `period_key=NULL`,
  `paid_on` set; multiple allowed per person.

## 4. Cadence & period keys

Derived from each person's **current CTC components** (latest `compensation_events` row's `components`):
- `bonus_type='Monthly'` → variable is monthly; a period = a calendar month; `period_key='YYYY-MM'`,
  `period_start`=1st, `period_end`=month-end; default `target_amount = components.monthly_variable`.
- `bonus_type='Half-Yearly'` → variable is half-yearly; two periods per FY:
  **H1** = Apr 1–Sep 30 (`period_key='FY<YY>-<YY+1>-H1'`), **H2** = Oct 1–Mar 31
  (`'FY<YY>-<YY+1>-H2'`); default `target_amount = components.variable_yearly ÷ 2`.
- Fixed is always monthly for everyone; `target_amount = components.monthly_fixed`.

Helper `fiscalHalf(dateOrKey)` and `monthKey(date)` live in the worker; `FY26-27` = 2026-04-01 … 2027-03-31.

## 5. Access & audit — reuse the salary-vault chokepoint

Payouts are salary data, so they ride the exact posture from the vault (no new concept):
- **Cross-person** reads/writes gate on `canComp(auth)` (the `podium.comp_access` allow-list).
- Cross-person reads are written to `podium.comp_access_log` via the existing `logCompAccess` helper
  (new action labels `getPayouts`, `getPayoutPeriodSheet`).
- **Self** view is a parameter-less own-only path (`getMyPayouts`), reachable by the self-only baseline
  (SELF_SERVE_GET), never able to name another employee.
- RLS on, service-role-only.

## 6. Worker actions (podiumops)

GET (comp — `requireComp`):
- `getPayouts(employee_id)` — a person's full payout history (all types, newest first). Audited.
- `getPayoutPeriodSheet(period_key, payout_type)` — the entry grid. For `variable`/`fixed`: every active
  employee whose cadence matches the period (variable: those whose `bonus_type` implies this period_type;
  fixed: all active), each with the **defaulted `target_amount`** from their current components and their
  **existing row** for that period if any. Audited.

GET (self — SELF_SERVE_GET):
- `getMyPayouts` — the caller's own payout history (resolved via `callerEmployee`, no id param). Not audited.

POST (comp — `requireComp`):
- `upsertPayouts` — batch upsert an array of rows (the grid save). Upserts on the
  `(employee_id, payout_type, period_key)` index for periodic rows; inserts ad-hoc rows. Single Supabase
  call (array body) — respects the 50-subrequest limit. Stamps `source`, `created_by`, `updated_at`.
- `generateFixedPayouts(period_key)` — for a month, create a `fixed` row for every active employee that
  doesn't already have one, `amount = target_amount = current monthly_fixed`, `source='fixed_autogen'`.
  Idempotent (skips existing); returns `{created, skipped}`. Finance then adjusts amounts via `upsertPayouts`.
- `deletePayout(id)` — remove one row (mistake correction).

Helpers: `currentComponentsFor(empIds[])` (batch-load latest comp components per employee — one query,
newest per employee), `periodMeta(period_key)` (→ type/start/end), `eligibleForVariable(components, period_type)`.

## 7. App

- **`/admin/payouts`** (comp-gated; self-hides for non-comp like the Salary Access card):
  - **Period** picker (month for monthly; FY-half for half-yearly) + a **type** switch.
  - **Fixed** tab: a "Generate month" button (`generateFixedPayouts`) then an editable grid (person ·
    scheduled · actual `amount` · note) → Save.
  - **Variable** tab: grid of eligible people (target prefilled; enter `%` → payout auto-computes,
    editable) → Save.
  - **Ad-hoc** tab: add `one_time_bonus`/`perk`/`other` rows (person picker · amount · paid_on · note).
  - All saves go through `upsertPayouts`.
- **`/people/detail`**: a comp-gated **Payouts** panel (full history grouped by type/period) — shown when
  the worker returns `can_see_comp`.
- **`/me`**: a **My Payouts** block (own history by type + period) beside the existing "My Compensation".

## 8. Components / interfaces summary

**DB:** migration `podium_payouts_ledger_v1` (table + indexes + RLS + grants, §3).

**Worker (`podiumops-worker/src/index.js`):**
- Handlers §6 + helpers; register in `GET_ACTIONS`/`POST_ACTIONS`; add `getPayouts`/`getPayoutPeriodSheet`
  audit calls; add `getMyPayouts` to `SELF_SERVE_GET`.
- `getEmployee` already returns `can_see_comp` — the app reuses it to gate the Payouts panel.

**App (`apps/podium`):**
- `app/(auth)/admin/payouts/page.js` (new) + a nav entry (comp-gated).
- `components/PayoutsPanel.js` (person history, used on `/people/detail`).
- `components/MyPayouts.js` (self block on `/me`).
- `lib/payouts.js` (period-key helpers, type labels, currency fmt) shared by the pages.

## 9. Assurance / invariants
- No path returns another person's payouts without `canComp`; `getMyPayouts` takes no id.
- `generateFixedPayouts` is idempotent (never doubles a month).
- `upsertPayouts` is one Supabase call regardless of row count (batch) — no per-row awaits.
- Amounts are stored as the gross cost basis; `Number()`-wrap numeric reads, `Math.round` not required
  (amounts may be fractional, e.g. 53,532.50).
- The ledger never mutates `compensation_events`.

## 10. Rollout order
1. Migration `podium_payouts_ledger_v1`.
2. Worker: handlers + helpers + registration + audit wiring. Commit → push → `wrangler deploy`.
3. App: `/admin/payouts` + `PayoutsPanel` + `MyPayouts` + nav. Build → commit → push (auto-deploy).
4. Live smoke (comp login): generate a fixed month, adjust one, enter a variable %, add an ad-hoc bonus;
   confirm `/me` shows own only; confirm a non-comp user sees no Payouts panel.
5. Knowledge: `systems/podium.md` (new tables + actions), memory, BACKLOG (Phase 2 Odo feed item).

## 10a. Addendum — vendor/bulk rows for contract labour (Option A, built S195)

Contract labour is paid as a **bulk lump sum to a 3rd-party agency** (not per-person, not via
RazorpayX), yet those workers are recorded individually in Podium (central salary repository +
org/availability + they count toward SG&A). Decision (Afshaan): keep **all** people-cost in this one
ledger so Odo SG&A reads a single source (Option A over routing it straight to Odo).

Migration `podium_payouts_vendor_v1`: `employee_id` made **nullable**; added `payee_type`
(`employee`|`vendor`, default `employee`) + `payee_label` (agency/vendor name); `payout_type` widened
with `contract_labour`; CHECK `(employee ⇒ employee_id) AND (vendor ⇒ payee_label)`. A bulk agency
payout is **one vendor row** (`payee_type='vendor'`, `payee_label='<agency>'`, `payout_type='contract_labour'`,
`employee_id` null). `upsertPayouts` accepts vendor rows (validates `payee_label` instead of
`employee_id`; vendor + ad-hoc rows are plain inserts, only per-employee periodic rows use the unique
upsert — so vendor rows never dedup-collide on the null `employee_id`). New read `getBulkPayouts`
(comp, audited). UI: a **Contract Labour** tab on `/admin/payouts` (`ContractLabourPanel` — agency +
period + amount + paid_on + note; lists existing with delete). Vendor rows never appear in
`getMyPayouts`/`getPayouts(employee_id)` (no employee). Individual contract workers remain directory
records with no per-person payout rows.

## 11. Phase 2 (separate spec, not now)
Odo reads Podium payout aggregates (per month, per cost-centre/department) into the **SG&A** line of the
P&L. Cross-system read like the Snorkel→Odo sales feed; needs the Odo P&L model. Decide accrual (recognise
in `period_key`) vs cash (recognise on `paid_on`) there — the ledger stores both so either works.
