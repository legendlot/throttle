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
  captured_at    timestamptz  -- date_trunc('hour', now()) in TRUE UTC (§8 finding 4)
  channel_id     uuid         -- → public.dispatch_channels.id, NOT NULL
  sku            text
  product_code   text         -- null when unmapped
  product_title  text
  available_qty  int4
  purchasable    bool
  pull_complete  bool         -- false ⇒ forensics only; never feeds status/events/alerts
  PRIMARY KEY (captured_at, channel_id, sku)

INDEX ON (channel_id, sku, captured_at DESC)   -- "latest per SKU" support
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
| `gone` | SKU absent from the most recent **complete** pull — excluded from watch + alerts |

`<threshold>` = `sales.settings` key **`inv_low_stock_qty`**, default `'10'`, same
key/value text mechanism as the existing `cr_notable_pct` / `cr_driver_window_days`
tunables. Global in v1; tunable without a deploy. Cast defensively —
`coalesce(nullif(regexp_replace(value,'\D','','g'),'')::int, 10)` — so a bad edit degrades
to the default instead of breaking every query (§8 finding 8).

**Accepted tradeoff on the flat threshold:** 10 units is about a week of cover for a slow
SKU and half a day for a fast one, so the low list over-warns on the tail and under-warns
on movers. Correct fix is days-of-cover, which is deferred; keeping the number in settings
means revisiting costs no deploy.

`unbuyable` is deliberately separate from the qty ladder: a SKU can hold 300 units and
still be unbuyable (product archived/draft), and that is a different problem from being
out of stock. Both surface; neither masks the other.

**"Since"** — for each SKU, the start of the current unbroken run of the same status. This
is what makes the watch list actionable ("OOS for 6 hours" and "OOS for 9 days" are
different conversations). Computed set-based via `lag()` over readings ordered by time —
**by value change, not by consecutive hours present**, so a missed cron tick is not read
as a flip (§8 finding 6).

To stop `since` lying on day one, `inventory_reading` is **seeded from the existing 20
days of `inventory_snapshot`** (one synthetic reading per SKU per day at its `captured_at`,
`pull_complete=true`), so durations are truthful from the first hour (§8 finding 5).

## 4. Noise filter — the thing that decides whether this page is usable

Measured 2026-07-20: the pull returns **252 variants of which only 67 are mapped (27%)**;
the rest are retired SKUs and Creator-Shipment artefacts. A raw table is three-quarters
junk. On the mapped set the watch list is a workable ~24 OOS + ~8 low.

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
  the prior state, and qty either side. Sourced from `inventory_reading` transitions.

  The `/funnel` `change_events` markers are derived from the **same** transitions after
  this change, so the two agree on mapped SKUs at day grain. They will still legitimately
  differ in two ways, and the UI should not pretend otherwise: `change_events` covers
  mapped SKUs only, and it is day-grain, so multiple same-day flips collapse to one marker
  there while appearing individually here.

**History-horizon honesty.** The chart must state its own limits inline, not in a doc:
hourly data begins at deploy day; daily data begins ~2026-07-01 (S189); **nothing exists
before that and nothing can — Shopify has no historical inventory API.** Render the
pre-history region as explicitly empty, never as a flat line at zero.

## 6. Worker + RPCs

Two GET actions on `odoops`, each a thin wrapper over one set-based RPC (no per-row
awaits, per the standing batching rule):

- `getInventoryStatus` → `sales.f_inventory_status(p_channels uuid[], p_include_unmapped bool)`
  — latest **complete** reading per (channel, sku), status ladder applied, `since` and
  `gone` derived by window function, threshold read from `sales.settings`.
- `getInventoryHistory` → `sales.f_inventory_history(p_sku text, p_product_code text, p_from date, p_to date)`
  — readings series + derived flip events for one SKU or one family.

Both `sales_view`-gated. PostgREST returns numerics as strings — wrap in `Number()` at
the app boundary.

**`recompute_stock_events` is rewritten** to derive from `inventory_reading` transitions
rather than day-vs-day snapshots, and to become **authoritative for its date**: it deletes
that date's superseded `stream='stock'` rows before reinserting, so a same-day
dip-then-restock nets out instead of leaving a permanent false `oos` marker. Output
contract (`sales.change_events`, `stream='stock'`, `id='stock:<sku>:<date>:<dir>'`) is
unchanged, so `/funnel` needs no change. This also retroactively corrects the 18 bad
events on re-run.

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

## 7b. Slack alerting (future consumer — shapes v1)

Afshaan wants Slack alerts on OOS and restock. Not built in v1, but it changes v1's
design, because an alert channel punishes false positives far harder than a page does:
a wrong row on a table is ignored, a wrong 3am ping gets the channel muted.

**Seam: `sales.stock_alert_outbox`.** Confirmed flips are written here with
`status='pending'`; a future sender drains it and marks `sent`. Detection and
announcement are separate concerns — so the correctness work below happens once, in the
detector, and turning Slack on later is a sender, not a redesign.

**Confirm-window.** A flip becomes alertable only after it persists across **2
consecutive complete readings**. This is the single highest-value rule in the design: it
eliminates the intra-day-dip false-positive class outright (see §8 finding 1). The page
may show the unconfirmed state immediately; only the outbox waits.

**Suppression.** Nothing is enqueued from an incomplete pull, from an unmapped SKU, or
for a SKU transitioning to/from `gone`.

## 8. Pre-mortem — measured failure modes

Run against live data 2026-07-20. Two of these are **already happening in production**.

**1. False OOS events from intra-day dips — LIVE BUG, 18 of 93 events (19%) are wrong.**
`recompute_stock_events` runs hourly and compares today's (repeatedly overwritten) row
against the most recent prior day, keying events `stock:<sku>:<date>:<dir>`. An intra-day
dip writes an `oos` event; when the SKU restocks later the same day there is no flip
versus yesterday, so nothing corrects it and the row is never deleted. Verified: 18 `oos`
events sit on dates whose end-of-day snapshot was `purchasable`. These markers are wrong
on `/funnel` today. **Wired to Slack unchanged, ~1 in 5 OOS pings would be false.**
→ Fix: derive events from reading *transitions*; the recompute becomes authoritative for
its date and deletes superseded events rather than only upserting.

**2. Vanished SKUs go stale forever — LIVE, 5 mapped SKUs already affected.** SKU count
moved 204→255→251 and mapped 71→67 over 20 days. A SKU that stops appearing in the pull
keeps its last reading, so a "latest reading per SKU" query shows it indefinitely at its
last known quantity. → Fix: `last_seen_at` per SKU; absent from a *complete* pull is
status `gone`, excluded from the watch list and never alertable.

**3. Partial pull reads as a mass stockout.** The walk is capped at 8 pages and can be cut
short by a 401 or timeout. Every missing SKU would look OOS at once — a page full of
phantom stockouts and, later, an alert storm. → Fix: `pull_complete` boolean stamped on
every reading batch (true only when `hasNextPage` is false and no page errored). Readings
from an incomplete pull are stored for forensics but never feed status, events, or alerts.

**4. IST timestamps stored as UTC.** Existing code derives its date via
`new Date(Date.now() + 5.5*3600*1000).toISOString().slice(0,10)` — correct for a *date*,
but reusing that shifted value for a `timestamptz` lands every reading 5.5 hours in the
future and silently corrupts every duration. → Fix: `captured_at` is true UTC `now()`;
IST conversion happens at display only, per the standing convention.

**5. "Since" is a lie on day one.** A window function over `inventory_reading` alone can
only see back to deploy, so a SKU out of stock for three weeks reads "OOS for 1 hour".
That destroys trust in the first hour of use. → Fix: seed `inventory_reading` from the 20
days of existing `inventory_snapshot` rows (one synthetic reading per SKU per day at its
`captured_at`), so `since` is truthful immediately.

**6. Cron gaps become phantom flips.** A missed hour is not a state change. → Fix: derive
both `since` and flips from *value changes ordered by time* (`lag()` over readings),
never from "consecutive hours present".

**7. Noise buries the page — worse than first estimated.** Live: **67 of 252 SKUs are
mapped (27%)**, not the ~71/204 assumed. Three-quarters of a raw table is retired SKUs and
Creator-Shipment artefacts. → Fix: mapped-only default (§4).

**8. Threshold cast breaks the page.** `sales.settings.value` is `text`; one edit to
`"ten"` takes down every inventory query. → Fix:
`coalesce(nullif(regexp_replace(value,'\D','','g'),'')::int, 10)`.

**9. Null `channel_id` violates the PK.** The Website channel is resolved from
`connector_config`; if that lookup returns nothing, rows would carry null. → Fix: resolve
once up front and hard-fail the sync with a named error rather than writing junk.

**10. Unbounded growth and slow reads.** 252 SKUs × 24h × 365 ≈ 2.2M rows/year, and
"latest reading per SKU" degrades without support. → Fix: index
`(channel_id, sku, captured_at DESC)`; prune hourly readings older than 90 days in a
once-daily cron step; `inventory_snapshot` dailies kept forever.

## 8b. Residual risks accepted

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

1. Migration: `inventory_reading` (+ index) · `stock_alert_outbox` · `inv_low_stock_qty`
   setting · seed readings from the 20 days of `inventory_snapshot`.
2. RPCs: `f_inventory_status` · `f_inventory_history` · rewritten `recompute_stock_events`
   (self-correcting) · `prune_inventory_readings`.
3. `syncInventorySnapshot()` dual-write with `pull_complete` + channel guard (ship early —
   starts accumulating real hourly history immediately).
4. Worker actions `getInventoryStatus` / `getInventoryHistory`; nightly prune step;
   register with `getFreshness`.
5. `/inventory` page — Watch, then History.
6. **Later:** Slack sender draining `stock_alert_outbox` (§7b).
7. **Later:** Amazon adapter, once the definition lands (§7).

## 10. Verification

- `recompute_stock_events` re-run clears the 18 known-false `oos` events; spot-check that
  no event survives on a date whose end-of-day snapshot was `purchasable`.
- The 5 vanished mapped SKUs resolve to `gone`, not to a stale quantity.
- `since` on a long-OOS SKU reads in days (from seeded history), not "1 hour".
- A simulated incomplete pull writes readings but moves no status and enqueues no alert.
- `captured_at` of a fresh reading equals wall-clock UTC, not UTC+5:30.
