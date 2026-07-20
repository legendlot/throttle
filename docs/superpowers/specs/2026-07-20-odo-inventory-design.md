# Odo — Inventory tab (design)
> Date: 2026-07-20 · System: Odo (`apps/odo` + `odoops-worker` + `sales` schema)
> Status: DESIGN — not yet planned or built
> Decided with Afshaan, S223. Supersedes nothing; extends the S189 stock stream.

## Purpose

One `Inventory` tab in Odo answering two questions, and only two:

1. **Availability watch** — what is out of stock, or under 10 units, right now; on which
   channel; and how long has it been that way.
2. **History audit** — what was this SKU's stock level over time, and when did it flip
   in or out of stock.

**Explicitly NOT in v1** (each deferred by decision, not oversight):
- Days-of-cover / replenishment planning (no join to sell-rate).
- Cross-system reconciliation against Garage / Depot / `stock_ledger`. Odo reads the
  *channel's* view of stock; the factory's view stays in Garage.
- The on-hand ÷ committed ÷ incoming breakdown. One net number per SKU is enough for
  availability; the breakdown belongs to the deferred position/reconciliation job.
- **Amazon.** Shopify ships first. Amazon is a seam here, not a build — see §7.

## 1. What already exists

`sales.inventory_snapshot` has been live since S189 as an input stream for `/funnel`,
and **no screen reads it**:

```
inventory_snapshot: the_date date, sku text, product_code text, product_title text,
                    available_qty int4, purchasable bool, captured_at timestamptz
                    -- PK (the_date, sku)
```

Written by `syncInventorySnapshot()` in `odoops-worker/src/index.js`, which pages the
Shopify Admin GraphQL `productVariants` connection (≤8 pages × 250) and derives
`purchasable = ACTIVE ∧ (untracked ∨ policy=CONTINUE ∨ qty > 0)`. It then calls
`recompute_stock_events(date)`, which diffs against the SKU's prior snapshot and writes
oos/restock rows into `sales.change_events` with `stream='stock'` — the amber/blue
markers on the `/funnel` daily-history chart.

**The finding that shapes this design:** `syncInventorySnapshot()` is already called on
**every hourly cron tick** (`src/index.js:2860`), but it upserts on `(the_date, sku)`, so
each hour silently overwrites the same day's row and only the last write of the day
survives. We are already paying for hourly data and throwing 23/24 of it away. Moving to
hourly fidelity is therefore a **storage-grain change with zero new API cost** — no extra
Shopify calls, no new scopes, no rate-limit exposure.

## 2. Capture layer

Add a reading-grain table alongside the existing daily one. Do not repoint or migrate
`inventory_snapshot` — `/funnel`, `recompute_stock_events`, and the `change_events`
markers keep working untouched.

```sql
sales.inventory_reading:
  captured_hour  timestamptz  -- date_trunc('hour', now() at IST)
  channel_id     uuid         -- → public.dispatch_channels.id
  sku            text
  product_code   text         -- null when unmapped
  product_title  text
  available_qty  int4
  purchasable    bool
  PRIMARY KEY (captured_hour, channel_id, sku)
```

- **`channel_id` from day one.** This is the Amazon seam. Amazon's adapter later writes
  rows with its own `channel_id` and its own `purchasable` semantics, and every RPC and
  screen below already groups by channel. No migration when Amazon lands.
- `syncInventorySnapshot()` writes **both** tables from the one fetch: the hourly reading
  row, then the existing daily upsert unchanged (last-write-wins per day is already the
  live behaviour, so the daily row keeps its exact current meaning as "end-of-day state").
- RLS on, `service_role` only, per RULE-RLS-001.
- **Retention:** hourly rows pruned at 90 days by a step in the existing nightly cron;
  the daily `inventory_snapshot` is kept forever. Volume at current catalogue size is
  ~204 SKUs × 24 = ~4.9k rows/day (~1.8M/year uncapped), so 90 days ≈ 440k rows.

## 3. Status definition

Per SKU, per channel, evaluated on the latest reading:

| Status | Rule |
|---|---|
| `oos` | `available_qty <= 0` |
| `low` | `available_qty > 0 AND available_qty < <threshold>` |
| `ok` | `available_qty >= <threshold>` |
| `unbuyable` | `purchasable = false` — orthogonal flag, shown alongside the qty status |

`<threshold>` = `sales.settings` key **`inv_low_stock_qty`**, default `'10'`, same
key/value text mechanism as the existing `cr_notable_pct` / `cr_driver_window_days`
tunables. Global in v1; tunable without a deploy.

`unbuyable` is deliberately separate from the qty ladder: a SKU can hold 300 units and
still be unbuyable (product archived/draft), and that is a different problem from being
out of stock. Both surface; neither masks the other.

**"Since"** — for each SKU, the timestamp of the oldest consecutive reading carrying the
current status. This is what makes the watch list actionable ("OOS for 6 hours" vs "OOS
for 9 days" are different conversations). Computed set-based in the RPC via a window
function over `inventory_reading`, not per-row in the Worker.

## 4. Noise filter — the thing that decides whether this page is usable

The live pull returns ~204 variants of which only ~71 are real catalogue; the rest are
retired SKUs and Creator-Shipment artefacts. A raw table is two-thirds junk.

**Default view = mapped SKUs only** — those carrying a `sku_map` entry for the channel,
so they have a `product_code`. A `Show all SKUs` toggle reveals the rest, with unmapped
rows badged and linking to `/mapping`.

The filter is mapping, **not** product status. Filtering on ACTIVE would hide exactly the
`unbuyable` rows the watch list exists to surface — an archived product still holding 300
units is the case you most need to see.

Unmapped SKUs are shown rather than hidden because they are still real stock, and a
newly-launched SKU is unmapped precisely when someone most wants to watch it. But they
must not be the default, or the watch list is unreadable.

Note the asymmetry with the existing stock **events**, which fire only for mapped SKUs
(`odo_stock_events_mapped_only_v2`). That stays as-is — `/funnel` overlays should not be
polluted by retired-SKU flips. The Inventory tab is the surface where you can go look at
the unmapped ones on purpose.

## 5. Screen — `/inventory`

New route in `apps/odo`, nav item **Inventory**, gated on `sales_view`. Follows the
existing kit (`components/kit.js`): `RangePicker` sticky header, `useTableSort` /
`SortHeader`, `.so-page` gutter, `--mono` for numerals, `.so-table th.so-num` right-align,
MTD default range. Registered with `getFreshness` so the shell's "Data as of…" chip covers
it.

**`Watch` tab (default) — current state, range-independent.**
- KPI row: SKUs out of stock · SKUs low · SKUs unbuyable · total units on hand ·
  **OOS SKU-hours** over the selected range (the one metric that quantifies the cost of
  stockouts without pulling in velocity modelling).
- Table: rows = product family, expandable to SKUs — the same shape as `/products/drr`,
  so the page reads like the rest of Odo. Columns: SKU · title · channel · qty · status
  chip · unbuyable flag · since · last flip. Filter chips All / OOS / Low / Unbuyable.
- Channel column carries one value (Website) in v1 and becomes meaningful with Amazon.

**`History` tab — one SKU or family over the selected range.**
- Line chart of `available_qty` over time, with OOS periods shaded. Hourly resolution
  where hourly readings exist, daily before that.
- Flip table beneath: went-OOS / restocked / went-low events with timestamp, duration in
  the prior state, and qty either side. Sourced from `inventory_reading` transitions,
  cross-referenced to the `change_events` `stream='stock'` rows so the `/funnel` markers
  and this table can never tell different stories.

**History-horizon honesty.** The chart must state its own limits inline, not in a doc:
hourly data begins at deploy day; daily data begins ~2026-07-01 (S189); **nothing exists
before that and nothing can — Shopify has no historical inventory API.** Render the
pre-history region as explicitly empty, never as a flat line at zero.

## 6. Worker + RPCs

Two GET actions on `odoops`, each a thin wrapper over one set-based RPC (no per-row
awaits, per the standing batching rule):

- `getInventoryStatus` → `sales.f_inventory_status(p_channels uuid[], p_include_unmapped bool)`
  — latest reading per (channel, sku), status ladder applied, `since` via window function,
  threshold read from `sales.settings`.
- `getInventoryHistory` → `sales.f_inventory_history(p_sku text, p_product_code text, p_from date, p_to date)`
  — readings series + derived flip events for one SKU or one family.

Both `sales_view`-gated. PostgREST returns numerics as strings — wrap in `Number()` at
the app boundary.

## 7. Amazon seam (definition pending — Afshaan)

Nothing Amazon-specific is built in v1. What v1 guarantees is that adding it is an
adapter, not a redesign: `inventory_reading` is channel-keyed, both RPCs take a channel
filter, and the screen groups by channel.

When the definition lands, the open choice is between:
- **FBA fulfillable qty** — `GET /fba/inventory/v1/summaries` for live state plus
  `GET_LEDGER_SUMMARY_VIEW_DATA` for history. Notably this gives **real daily history up
  to 18 months back**, so unlike Shopify, Amazon can be backfilled.
- **Listing buyability** — closer to true lost sales (catches suppressed/inactive
  listings and buy-box loss) but has no historical equivalent, so it would be
  forward-only like Shopify.

These are not mutually exclusive; fulfillable qty is the natural spine because it is the
one that backfills, with listing health layered on the live view. Deferred pending
Afshaan's definition.

## 8. Risks and known traps

- **Forward-only history is permanent, not a v1 shortcut.** Shopify exposes no historical
  inventory endpoint. If the team wants a longer baseline, the only lever is starting
  capture sooner — which is an argument for shipping the hourly table ahead of the UI.
- **Noise dominates without the mapped-SKU default** (§4). Getting this wrong is the most
  likely way the page goes unused.
- **Do not let the Inventory tab drift into a second stock system of record.** Garage's
  `stock_ledger` is the factory truth; this is the *channel's* view. When the two disagree
  that is a finding, not a bug to reconcile here.
- Hourly retention must be pruned or the table grows unbounded.
- `syncInventorySnapshot()` must keep writing the daily row with identical semantics, or
  the `/funnel` stock markers silently change meaning.

## 9. Build order

1. Migration: `inventory_reading` + `inv_low_stock_qty` setting + prune step.
2. `syncInventorySnapshot()` dual-write (ship early — starts accumulating history).
3. RPCs `f_inventory_status` / `f_inventory_history`.
4. Worker actions.
5. `/inventory` page — Watch, then History.
6. Amazon adapter, once the definition lands.
