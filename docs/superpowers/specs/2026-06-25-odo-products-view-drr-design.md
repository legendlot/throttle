# Odo — Products View + DRR (Daily Run Rate) — Design

> Date: 2026-06-25 (Session 169). System: Odo (`apps/odo` + `odoops` + `sales` schema). Status: design (approved).
> Mirror of the Channels section, but **product-centric**: product is the hero, with its distribution across channels, drill-downs, and a new reusable **DRR** metric.

## Goal
A product-centric section where a **product family** (Shadow/Ghost/Flare/Nitro/Fang…) is the hero — showing its sales distribution across channels and a drill-down to per-channel + per-SKU detail — plus **DRR (Daily Run Rate)**: trailing-window average units sold per day, per (product × channel). DRR is built as a **reusable server-side metric** (other LOT systems — Redline production planning, etc. — will consume the same definition), with a **global, admin-configurable window** (default 7 days).

## Confirmed decisions (brainstorm 2026-06-25)
- **Hero grain = product family**; drill-down exposes channel distribution + variant/SKU breakdown.
- **DRR window is GLOBAL** (one org-wide value, not per-user), admin-set.
- **DRR is display-only inside Odo**, but is a **first-class metric other systems will consume** → must live server-side behind a stable contract (RPC), not a frontend calc.
- Distribution spans **all sell-out channels**; DRR computed per **(product_code × channel)** (finest grain → reusable for SKU-level production planning) and rolled up to family/overall.

## 1. DRR — the reusable metric (core)

### `sales.settings` (new) — the global knob
```
key text primary key, value text, updated_at timestamptz default now(), updated_by uuid
```
Seed `('drr_window_days','7')`. RLS on; `GRANT ALL … TO service_role`. The single source of truth for the DRR window; any consumer (Odo, Redline, future) reads it.

### `sales.f_product_drr(p_window int default null, p_ref_date date default null)` (new RPC) — the contract
- **window** = `coalesce(p_window, (select value::int from sales.settings where key='drr_window_days'), 7)`.
- **ref_date** = `coalesce(p_ref_date, ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1))` — i.e. **yesterday IST** (today's partial day excluded so velocity isn't dragged down).
- **window range** = `[ref_date - (window-1) .. ref_date]` inclusive — N **full** days.
- **Returns** rows: `product_code, product (family), channel_id, units_window numeric, drr numeric` where `units_window = Σ sales_fact.units` over the range for that (product_code, channel) and `drr = units_window / window`.
- **Source**: `sales.sales_fact` (sale_date in range) LEFT JOIN `public.product_master pm` on product_code (for `product` family); LEFT JOIN `public.dispatch_channels` only if a name is needed (channel_id is enough — the app already has the name map). Grain = (product_code × channel_id). Family/overall DRR = SUM of rows (the app rolls up).
- **Units semantics**: `sales_fact.units` is consumer sell-out, **cancellation-excluded** (RULE-SALES-001) and gross of returns — i.e. "units sold". (A net-of-returns variant is a later option; v1 = sold units, matching the ask.)
- `STABLE`, `SECURITY DEFINER`, `search_path = sales, public`; `GRANT EXECUTE … TO service_role`.
- **This RPC is the cross-system contract** — Redline/other workers call it (with the global window) for production planning. One definition, one window, everywhere.

## 2. Worker (`odoops`) actions
- **`getProductDrr`** (GET, `canView`): `?window=&ref_date=` (both optional) → `rpcSales('f_product_drr', {p_window, p_ref_date})` → `{rows}`.
- **`setDrrWindow`** (POST, `canAdmin` = `salesops_admin`): `data:{days}` (int ≥1, ≤365) → upsert `sales.settings` `drr_window_days` (+ `updated_by`). Returns the saved value.
- **`getBootstrap`**: add `drr_window_days` (read `sales.settings`) to the payload so pages show the active window.
- No change to existing sales/marketing actions; distribution reuses `getSales(group='variant')`.

## 3. Products page (`apps/odo`, new top-level nav)
- **Route**: `/products` (single page, master-detail — no per-product dynamic route, so static export stays clean; selection is in-page state, optionally synced to `?p=<family>`).
- **Nav**: new top-level item **Products** (lucide `Boxes`), `sales_view`-gated, placed after **Channels**.
- **Header**: `RangePicker` (MTD default) for the distribution/sales figures + a **`DRR · Nd` chip** showing the active global window.
- **Master list** (all families): table/cards — **Product · Units · Gross · DRR (overall) · Top channel · #channels**, sortable, click → detail. Built from `getSales(group='variant', all channels, range)` rolled up to family via the `getVariants` `product_code→product` map (the dashboard's proven pattern), joined to `getProductDrr` for the DRR column.
- **Detail (selected product)**:
  - KPI tiles (shared `Kpi`): **Units · Gross · Net (ex-GST if order-grain available, else gross) · DRR overall**.
  - **Channel distribution**: horizontal bars (gross or units toggle) + a table — per channel: **Units · Gross · share% · DRR/channel**.
  - **Variant/SKU breakdown**: per SKU within the family — **Units · Gross · DRR/SKU** (DRR per product_code summed across channels).
  - **Daily trend** (gross/units, stacked by channel) — reuse `StackedTrendChart`.
- All tiles use the S169 compact `Kpi`; page wrapped in `.so-page`.

## 4. Admin control (`/admin`)
- A small **"DRR window"** field (days, default 7) + Save → `setDrrWindow` (salesops_admin-gated; non-admins don't see it). On save, the Products page's DRR chip + numbers reflect the new window on next load. (Optional later: an inline transient "preview window" on the Products page that does NOT change the saved global.)

## Data flow
```
sales_fact ──┐
product_master (family) ──> f_product_drr(window, ref_date) ──> getProductDrr ──┐
sales.settings (drr_window_days) ──> (default window) ────────────────────────┤
getSales(variant, all channels, range) + getVariants(code→family) ────────────┴─> /products (master + detail)
                                                                  (future) Redline production planning → f_product_drr()
```

## Out of scope (v1)
- Days-of-cover / inventory tie-in (needs stock-on-hand per channel).
- Actually wiring Redline/other systems to consume DRR (we ship the contract RPC; consumers are separate later work).
- Net-of-returns DRR variant; per-user window override; forecasting.

## Verification (worker norm — no unit harness)
- SQL: `f_product_drr(7)` returns sane rows; `units_window/7 = drr`; family roll-up of per-channel = product overall; window honours `sales.settings` when `p_window` null; ref_date defaults to yesterday IST.
- `setDrrWindow(10)` → `getProductDrr` (no window arg) reflects a 10-day window; `getBootstrap.drr_window_days = 10`.
- Build green; authenticated browser smoke on `/products` (master list, drill-down, DRR column, Admin setter) — OAuth-gated, flagged pending like other Odo UI.
