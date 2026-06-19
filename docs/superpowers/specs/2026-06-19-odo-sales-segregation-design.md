# Odo — Sales-value segregation (gross → net → discounts → returns → GST) + order-type tags

> Design spec. Session 157 (2026-06-19). Status: DESIGN — awaiting sign-off before migration.
> Scope decided with Afshaan: **all channels, where the data exists** (not Shopify-only).
> Measures decided: **discounts + returns (split from cancellations) + true GST/tax + order-type tags** — all four.
> Reference target = the Shopify "Sales Dashboard" screenshot (Total Orders / Total Sales / Net Sales /
> Net Sales ex-GST / AOV / Cancellations / Returns / Total Discounts / Replacements / Influencer / Repairs).

## 1. Problem

Odo today captures **gross only** at **product grain**: `sales.sales_fact (sale_date, channel_id,
product_code) → units, gross_value`. The Shopify adapter pulls just `originalTotalSet` (line gross,
pre-discount) + a single `is_cancelled` flag (which conflates true cancels + refunds + voids).
RULE-SALES-001 fixed this as gross-only-v1.

To produce the screenshot's segregation we need (a) more **measures** (discount, tax, returns) and
(b) a new **grain** — most headline tiles are per-ORDER, which a product-line fact can't express.

## 2. The metric ladder (target semantics)

```
Gross sales            Σ line original total (pre-discount)            [HAVE today]
  − Discounts          Σ line/order discount allocated                 [NEW measure]
  = Net of discounts   (a.k.a. subtotal)
  − Cancellations       exclude whole orders cancelled/voided          [HAVE — is_cancelled]
  = Net of cancellations
  − Returns            Σ refund value, dated to the REFUND date         [NEW — separate event]
  = Net of returns
  ÷ (1 + GST) or − tax = Net ex-GST (taxable base)                      [NEW — true tax, was a flat ÷1.18]
```
Plus order-grain headline metrics: **Total Orders**, **AOV** (= net ÷ orders), **Cancellation
count/rate**, **Returns count + value**, **Total Discounts**, and **order-type counts**
(Replacements / Influencer / Repairs from order tags).

Returns are dated to the **refund date**, not the original sale date — standard "returns in period"
treatment, and it keeps recompute idempotent (a re-pulled refund recomputes only the refund date).

## 3. Grain decision — product fact + an order-grain staging layer

Two grains are needed (product mix vs order/tag/AOV metrics), but only ONE needs a materialized fact:

| Layer | Grain | Drives |
|---|---|---|
| `sales.sales_fact` (existing, extend) | `(sale_date, channel_id, product_code)` | product mix, per-variant net/discount/tax/returns |
| `sales.stg_orders` (**NEW**, queried directly) | `(channel_id, source_order_id, refund_id)` + `row_kind` + `sale_date` | Total Orders, AOV, cancel rate, returns count+value, discount/tax totals, **tag counts** |

`stg_orders` is already clean order-grain and idempotent (re-pulls supersede via merge-duplicates), so
it serves as the order-grain layer **directly** — no separate `order_fact` to keep in sync (avoids a
second drift surface; materialize later only if the rollup ever gets slow). `recompute` therefore only
changes for the product fact.

`stg_orders.row_kind ∈ {'order','return'}` — an `'order'` row per sale order (sale_date = order date;
gross/discount/tax/is_cancelled/tags), a `'return'` row per refund event (sale_date = **refund date**;
returned_value = refund amount; source_order_id = original order; refund_id = the refund). This one
table answers every headline tile via `f_order_rollup`: Total Orders = count(row_kind='order' ∧
¬cancelled); Cancellations = count(cancelled); Returns = count(row_kind='return') + Σ returned_value;
AOV/Discounts/Tax from 'order' rows; the three order-type tiles from 'order'.tags × `order_type_rules`.

**Two staging streams** (the existing line stream stays; a new order stream is added):
- **Line staging** (`stg_shopify/_amazon/_snorkel/_qc`, extended) → `sales_fact` (product grain).
- **Order staging** `sales.stg_orders` (**NEW**, order/return grain) → `f_order_rollup`. QC has no
  order id, so it contributes only to `sales_fact` and is simply absent from order metrics (its order
  count renders '—', correct).

## 4. Schema changes (migration `sales_value_segregation_v1`)

**Staging (`stg_shopify`, `stg_amazon`, `stg_snorkel`, `stg_qc`, and `v_staged`):** add
- `row_type text NOT NULL DEFAULT 'sale'`  — `'sale'` | `'return'`
- `discount_value numeric DEFAULT 0`       — discount allocated to this line (sale rows)
- `tax_value numeric DEFAULT 0`            — tax on this line (sale rows)
- (`v_staged` re-created to surface the new cols + `row_type`; existing UNIQUE-on-source-line-id stays)

A **return** stages as its own row(s): `row_type='return'`, `sale_date = refund processed date`,
`qty` = returned qty, `gross_value` = refunded amount, `source_line_id` = refund-line id (distinct
key, so a refund never collides with the original sale line). Whole-order cancels keep using
`is_cancelled=true` on the sale rows (unchanged).

**`sales.sales_fact`:** add `discount_value`, `tax_value`, `returned_units`, `returned_value`
(all `numeric`/`int` default 0). `gross_value`/`units` unchanged (sale rows only).

**`sales.stg_orders` (NEW, order/return staging):** `id`, `run_id`, `channel_id uuid`,
`source_order_id text`, `refund_id text NULL`, `row_kind text` (`'order'`|`'return'`), `sale_date date`,
`order_name text`, `gross numeric`, `discount numeric`, `tax numeric`, `currency`, `is_cancelled bool`,
`returned_value numeric default 0`, `tags text[] default '{}'`, `raw jsonb`, `ingested_at`.
UNIQUE `(channel_id, source_order_id, COALESCE(refund_id,''))` — re-pulls supersede (merge-duplicates).

**`sales.order_type_rules` (NEW, tiny config):** `channel_id uuid NULL` (null = all), `match_kind`
(`'tag_prefix'`|`'tag_exact'`), `pattern text`, `order_type text` (`replacement`|`influencer`|`repair`|…).
Seed from the "MO " tag convention (confirm exact prefixes with the team). Keeps classification
data-driven, not hardcoded.

## 5. Recompute rewrite (preserves RULE-SALES-001 idempotency)

`sales.recompute_facts(p_channel, p_dates[], p_run_id)` still **delete+reinsert per (channel, dates)**:

1. **sales_fact** — delete for (channel, dates); reinsert from `v_staged` `row_type='sale' AND
   is_cancelled=false`, summing `units, gross_value, discount_value, tax_value` grouped by
   (date, channel, product via sku_map); then **left-merge returns**: from `row_type='return'`
   (dated to refund date) sum `returned_units, returned_value` into the same grain (a date can carry
   both a sale and a return for a product).
2. **order metrics** — no recompute step; `stg_orders` is the order-grain layer directly (idempotent
   on re-pull via merge-duplicates). `f_order_rollup` reads it live and classifies `order_types` from
   `tags × order_type_rules` at query time.

Re-pulls and cancellations net out exactly as today; returns net out on their own date.

## 6. Rollups (worker reads these)

- `f_sales_rollup` — extend SELECT to also `SUM(discount_value), SUM(tax_value), SUM(returned_units),
  SUM(returned_value)`. Backward-compatible (new trailing columns).
- `f_order_rollup` (**NEW**) — `(p_from, p_to, p_channels[])` → per (date, channel):
  `orders, cancelled_orders, gross, discount, tax, returns_value, returns_count`, and tag counts
  (`replacement_orders, influencer_orders, repair_orders`). Drives the headline KPI row + per-channel.

## 7. Per-channel availability matrix (populate where it exists; blank '—' elsewhere)

| Channel | Gross | Discount | Tax | Returns | Cancels | Tags |
|---|---|---|---|---|---|---|
| **Shopify** | ✅ originalTotalSet | ✅ totalDiscountSet/discountedTotalSet (per line) | ✅ taxLines (per line) | ✅ order.refunds → return rows | ✅ cancelledAt/financialStatus | ✅ order.tags |
| **Amazon** | ✅ item-price | ✅ item-promotion-discount (all-orders report) | ✅ item-tax | ⚠️ separate Returns report — Phase C2 (defer) | ✅ order-status=Cancelled | ❌ no tags |
| **QC gsheet** | ✅ realized sale | ❌ (unless team adds a column) | ❌ | ❌ | ⚠️ status col if present | ❌ |
| **GT/MT (Snorkel)** | ✅ taxable_value | ⚠️ order discount if present | ✅ GST from invoice | ⚠️ credit notes (future) | ✅ status=cancelled | ❌ |

Shopify is full coverage; the others fill in over phases. Dashboard renders '—' for a channel ×
measure that the source can't supply (never a misleading 0).

## 8. Connector changes

- **Shopify (Phase B, richest):** widen the GraphQL — add per line `discountedTotalSet`,
  `totalDiscountSet`, `taxLines{priceSet{shopMoney{amount}}}`; add order `subtotalPriceSet`,
  `totalDiscountsSet`, `totalTaxSet`, `tags`, and `refunds{ createdAt refundLineItems{ lineItem{id}
  quantity subtotalSet{shopMoney{amount}} totalTaxSet{shopMoney{amount}} } }`. Stage sale rows with
  discount/tax; stage refund line items as `row_type='return'` dated to `refund.createdAt` (IST day).
  Backfill via the existing cursor walk (re-pulls supersede by source_line_id).
- **Amazon (Phase C):** the all-orders report already carries `item-price`, `item-tax`,
  `promotion-discount`, `item-status` → map into discount/tax + cancels in `gridToQcRows`. Returns =
  a later Returns report (Phase C2, backlogged).
- **GT/MT (Phase D):** add order discount (if any) + GST from the Snorkel invoice; cancels already
  flagged.
- **QC (Phase D):** gross only unless the team's sheet gains discount/tax columns — config-driven.

## 9. Dashboard (Phase E)

Extend the existing cockpit (`apps/odo /`): a **metric-ladder KPI row** (Gross → Net of disc → Net
of cancel → Net of returns → Net ex-GST) + Orders/AOV/Cancellation-rate/Returns/Discounts tiles +
the three order-type tiles, each with the prior-period delta the cockpit already computes. Per-channel
table gains the new columns. New worker actions read `f_order_rollup` + the extended `f_sales_rollup`.
Gated on `sales_view` (v1); split to a `cost_view`/`finance_view` later if margin lands.

## 10. Phasing / build order

- **A — schema + RPCs** (migration `sales_value_segregation_v1`): staging cols, `sales_fact` measures,
  `order_fact`, `order_type_rules`, recompute rewrite, `f_order_rollup`, `f_sales_rollup` extend.
  Additive + idempotent; existing gross facts untouched until a recompute reruns.
- **B — Shopify connector** widen + backfill (full coverage; proves the whole ladder end-to-end).
- **C — Amazon** discount/tax/cancels (returns report = C2, deferred).
- **D — GT/MT + QC** fill-ins.
- **E — dashboard** surfaces + order-type-rules seed.

Each phase commits + deploys independently (odoops single-file worker; gh-pages app). Worker deploy
blast radius = Odo only.

## 11. Open decisions to confirm before Phase A

1. **Order-type tag convention** — exact Shopify tag strings/prefixes for replacement / influencer /
   repair (screenshot says "MO …" — is it `MO-Replacement`, a prefix `MO `, etc.?). Seeds
   `order_type_rules`.
2. **"Net Sales" definition on the headline tile** — confirm it means net-of-cancellations (matches
   45.01 = 66.89 gross − cancels) vs also net-of-discounts/returns. The ladder above keeps all four as
   distinct steps so the tile can point at whichever the team wants.
3. **GST** — true per-line tax (this spec) vs keep the flat ÷1.18 derivation. Spec captures true tax;
   the flat divisor stays as a fallback where a channel has no tax data.
```
