# Ignition Slice B — Monthly Targets & Budgets

> System: **Ignition** · Worker: **ignitionops** · Schema: **ignition**
> Date: 2026-06-03 · Status: approved design, pre-implementation
> Origin: Reann, #bugs 06-03 — Ignition enhancement batch, request 4. Slice B of the Reann batch
> (Slice A shipped S97; Slice C — growth history — is a later spec).

## 1. Scope

Reann sets, per calendar month, a **views target** and a **budget (₹)**, and tracks actuals against
them on an ongoing basis. Confirmed: **grain = overall per month** (one target_views + one
budget_amount per month, company-wide — NOT per tier or per product).

## 2. Data model — `ignition.monthly_targets` (new)

| Column | Type | Notes |
|---|---|---|
| `month` | text PRIMARY KEY | `'YYYY-MM'`, one row per calendar month |
| `target_views` | bigint NULL | monthly views goal (nullable — may set only a budget) |
| `budget_amount` | numeric NULL | monthly budget in ₹ (nullable — may set only a target) |
| `note` | text NULL | optional |
| `created_by` | uuid | auth user |
| `created_at` | timestamptz default now() | |
| `updated_by` | uuid NULL | |
| `updated_at` | timestamptz NULL | |

RLS **enabled**, **service_role-only** (ignition convention — the worker is the only client).
`GRANT ALL ON ignition.monthly_targets TO service_role`. No anon/authenticated grant. The `ignition`
schema is already in the Supabase exposed-schemas list (no dashboard step needed).

## 3. Actuals basis (locked)

A view/spend lands in month X by **`post_date`**, falling back to **`created_at`** when not yet
posted — identical to the existing `getReports` `by_month` logic. **Spend** uses the existing
`spendOf(e)` (= `total_cost` else `payment_amount + ad_spend + commission_amount`). This keeps the
targets page consistent with the Reports monthly figures.

## 4. Worker (`ignitionops`, `05_Throttle/ignitionops-worker/src/index.js`)

### `getMonthlyTargets` (GET, gate `ignition_view`)
- Fetch all `monthly_targets` rows.
- Fetch engagements (one paged scan, select `post_date,created_at,views,total_cost,payment_amount,
  ad_spend,commission_amount`), aggregate per month → `{ actual_views, actual_spend }` (JS sum,
  mirrors `getReports`).
- Merge: the union of months that have a target row OR engagement activity. For each:
  `{ month, target_views, budget_amount, note, actual_views, actual_spend,
     views_pct: target_views ? round(actual_views / target_views * 100) : null,
     spend_pct:  budget_amount ? round(actual_spend / budget_amount * 100) : null }`.
- Sort by `month` desc; cap to the most recent **24** months.

### `upsertMonthlyTarget` (POST, gate `ignition_manage`)
- Body `{ month, target_views, budget_amount, note }`. Validate `month` matches `^\d{4}-\d{2}$`.
- `target_views` / `budget_amount`: coerce '' → null, else `Math.round(Number())` / `Number()`
  (reject negatives → 400).
- Upsert on `month` (PostgREST `Prefer: resolution=merge-duplicates` on a POST with the PK, or
  PATCH-if-exists-else-POST). Stamp `created_by` on insert, `updated_by`/`updated_at` on update.
- Return the saved row.

No new permission keys — reuse `ignition_view` (read) / `ignition_manage` (write).

## 5. App (`apps/ignition`)

### `/targets` page (new, sidebar item "Targets")
- Header + a small **set-target form**: a month picker (defaults to current `YYYY-MM`), a Target Views
  input, a Budget (₹) input, a Save button → `upsertMonthlyTarget`, then reload. `ignition_manage`
  required to see/use the form (read-only viewers just see the table).
- **Tracking table**, one row per month (newest first): Month, Target views, Actual views,
  Views % (with a small progress bar), Budget ₹, Spent ₹, Spend % (progress bar), Note. Months with
  a target but no activity, and months with activity but no target, both appear (the latter with
  "—" targets, prompting Reann to set one). Clicking a row prefills the form for editing.
- Progress bar colour: green when ≤100% of budget / ≥100% of views target on track; amber/red when
  spend > budget or views materially under pace (simple thresholds; cosmetic only).

### Dashboard — "This month" card (new)
- A card showing the running month: actual views vs target (+ %) and spend vs budget (+ %), each with
  a progress bar. Pulls the current-month row from `getMonthlyTargets` (or a dedicated lightweight
  read). If no target set for the month, show "No target set" with a link to `/targets`.

### Nav
- Add a **Targets** item to the Ignition sidebar (gate `ignition_view`).

## 6. Out of scope
- Per-tier / per-product targets (overall-per-month only).
- Targets for metrics other than views + spend (no orders/ROAS targets in V1).
- Slice C (influencer growth history) — separate spec.

## 7. Build sequence
1. Migration: `ignition.monthly_targets` (RLS-on, service_role grant). Verify advisors clean.
2. ignitionops: `getMonthlyTargets` + `upsertMonthlyTarget`; register in the action router + GET map.
   `cd 05_Throttle/ignitionops-worker && npx wrangler deploy` (Ignition-only blast radius).
3. App: `/targets` page + nav item + dashboard "This month" card.
   `npx turbo build --filter=ignition`, commit, push (auto-deploy).
4. Smoke: set a target+budget for the current month → it persists; the tracking table shows actual
   views/spend and correct %; the dashboard card reflects it; a viewer without `ignition_manage`
   sees the table but not the form.
