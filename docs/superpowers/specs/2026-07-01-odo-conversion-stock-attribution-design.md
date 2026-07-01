# Odo — Conversion tracking layers (c) stock in/out + (d) attribution (design)

> 2026-07-01 (S189). Extends the S186 conversion-tracking initiative. Layer (a) daily GA4
> funnel snapshot + (b) website-changes stream are live. This adds **(c)** a native-Shopify
> **stock in/out event stream** and **(d)** an **attribution / driver library** that ties CR
> moves to nearby events. See [[project_odo_conversion_tracking]].

## Goal

Make the website funnel auditable per single day and read *why* conversion moved, by overlaying
the input streams that plausibly caused it. (a) is the CR spine; (b) overlays website changes;
(c) overlays product availability; (d) associates CR deltas with nearby events and measures each
event's apparent before/after effect — the "driver library" that offloads manual correlation.

## Layer (c) — stock in/out stream

### Source
Native **Shopify Admin GraphQL** (odoops already has a client-credentials token +
`X-Shopify-Access-Token` GraphQL client, API `2026-04`). NOT Garage producibility — produced units
fan out to many channels; conversion is about what is purchasable **on the website**.

Query (paginated, 250/page):
```graphql
productVariants(first: 250, after: $cursor) {
  nodes { sku inventoryQuantity inventoryPolicy inventoryItem { tracked } product { title status } }
  pageInfo { hasNextPage endCursor }
}
```
LOT has ~100 variants → a few subrequests per run.

**Purchasable** (can a customer buy it on the site today?) =
`product.status = ACTIVE` AND ( `inventoryItem.tracked = false` OR `inventoryPolicy = CONTINUE` OR `inventoryQuantity > 0` ).
Anything else = **out of stock**.

### No backfill
Shopify has no historical inventory API, so (c) captures **forward from deploy**. The CR spine (a)
keeps full history; stock markers begin the day the snapshot step goes live. Documented in the UI note.

### Grain
**Variant/SKU level** (SKU = product-variant-colour, matches `sales_fact.product_code`). SKU →
`product_code` via the existing Website `sku_map` (`channel_id` = the Shopify channel). Unmapped SKUs
are still captured (keyed by `sku` + `product_title`) so nothing is lost.

### Data model
- **`sales.inventory_snapshot`** (new) — grain `(the_date, sku)`. Cols: `the_date date`, `sku text`,
  `product_code text NULL` (mapped), `product_title text`, `available_qty int`, `purchasable bool`,
  `captured_at timestamptz`. PK `(the_date, sku)` (idempotent daily upsert). RLS on, service_role only,
  `GRANT ALL … service_role`. Small volume (~100 rows/day); also seeds future days-of-cover.
- Reuse **`sales.change_events`** with `stream='stock'`. Per flip: `id` = `stock:<sku>:<the_date>:<dir>`
  (slug PK, idempotent), `the_date`, `title` = `"<product_title> — out of stock"` / `"… restocked"`,
  `workstream='stock'`, `surface` = product_title, `metric='purchasable'`,
  `status` = `'oos'|'restock'`, `raw` = `{sku, product_code, direction, qty_before, qty_after}`.

### Pipeline (odoops)
1. **`syncInventorySnapshot(env)`** — one `scheduled()` step (daily, alongside the existing conversion +
   change-events steps). Pull all variants → upsert today's `inventory_snapshot` rows.
2. **Diff** — compare today's `purchasable` vs the most recent prior snapshot per `sku`
   (`recompute_stock_events` RPC or inline): a flip emits a `change_events` (`stream='stock'`) upsert
   (`ON CONFLICT(id)` — idempotent). First-ever snapshot day emits nothing (no prior state).
3. Manual trigger **`syncInventorySnapshotNow`** (super-admin) for testing.

### UI (`/funnel` Daily-history)
- Chart: stock flips render as a **distinct marker** (blue) vs the amber website-change markers.
  Tooltip on a marked day rolls up: "N SKUs OOS · M restocked" + the list.
- The existing "Website changes in range" list gains a sibling **"Stock changes in range"** list
  (or a `stream` filter toggle), reusing the same row layout.

## Layer (d) — attribution / driver library

### Definition (heuristic, correlation-not-causation — labeled in UI)
- **Notable day** = a day whose CR deviates from its trailing-7-day average by more than a threshold
  (default **±15% relative**, tunable via `sales.settings` key `cr_notable_pct`).
- **Nearby events** = `change_events` (both streams) within **±2 days** (`cr_driver_window_days`, tunable).
- **Measured impact** of an event = `avg(CR over the 3 days AFTER) − avg(CR over the 3 days BEFORE)`
  in percentage points (`cr_impact_window_days`, default 3). Uses `conversion_snapshot` (the frozen
  audit funnel), sessions-weighted CR.

### Contract
- **`sales.f_conversion_drivers(p_from date, p_to date)`** → rows:
  `the_date, cr, cr_avg7, cr_deviation_pct, is_notable, event_id, event_stream, event_title,
   event_date, day_gap, impact_pp`. One row per (notable-day × nearby-event); plus a mode to return
   ALL events with their `impact_pp` for the library view (`p_from`/`p_to` over events). Implemented as
   set-returning SQL over `conversion_snapshot` ⋈ `change_events` (no per-row worker loops).
- Worker GET **`getConversionDrivers({from,to})`** → `{ days:[…notable days with nested drivers…],
  library:[…all events + impact…] }`.

### UI (`/funnel` Daily-history)
- **"Likely drivers"** panel: notable days listed; expanding a day shows its ranked nearby events,
  each with its `±X.X pp` CR effect (green up / red down) + a proximity tag ("same day", "+1d").
- The same data, filtered to all events sorted by |impact|, is the browsable **driver library**
  (toggle on the panel). A one-line caveat: "Heuristic time-proximity — correlation, not proof."

## Settings
New `sales.settings` keys (admin-tunable, ride in `getBootstrap`): `cr_notable_pct` (15),
`cr_driver_window_days` (2), `cr_impact_window_days` (3). Follow the existing `drr_window_days` pattern.

## Migrations
- `odo_inventory_snapshot_v1` — `sales.inventory_snapshot` + grants/RLS.
- `odo_conversion_drivers_v1` — `f_conversion_drivers` + the 3 settings rows + (if not RPC-side)
  `recompute_stock_events` helper.

## Out of scope / follow-ups
- Days-of-cover / stock-on-hand analytics (snapshot seeds it; separate build).
- Multi-location inventory breakdown (we use total `inventoryQuantity`).
- Statistical attribution (regression / causal) — v1 is proximity + naive pre/post.
- Backfilling stock history (no Shopify API for it).
- Extending the stream to marketplace stock (native Shopify only for now).

## Gates
- Shopify app may need the **`read_inventory`** scope (verify at build; `read_products` likely already
  present for orders). If missing, add scope + re-mint token.
