# Odo — P&L page (design)

> 2026-07-01 (S189). Master-tool roadmap P4 (margin/EBITDA). A monthly P&L waterfall matching
> Afshaan's canonical sheet: GMV → NMV → GM → CM1 → CM2 → EBITDA. Each line sourced from Odo
> data where it exists, **0 / manual where it doesn't** (fill later). See [[project_odo_control_station]].

## Waterfall (monthly columns; **bold** = computed subtotal)

| Line | v1 source |
|---|---|
| **GMV** | `sales_fact` Σ(`gross_value` − `discount_value`) — booked value, tax-incl, net of discounts (cancellations already excluded from facts) |
| − RTO | manual (`pnl_manual` `rto`); Amazon RTO auto = fast-follow |
| − Refund | `sales_fact` Σ`returned_value` (dated to refund; Shopify + Amazon) |
| − Taxes | `sales_fact` Σ`tax_value` (GST) |
| **= NMV / Revenue** | GMV − RTO − Refund − Taxes |
| − COGS | Σ(`units` × cost as-of) from `sales.product_cost` (manual, effective-dated) |
| **= GM** | NMV − COGS |
| − Logistics | manual (`logistics`) |
| − Platform Fee | manual (`platform_fee`); Amazon settlement auto = fast-follow |
| **= CM1** | GM − Logistics − Platform Fee |
| − CAC | `mkt_fact` Σ`spend` (Meta + Amazon + Google performance ad spend) |
| **= CM2** | CM1 − CAC |
| − Brand Marketing | manual (`brand_marketing`) |
| − SG&A | manual (`sga`) |
| **= EBITDA** | CM2 − Brand Marketing − SG&A |

Company-wide **Total** (all channels) in v1. Per-channel P&L split = deferred (SG&A / Brand aren't
channel-attributable anyway). Subtotals computed client-side from the base lines.

## Data model
- **`sales.product_cost`** — `(product_code, effective_from)` PK, `cogs_inr numeric`, `note`, `updated_by`, `updated_at`.
  Fully-loaded standard cost per finished SKU; effective-dated (a change adds a row; margin uses the
  latest row ≤ the month). RLS on, service_role only.
- **`sales.pnl_manual`** — `(month, line_key)` PK (`month` = 1st of month), `amount_inr numeric`, `note`,
  `updated_by`, `updated_at`. `line_key ∈ {rto, logistics, platform_fee, brand_marketing, sga}`. RLS on,
  service_role only.

## RPC
`sales.f_pnl(p_from date, p_to date)` → one row per month in range with base-line columns
(`gmv, rto, refund, taxes, cogs, logistics, platform_fee, cac, brand_marketing, sga`). Missing = 0.
COGS via a LATERAL "latest cost ≤ month-end" lookup; manual lines via `pnl_manual`; GMV/refund/taxes
from `sales_fact`; CAC from `mkt_fact`. Set-based (no per-row loops).

## Worker (odoops)
- `getPnl {from,to}` (canView) → `{ rows }`.
- `getProductCosts` (canView) → active `product_master` ⋈ latest `product_cost` (for the editor).
- `setProductCost {product_code, cogs_inr, effective_from?, note?}` (canAdmin) → upsert.
- `getPnlManual {from,to}` (canView) → rows. `setPnlManual {month, line_key, amount_inr, note?}` (canAdmin) → upsert.

## UI — new `/pnl` page (nav after Products, `sales_view`-gated)
- Sticky range filter (+ Last-mo); default trailing ~6 months. Buckets by month.
- **Waterfall table**: rows = the 15 lines (subtotals bold + tinted), columns = months + a **Total** column
  (Σ shown months); INR-formatted, negative EBITDA red / positive green; a subtle row tint on subtotals.
- **Admin-inline editing** (users with `salesops_admin`): the 5 manual-line cells become click-to-edit
  inputs (→ `setPnlManual`); a collapsible **"Product COGS"** panel lists active SKUs with a cost input
  (→ `setProductCost`, effective today). Non-admins see read-only.
- A **cost-coverage note** — % of GMV whose SKUs have a cost entered (so COGS completeness is visible).

## Deferred / follow-ups
Per-channel P&L; Amazon auto-feeds (Platform Fee ← `settlement_fact`, RTO ← returns classification);
Logistics/Brand/SG&A auto-feeds; OOS-lost-sales; derived BOM costing; effective-dated cost history UI
(v1 edits add a row but the editor shows only current). Discount treatment folded into GMV (no separate
line) per Afshaan — revisit if a Discount line is wanted.
