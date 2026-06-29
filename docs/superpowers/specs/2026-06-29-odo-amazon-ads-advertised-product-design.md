# Odo — Amazon Ads P2: advertised-product → SKU/model ROAS·ACOS·organic

> Design spec. Session S185 (2026-06-29). Author: Afshaan + Claude.
> Backlog: `[odo] [P1] Nikhil's Amazon power-user metrics suite` — P2 (ASIN-level ads), advertised-product slice only.
> Scope locked in brainstorming: **advertised-product report only**. Search-term + alt-purchase deferred to their own specs.

## Problem

The `/amazon` cockpit (`apps/odo/src/components/AmazonPage.js`) shows ad metrics (ROAS / ACOS /
TACOS / CTR / CPC / conversion / organic) at the **Amazon-account level only** — they come from the
single `amazon` row of `getMarketing(group='platform')`, which sums the existing campaign-grain
`mkt_fact`. There is **no product / ASIN / SKU dimension** anywhere in the ad data, so the cockpit
cannot answer Nikhil's core P2 ask: *which SKUs / models are profitable on ads* (per-product ROAS,
ACOS, TACOS, organic share).

The cockpit already has a **Model ⇄ SKU top-sellers toggle table** at exactly the grain we need
(`product_code`, rolled up to product family via the `c2p` map). The job is to produce ad data at
`product_code` grain and join it onto that table.

## What exists today (the pattern we extend)

- **`amazon_ads` adapter** (`odoops-worker/src/index.js` ~L845): Advertising API v3 async reporting.
  Pulls the `spCampaigns` report (`groupBy:['campaign']`, columns `date/campaignId/campaignName/
  impressions/clicks/cost/purchases14d/sales14d`) via a create→poll→download state machine carried
  across cron ticks in `connector_config.config` (`pending_report_id`, `pending_through`, `profile_id`,
  `region_host`). Stages into `sales.stg_amazon_ads`; `recompute_amzn_ads` → `sales.mkt_fact`
  (grain `the_date × platform × ad_account_id × campaign_id`, platform=`amazon`).
- Helpers reused: `getAmazonAdsToken(env)` (LWA refresh-token, EU host), profile discovery (India
  profile `202246193452230`, cached in config), `createAdsReport(host, H, adProduct, reportTypeId,
  startDate, endDate)`, `AMZ_ADS_WINDOW_MS` (30-day windows), `patchConnectorConfig`.
- **Per-connector Workflow isolation (S169):** the hourly cron spawns one `ConnectorWorkflow` instance
  per enabled connector; each gets its own 50-subreq budget per `step.do()`. So a new connector with a
  multi-month backfill self-drains in its own instance without starving anyone.
- **`getBootstrap` returns `is_sale=true` channels only** — an `is_sale=false` synthetic channel is
  invisible in the sales UI (this is why the existing `…a3` "Amazon Ads" channel never leaks into the
  cockpit's sub-channel bands).
- **Amazon-FBA sales channel** `855de0ca-9498-4d5a-90f3-3a370a228762` carries a **150-row curated
  `sku_map`** (seller SKU → `product_code`). The advertised-product report's `advertisedSku` IS that
  same seller SKU → reuse this map directly (no new mapping surface).

## Approach (Option A — approved)

A **new adapter `amazon_ads_product`** on a **new synthetic `is_sale=false` channel**
("Amazon Ads — Products"), reusing the Advertising-API helpers. Own report state-machine, own cursor,
own per-connector Workflow instance — fully isolated from the live campaign connector and invisible in
the sales UI. (Rejected: extending the existing `amazon_ads` adapter to run two report streams in one
channel — more tangled state, shared Workflow budget, risk to the working campaign connector.)

`mkt_fact` is **not** touched (it stays campaign-grain so the account-level strip is unaffected); the
product-grain data lands in a new parallel fact `mkt_product_fact`.

## Data flow

```
spAdvertisedProduct report (v3, groupBy=['advertiser'])
  → stg_amazon_ads_product (channel × date × campaign × advertised_sku × advertised_asin)
  → recompute_amzn_ads_product  (resolve advertised_sku→product_code via Amazon-FBA sku_map; sum to product grain)
  → mkt_product_fact (the_date × platform × product_code)
  → f_mkt_product_rollup → worker getAdProduct → /amazon sellers table columns
```

## Data model

### `sales.stg_amazon_ads_product` (NEW)
Raw advertised-product report rows, superseded by date-range (no stable source line id), mirroring
`stg_amazon_ads`.

| column | type | note |
|---|---|---|
| `id` | bigint identity PK | |
| `run_id` | bigint | |
| `channel_id` | uuid | the synthetic ads-product channel |
| `ad_account_id` | text | profile id |
| `campaign_id` | text | |
| `campaign_name` | text | |
| `advertised_sku` | text | seller SKU (maps to product_code) |
| `advertised_asin` | text | kept for future ASIN resolution |
| `the_date` | date | report `date` |
| `spend` | numeric | report `cost` |
| `impressions` | bigint | |
| `clicks` | bigint | |
| `conversions` | numeric | `purchases14d` |
| `conv_value` | numeric | `sales14d` (ad-attributed sales) |
| `raw` | jsonb | full report row |
| `ingested_at` | timestamptz default now() | |

RLS on, `GRANT ALL … TO service_role`. Supersede on each window via
`DELETE … WHERE channel_id=… AND the_date BETWEEN from AND to` then insert (idempotent re-pull).

### `sales.mkt_product_fact` (NEW)
Product-grain marketing fact — the durable, idempotently-recomputed layer (control-station charter:
staging = full fidelity, fact = derived recompute).

| column | type | note |
|---|---|---|
| `the_date` | date | |
| `platform` | text | `'amazon'` (room for other ad platforms later) |
| `product_code` | text | resolved via sku_map; `''` (or a sentinel) for the unmapped-residual bucket |
| `spend` | numeric | |
| `impressions` | bigint | |
| `clicks` | bigint | |
| `conversions` | numeric | |
| `conv_value` | numeric | ad-attributed sales |
| `run_id` | bigint | |

**UNIQUE `(the_date, platform, product_code)`** = idempotency. RLS on, service_role-only.
Unmapped advertised SKUs roll into a single `product_code=''` residual row per (date, platform) so ad
spend is never silently dropped (the cockpit can surface "unmapped ad spend" if wanted; v1 just keeps
it out of per-product rows but countable).

### Mapping
`advertised_sku` → `product_code` via `sales.sku_map WHERE channel_id = '855de0ca-…'` (Amazon-FBA).
No new mapping UI; curating Amazon sales SKUs (existing `/mapping`) also fixes ad attribution.
ASIN-only rows (blank `advertised_sku`) → unmapped residual in v1 (ASIN→product_code resolution is a
documented fast-follow; SP advertised-product rows for own products carry `advertisedSku`).

## RPCs

### `sales.recompute_amzn_ads_product(p_channel uuid, p_dates date[], p_run_id bigint) → int`
Mirrors `recompute_amzn_ads`. For the given dates: delete `mkt_product_fact WHERE platform='amazon'
AND the_date = ANY(p_dates)`, then insert summed rows from `stg_amazon_ads_product` joined LEFT to the
Amazon-FBA `sku_map` (`COALESCE(map.product_code, '')` as `product_code`), grouped by
`(the_date, product_code)`. Returns rows upserted. Idempotent.

### `sales.f_mkt_product_rollup(p_from date, p_to date, p_platform text default null, p_product_code text default null) → table`
Returns `product_code, spend, impressions, clicks, conversions, conv_value` summed over the window
(optionally filtered by platform / product_code). `SECURITY DEFINER`, `EXECUTE TO service_role`.

## Worker (`odoops-worker/src/index.js`)

- **Generalize `createAdsReport`** is already parameterized by `adProduct`/`reportTypeId`; the new
  adapter passes `reportTypeId='spAdvertisedProduct'`, `groupBy:['advertiser']`, and an
  advertised-product column set. The report `configuration.groupBy` differs per report type, so
  factor `groupBy` into the call (small change) rather than the hardcoded `['campaign']`.
  - Column set to request (validate exact names against the API via a probe during build):
    `date, campaignId, campaignName, advertisedSku, advertisedAsin, impressions, clicks, cost,
    purchases14d, sales14d`.
- **`amazon_ads_product` adapter**: identical state machine to `amazon_ads` (profile discovery,
  pending-report poll, walk-forward windows, trailing-30d floor), differing only in report
  type/columns, the staging table, the mapped row shape (carries `advertised_sku`/`advertised_asin`),
  and `recompute → recompute_amzn_ads_product`. Register in `ADAPTERS`.
- **GET `getAdProduct`** (`from`, `to`, `platform?`) → `f_mkt_product_rollup` rows. `sales_view`-gated
  (same as `getMarketing`). Returns `{ rows: [{product_code, spend, impressions, clicks, conversions,
  conv_value}] }`.
- **Diagnostic `adProductProbe`** (`canConnector`-gated, mirrors `amazonPeek`): create + poll a small
  advertised-product report and return status + a sample of parsed rows — used during build to confirm
  the exact column names Amazon returns before wiring staging.
- **Config / channel setup (one-time, via SQL not code):** new synthetic channel row in
  `public.dispatch_channels` (`is_sale=false`, name "Amazon Ads — Products"); `connector_config` row
  (`adapter_kind='amazon_ads_product'`, `enabled=true`, `config={region_host, profile_id, ad_product:
  'SPONSORED_PRODUCTS', backfill_start}`). Reuse the same LWA secrets — no new secrets.

## UI (`apps/odo/src/components/AmazonPage.js`)

- Fetch `getAdProduct({from,to})` alongside the existing `Promise.all`; build `product_code → {spend,
  conv_value, clicks, impressions}` map.
- In `topByCode` (or a sibling step), aggregate ad metrics by the chosen rollup: SKU mode keys on
  `product_code`; Model mode sums ad metrics by `c2p[product_code]` (same family rollup the sales side
  uses) so each table row gets its spend + ad-sales.
- Extend the sellers table columns → `Model/SKU · Units · Gross · ASP · Spend · Ad Sales · ROAS ·
  ACOS · TACOS · Organic%`:
  - ROAS = adSales / spend
  - ACOS = spend / adSales (%)
  - TACOS = spend / rowGross (%)
  - Organic% = (rowGross − adSales) / rowGross
  - rows with `spend = 0` render ad columns as "—" (un-advertised products still show sales).
- Table may get wide → keep it inside the existing `overflow-x:auto` wrapper; consider a compact
  number format. No new page, no nav change.

## Semantics & edge cases

- **14-day attribution** (`purchases14d`/`sales14d`) — same basis as the campaign connector; steady
  state refreshes the trailing 30 days each tick.
- **Two sales bases, deliberately:** ROAS/ACOS use Amazon's **reported `sales14d`** (the ad platform's
  own attribution); TACOS/Organic use **`sales_fact` gross** (our sell-out). They come from different
  sources and won't reconcile exactly — this matches how the existing account-level strip already
  mixes `ad.conv_value` with `seg.grossAll`.
- **Idempotency** preserved end-to-end (supersede-by-date-range staging + delete/reinsert recompute on
  the UNIQUE grain).
- **Unmapped ad spend** is bucketed (`product_code=''`), never dropped.

## Out of scope (own specs / fast-follows)
Search-term report; alt-purchase analysis; ASIN-only (no-SKU) resolution; per-SKU RTO/RTV in the
sellers table; Sponsored Brands / Sponsored Display advertised-product reports; an "unmapped ad spend"
UI surface; model/SKU ROAS on Meta/Google (mkt_product_fact is platform-generic but only Amazon feeds
it in v1).

## Migrations
- `odo_amazon_ads_product_v1` — `stg_amazon_ads_product` + `mkt_product_fact` + grants + RLS +
  `recompute_amzn_ads_product` + `f_mkt_product_rollup`.
- Synthetic channel + connector_config rows seeded via SQL (not a migration — data, mirrors how the
  `…a3` ads channel was set up).

## Verification
1. `adProductProbe` confirms the exact advertised-product column names + India profile returns rows.
2. After a manual refresh: `stg_amazon_ads_product` populated; `recompute_amzn_ads_product` →
   `mkt_product_fact` rows; spot-check that summed product spend ≈ the campaign-connector account
   total for the same window (advertised-product is a finer cut of the same spend — should reconcile
   within rounding / report-timing).
3. `/amazon` sellers table shows the new columns with sane ROAS/ACOS for a known advertised SKU;
   un-advertised SKUs show "—"; Model toggle aggregates correctly.
4. Mapped-coverage check: unmapped-residual spend is a small fraction of total ad spend (high `sku_map`
   coverage expected since the 150-row Amazon map already covers sales).
