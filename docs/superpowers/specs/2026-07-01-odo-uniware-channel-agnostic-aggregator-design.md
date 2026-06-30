# Odo — Uniware channel-agnostic aggregator (design)

> 2026-07-01 (S187). Replaces the per-channel `uniware` connector model with a single
> aggregator that pulls Uniware sale orders once per window and fans them out to the
> member channels. Fixes the budget-starvation deadlock that froze CRED at 2026-04-22
> and Flipkart at 2026-04-27.

## Problem

The `uniware` adapter ran **once per channel** (CRED / FLIPKART / FIRSTCRY), each calling
`oms/saleOrder/search` with `channel: '<CHAN>'`. Empirically, Uniware does **not** honour
that `channel` value as a server-side filter — the search returns **all channels'** orders
(the adapter even type-guards the result for exactly this reason). Consequences:

- A dense back-history window (e.g. Apr 2026, ~300+ all-channel orders/day) needs ~45
  search pages just to scan, exhausting the 50-subrequest budget **before** the per-order
  `get` calls. The run ends `partial` having processed only the boundary order(s), and the
  cursor never advances → the connector re-walks the same window forever.
- Confirmed live: CRED cursor frozen at `2026-04-22T14:13:33`, Flipkart at `2026-04-27`,
  every cron tick `partial` at ~43–49 subreqs. FIRSTCRY escaped only because its cursor had
  already reached the cheap live edge (few all-channel orders in the trailing window).
- 3× redundant work: three connectors each re-page the **same** all-channels result set.

A late-June CRED sale (~₹4.3L, `cred-knox-*`) therefore never reached Odo.

## Design — one aggregator, fan out by the order's own channel

A single **aggregator connector** owns the Uniware pull and a single cursor. It pulls each
UPDATED window **once** (no channel filter), keeps only orders whose `channel` is in an
**allow-list** of member channels, fetches their details, and stages each to the **correct
member `channel_id`**. The member channels remain the fact targets; they are no longer run
independently.

### Why allow-list, not "stage everything"

Uniware also hosts channels Odo must **never** ingest from it — `LEGEND_OF_TOYS` (= Shopify,
owned by the direct `shopify` connector), `AMAZON` (direct SP-API), and the QC channels.
Staging those here would double-count. The allow-list = the set of member channels.

### Components

1. **Synthetic aggregator channel** `Uniware` — a `public.dispatch_channels` row,
   `is_sale=false` / `type='other'` / `fulfillment_model='unit'` (mirrors the marketing
   synthetic channels `…a1..a9`). Invisible to sales rollups (`getBootstrap` filters
   `is_sale=true`); appears only on the Connectors page. Id `…0000000000b1`.

2. **`uniware_agg` connector_config** on that channel — `enabled=true`, owns the cursor,
   `config = { backfill_start, window_days, max_gets }`. The **only** Uniware thing the cron
   producer spawns.

3. **Member rows** (CRED / FLIPKART / FIRSTCRY) — keep `adapter_kind='uniware'`,
   `enabled=true`, `config.uniware_channel`. They are now:
   - the **membership + map source** (the aggregator reads all `adapter_kind=uniware` rows →
     `{ UNIWARE_CHANNEL_UPPER → channel_id }`),
   - the **fact targets** (`recompute_facts` runs per member),
   - **status carriers** (the aggregator stamps each member's `last_ok_at` after feeding it →
     the Connectors page shows each channel Active + fresh).
   The cron **producer skips `adapter_kind='uniware'`** rows (fed by the aggregator, not run
   independently). Their old per-channel cursor becomes vestigial.

4. **No-op `uniware` adapter** — registered so a stray manual refresh / in-flight member
   workflow doesn't crash on an unknown adapter; returns empty / `partial:false`. This also
   gracefully ends any member ConnectorWorkflow instances already in flight at deploy time.

### Fetch — robust forward walk (volume-proof, no pinning)

`uniware_agg.fetch({ env, cursor, config, budget })`:

- Build the member map (1 cheap query). Token (1 subreq).
- Walk forward in UPDATED windows from the cursor (`window_days`, default 7). For each window:
  - **Adaptive shrink:** page `saleOrder/search` (no channel filter) collecting member order
    codes. If the window has more pages than the scan budget allows, **halve the window**
    (floor 1 day) and retry from the same `winStart`. Guarantees the window is fully scanned
    within budget regardless of total order volume → the cursor can always advance by a fully
    covered window. (Uniware also times out a >14-day search, so windows stay bounded anyway.)
  - **Skip-empty:** a window with no member orders advances `winStart` cheaply (search only),
    up to `MAX_WINDOWS` per run — so back-history with no CRED/Flipkart activity isn't crawled
    one-window-per-tick.
  - **Get + tag:** for the first window with member orders, `get` each (UPDATED-ascending,
    budget-bounded), map via `uniMapOrder`, tag every line + order with its member `channel_id`,
    record `byChannel[channel_id] += sale_dates`.
  - **Cursor:** fully drained window → `cursorAfter = winEnd`. Budget-bounded mid-window (more
    member orders than fit, e.g. the CRED spike day) → `cursorAfter = last gotten order's
    UPDATED` (≥ winStart; +1ms safety bump if equal) so the next run resumes at the next member,
    never re-pinning. Staging is idempotent (`on_conflict=source_line_id`), so re-scanning a
    boundary is safe.
- Returns `{ rows, orderRows, cursorAfter, subreqs, partial, byChannel }`, rows/orderRows each
  carrying `_channel_id`.

The ConnectorWorkflow already loops `step.do()` windows until `partial=false`, each step a fresh
50-subreq budget — so a multi-window catch-up self-drains across steps/ticks.

### Stage + recompute — per member channel

- `uniware_agg.stage(rows, runId, _aggId, fetched)` groups `rows` by `_channel_id` → inserts
  `stg_uniware` per member channel; groups `fetched.orderRows` by `_channel_id` →
  `stageOrders(group, runId, channel_id)` each.
- `uniware_agg.recompute({ runId, fetched })` iterates `fetched.byChannel`: per member,
  `resolveSkus(member, dates, 'stg_uniware')` + `recompute_facts(member, dates, runId)`, and
  stamps the member's `last_ok_at`. Returns aggregated `{ mapped, unmapped, factsUpserted }`.
- One additive framework change: `executeRun` passes `fetched` into `adapter.recompute({…})`
  (existing recompute adapters ignore the extra key).

### Idempotency / no double-count

The aggregator writes the **same** `stg_uniware` rows the per-channel adapter used
(`on_conflict=source_line_id`) and `recompute_facts` deletes+reinserts per (channel, date).
Re-walking Apr 17–22 (already 9 CRED facts) reproduces them exactly. No new fact grain.

## Migration / rollout

1. Insert the synthetic `Uniware` channel + `uniware_agg` connector_config, `cursor` = the
   **earliest member cursor** (`2026-04-22`, CRED) so it catches up CRED + Flipkart from there.
2. Members untouched (stay enabled → Active in UI; producer skips them by adapter_kind).
3. Deploy odoops. In-flight member workflows hit the no-op adapter next step and end.
4. The aggregator backfills Apr 22 → now over a few cron ticks, pulling the late-June CRED
   spike + the stuck Flipkart window. Steady-state it sits at the cheap live edge like FIRSTCRY.

**Rollback:** disable the `uniware_agg` connector + re-enable per-channel pulls (revert the
producer skip). Adapters/`stg_uniware`/facts are unchanged in shape, so no data migration.

## Out of scope / follow-ups

- **Uniware as the QC feed** (INSTAMART/ZEPTO/BLINKIT also live in this Uniware account) — a
  later option to replace the brittle Google-Sheet QC connectors. Separate item.
- Returns (`row_kind='return'`) from Uniware — still the existing fast-follow (v1 = sales +
  cancellations).
- Extreme single-timestamp bulk (>~40 member orders sharing an exact UPDATED ms) relies on the
  +1ms safety bump; essentially never in real data.
