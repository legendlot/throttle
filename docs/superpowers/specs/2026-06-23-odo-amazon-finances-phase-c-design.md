# Odo Phase C — Amazon net-revenue via the Finances API

> Date: 2026-06-23 (Session 162)
> System: Odo (`apps/odo` + `odoops-worker`, `sales` schema)
> Status: design — approved approach (Finances API, full fact + order grain)
> Related: `2026-06-19-odo-sales-segregation-design.md` (the ladder), `2026-06-20-odo-control-station-architecture.md` (granularity charter), `2026-06-18-odo-amazon-phase2.md` (the orders-report connector this builds on)

## Problem

Amazon contributes **gross + cancellations** to the segregation ladder but **no discounts, no GST split, no returns**. Root cause is structural, not a bug: the live feed is `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL`, whose `item-tax` / `item-promotion-discount` / `ship-promotion-discount` columns Amazon ships **blank** for the India marketplace (GST is baked into a tax-inclusive `item-price`; promotions and refunds aren't in the orders feed at all). Verified live: `stg_amazon` rows since 2026-06-21 have `discount_value = 0`, `tax_value = 0`, `returns = 0`.

The net-revenue direction (`project_odo_net_revenue`, RULE-SALES-001) makes **NET — ex-GST, after cancellations and returns — the headline metric on every channel**. Amazon is the largest marketplace and currently can't produce it.

## Decision

Add a **second Amazon data source: the SP-API Finances API** (`listFinancialEvents`). It exposes, per order-item, `Principal` (ex-tax price), `Tax` (GST), and `PromotionList` (the discount), plus `RefundEvent`s (reversals dated to the refund). This fills discount / GST / returns onto the Amazon orders we already ingest.

Rejected alternatives:
- **Settlement report (`GET_V2_SETTLEMENT_REPORT_..._V2`)** — true payout incl. marketplace fees, but scheduled (~14-day cycle, retrieved not requested), keyed by posted/settlement date → heavy lag, reconciliation-grade not daily. **Deferred to Phase C.2** as the margin/fees layer (the charter's "settlement = a first-class separate fact").
- **GST-only derivation** from the tax-inclusive price — no new API, but discounts and returns stay permanently missing and the GST rate is an assumption. Rejected.

## Key architectural insight

`sales.recompute_facts` is already generic over the ladder. It reads `sales.v_staged` and, grouped by `(sale_date, channel_id, product_code)`:
- sums `qty` / `gross_value` / `discount_value` / `tax_value` over `row_type='sale' AND NOT is_cancelled`,
- sums `qty` / `gross_value` over `row_type='return'`.

So **any** staging stream that lands discount/tax/returns through `v_staged` populates `sales_fact` with **no RPC change**. The whole design leans on this.

## Architecture

### 1. Fetch — a finance phase inside `amazonAdapter`

The Amazon connector stays one adapter on the one `Amazon - FBA` channel (PK on `connector_config.channel_id` precludes a second config row for the same channel). Extend `amazonAdapter.fetch` with a **finance phase**:

- Auth: reuse `getAmazonToken` (same LWA refresh token / SP-API host — India = `sellingpartnerapi-eu`).
- Endpoint: `GET /finances/v0/financialEvents?PostedAfter=<iso>&PostedBefore=<iso>&MaxResultsPerPage=100`, paginated via `NextToken`.
- A **second cursor** `fin_cursor` in `connector_config.config` (independent of the orders-report cursor), walking posted-date windows forward from `backfill_start`.
- **Budget-guarded**: the finance phase runs only when the orders-report state machine isn't consuming the subrequest budget this tick (no `pending_report_id` poll/ingest in flight, and `subreqs` under a low-water mark). One window (bounded page count) per tick; cursor advances only on a clean, fully-paged window. This keeps the connector under the 50-subrequest cap and lets orders + finance interleave across cron ticks.

Parse from `FinancialEvents`:
- **`ShipmentEventList[]`** → per `ShipmentItemList[]` item: `SellerSKU`, `QuantityShipped`, `ItemChargeList` (`Principal`, `Tax`), `PromotionList` (sum `PromotionAmount`, the discount). Tagged to `AmazonOrderId`.
- **`RefundEventList[]`** → per `ShipmentItemAdjustmentList[]`: reversed `Principal`+`Tax` (the returned gross), `QuantityShipped` (returned units), `PostedDate` (the refund date). Tagged to `AmazonOrderId`.
- Other event lists (service fees, adjustments, etc.) ignored in Phase C (they belong to the C.2 fees/margin layer).

### 2. Staging — new `sales.stg_amazon_fin`

```
sales.stg_amazon_fin (
  id            bigserial primary key,
  run_id        bigint,
  channel_id    uuid not null,
  amazon_order_id text not null,
  seller_sku    text not null,
  event_type    text not null,          -- 'shipment' | 'refund'
  posted_date   date not null,          -- IST day of the finance PostedDate
  qty           int  not null default 0,
  principal     numeric(14,2) not null default 0,  -- ex-tax
  tax           numeric(14,2) not null default 0,  -- GST
  promo         numeric(14,2) not null default 0,  -- discount (positive magnitude)
  raw           jsonb,
  ingested_at   timestamptz not null default now(),
  unique (channel_id, amazon_order_id, seller_sku, event_type, posted_date)
)
```

Upsert on the unique key (idempotent re-pull). `GRANT ALL ON sales.stg_amazon_fin TO service_role`. RLS on, service_role only — mirrors the other `sales.*` staging tables.

This is a **separate table**, so the orders-report adapter's date-range supersede of `stg_amazon` never touches it.

### 3. Fact grain — extend `v_staged` with an `amazon_fin` branch

`v_staged` gains a UNION branch over `stg_amazon_fin` emitting rows in the shared `v_staged` shape (`channel_id`, `channel_sku`, `sale_date`, `qty`, `gross_value`, `discount_value`, `tax_value`, `row_type`, `is_cancelled`, `src`):

- **`event_type='shipment'`** → a **sale-enrichment row**: `row_type='sale'`, `is_cancelled=false`, `channel_sku=seller_sku`, `qty=0`, `gross_value=0`, `discount_value=promo`, `tax_value=tax`, `sale_date = the order's purchase date`. Because qty/gross are zero, `recompute_facts` *adds* discount+GST into the matching orders-report sale group for that `(date, channel, product)` — no double-count of units or gross.
- **`event_type='refund'`** → a **return row**: `row_type='return'`, `channel_sku=seller_sku`, `qty=returned units`, `gross_value=returned gross`, `sale_date=posted_date` (refund date — matches the existing "returns dated to the refund date" model).

**Purchase-date alignment for shipment rows.** Finance events carry `PostedDate`, not the order's purchase date, but discount/GST must land on the same `sale_date` as the gross they modify. Resolve `amazon_order_id → purchase sale_date` from `stg_orders` (the order-grain table the orders-report adapter already populates, keyed by `source_order_id`). The `v_staged` `amazon_fin` shipment branch therefore joins `stg_amazon_fin` → `stg_orders` on `(channel_id, amazon_order_id = source_order_id, row_kind='order')` and takes `stg_orders.sale_date`. A finance event whose order isn't in `stg_orders` yet (finance posted before the orders window ingested) contributes nothing until both are present — it self-heals on the next recompute of that date. Returns use `posted_date` directly (no dependency).

→ `sales_fact` discount/tax/returns for Amazon fill in with **no `recompute_facts` change**. Cockpit, `/channels`, top-sellers, movers all read fact grain and get the ladder automatically.

### 4. Order grain — `/performance` (`f_order_rollup` ← `stg_orders`)

The order-grain ladder reads `stg_orders`, whose Amazon rows are written by the orders-report adapter with `discount=0`/`tax=0`/`returned_value=0` and re-upserted (merge-duplicates) every tick — so finance can't durably PATCH those columns (the next orders tick would zero them). Instead, derive the Amazon order-grain figures from finance at read time:

- Extend `sales.f_order_rollup` so that, for the Amazon channel, `discount` / `tax` / `returns_count` / `returns_value` come from a `stg_amazon_fin` aggregate (per `sale_date × channel`) rather than the `stg_orders` columns; `orders` / `cancelled_orders` / `cancelled_value` / `gross` continue to come from `stg_orders` (the orders report is authoritative for order counts and cancellations). Aggregate finance shipments to the order's purchase date (same `stg_orders` join as §3) for discount/tax; aggregate refunds to `posted_date` for returns.
- Net effect: `/performance` shows Amazon discounts, GST, and returns consistent with the fact grain, with cancellations unchanged.

This is the single targeted RPC edit in the design; everything else is additive (new table, new view branch, new fetch phase).

### 5. Cron / budget

No `wrangler.toml` change. Within the existing hourly cron and per-connector subrequest budget, the Amazon adapter does at most one of {queue report, poll+ingest report, one finance window} per tick, preferring the report work (recency of gross) and taking a finance window when the report phase is idle. Backfill of finance walks forward over successive ticks like the orders report does.

## Data flow

```
listFinancialEvents (posted-date window, paginated)
  ├─ ShipmentEvent  → stg_amazon_fin (event_type='shipment': principal, tax, promo, qty)
  └─ RefundEvent    → stg_amazon_fin (event_type='refund':  principal+tax, qty, posted_date)
                          │
            v_staged (amazon_fin branch)
              ├─ shipment → sale row (qty0/gross0, discount=promo, tax=tax, date=order purchase date via stg_orders)
              └─ refund   → return row (qty, gross, date=posted_date)
                          │
            recompute_facts  (UNCHANGED)  →  sales_fact  →  cockpit / channels / top-sellers
            f_order_rollup   (Amazon disc/tax/returns from stg_amazon_fin)  →  /performance
```

## Error handling

- Finance auth failure / 5xx → finance phase throws, the tick records `partial`, `fin_cursor` does NOT advance (re-attempt next tick). Orders-report phase is unaffected (separate cursor).
- Empty window (no events) → advance `fin_cursor` past it (don't crawl 1 window/tick through event-less history — mirror the uniware empty-window skip).
- Partial page set (NextToken loop hits the budget) → do NOT advance `fin_cursor`; resume the same window next tick. Upsert is idempotent so re-paging is safe.
- Unmapped SellerSKU → same `sku_map` path as the orders report; finance uses the identical SellerSKUs already mapped, so no new unmapped rows expected (verify post-backfill).
- Refund for an order never seen as a sale (edge) → still lands as a return row on its posted_date; nets out at range level.

## Verification (the live checks to run after deploy)

1. `stg_amazon_fin` populates: shipment + refund counts > 0 over the backfill window.
2. Pick 2–3 known Amazon orders; confirm `Principal + Tax` ≈ the orders-report `item-price` (tax-incl gross reconciles) and `promo` matches the order's discount.
3. `sales_fact` for Amazon recent range: `discount_value` / `tax_value` now > 0, `returned_units` > 0 where refunds exist; `units`/`gross_value` **unchanged** vs pre-deploy (no double-count) — diff the fact rows before/after over a settled window.
4. `/performance` Amazon column shows discounts, GST, returns; cancellations unchanged.
5. Net ex-GST for Amazon = `gross − discount − cancelled − returns − GST` is sane vs a hand-check of one day.

## Out of scope (follow-ups)

- **Phase C.2** — Settlement report: marketplace fees, true payout net, margin lens. Separate settlement fact per the charter.
- Amazon Ads attribution to the Amazon channel (already a separate connector).
- The known ~30-day-window UTC-midnight seam micro-gap on the orders report (separate backlog item).
```
