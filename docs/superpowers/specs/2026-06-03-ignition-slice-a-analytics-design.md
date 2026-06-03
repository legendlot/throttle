# Ignition Slice A — Tier Analytics + UGC Rollup + Identity Edit

> System: **Ignition** · Worker: **ignitionops** · Schema: **ignition** (no new tables)
> Date: 2026-06-03 · Status: approved design, pre-implementation
> Origin: Reann, #bugs 06-03 (1780484382.110299) — Ignition enhancement batch. This spec covers
> **Slice A only**: requests 1a–1d (metrics) + request 3 (editable identity). Requests 2 (growth
> history) and 4 (monthly targets/budgets) are deferred to later slices (own specs).

## 1. Scope

Read-side analytics expansion + one small edit affordance. **No schema changes, no new tables.**
All metrics derive from existing `ignition.engagements` joined to `ignition.influencers.influencer_type`.

Confirmed decisions:
- **"Category" = `influencer_type` tier** (nano/micro/macro/brand/store), NOT the `categories[]` niche field.
- Metrics live on **both** the Dashboard (headline tiles, all-time) and the Reports page (detailed
  breakdowns, date-range + CSV).
- Identity edit reuses the existing `updateInfluencer` worker action (no new write path).

## 2. Metric definitions (locked)

- **Tier "reach in terms of views"** = Σ engagement `views` per `influencer_type` (delivered views),
  NOT the influencers' static `reach` column.
- **Total engagement** = Σ `views`, Σ `likes`, Σ `shares` across engagements (labelled as
  "Views / Likes / Shares" in the UI to avoid collision with the deal-count sense of "engagement").
- **avg views / influencer (per tier)** = tier Σ views ÷ **count of distinct influencers active in the
  selected range for that tier** (active = appears on ≥1 engagement in range). Range-scoped on Reports.
- **UGC rollup** = engagements with `engagement_type='ugc'`: deals, Σ views, Σ likes,
  **budget_consumed = Σ spend** (the same all-in per-deal spend `getReports` already computes via
  `spendOf(e)` / `total_cost`), orders (Σ `orders`), conversions_value (Σ `conversions_value`).
- **Conversions** surfaced as BOTH `orders` (count) and `conversions_value` (₹).
- Dashboard tiles are **all-time** (no range); Reports figures honor the existing `from`/`to` range.

## 3. Worker (`ignitionops`, `05_Throttle/ignitionops-worker/src/index.js`)

Read-only changes; reuse existing helpers (`num`, `spendOf`, `roasOf`, the range-fetch in
`getReports`). Mind the 50-subrequest limit — all aggregation is in-JS over the single
already-fetched engagements array; at most one extra small query.

### 3a. Extend `getReports` (date-range honored)

In the existing per-engagement loop, also accumulate:
- `by_tier` — keyed by `influencer_type` (include all present tiers + an `untyped` bucket for null):
  `{ tier, deals, views, likes, shares, spend, orders, conversions_value, influencer_ids:Set,
     influencer_count, avg_views_per_influencer }`.
  `influencer_count` = `influencer_ids.size`; `avg_views_per_influencer` = `round(views / count)` (0 if none).
  Requires the engagements select to include `influencer:influencer_id(influencer_type)` (the
  reports fetch already joins influencer for `top_performers` — extend the embedded select to add
  `influencer_type`).
- `engagement_totals` — `{ views, likes, shares }` summed over the range.
- `ugc` — same accumulation filtered to `engagement_type='ugc'`:
  `{ deals, views, likes, budget_consumed, orders, conversions_value }`.

Add `by_tier` (array, sorted by views desc), `engagement_totals`, `ugc` to the `getReports` response
object alongside the existing `totals`/`by_month`/`by_product`/distributions/`top_performers`.

### 3b. Extend `getKpis` (Dashboard, all-time)

Add to its response:
- `engagement_totals` — `{ views, likes, shares }` across all engagements.
- `ugc_summary` — `{ deals, views, likes, budget_consumed, orders, conversions_value }`.

(If `getKpis` doesn't already fetch all engagements, reuse the same lightweight aggregation pattern;
keep it within the subrequest budget — a single paged scan, mirroring `getReports`.)

No permission change — these stay behind the existing `ignition_reports_view` (reports) /
`ignition_view` (dashboard/kpis) gates already on those actions.

## 4. App (`apps/ignition`)

### 4a. Reports page (`/reports`)
- New **"By Tier"** section: a table, one row per tier (Nano/Micro/Macro/Brand/Store/Untyped),
  columns = Influencers (active in range), Deals, Views, Avg Views/Influencer, Likes, Shares, Spend,
  Orders, Conv. Value. Sorted by Views desc.
- New **UGC** rollup card: Deals, Views, Likes, Budget Consumed (₹), Orders, Conversions Value (₹).
- New **engagement-totals** tiles (Views / Likes / Shares) in the KPI tile row.
- All three honor the page's existing date-range picker and are appended to the **CSV export**
  (add a "By Tier" block + UGC line to the existing CSV builder).

### 4b. Dashboard (landing)
- New headline tiles: **Total Views / Total Likes / Total Shares** (all-time).
- New **UGC summary** card (Deals / Views / Likes / Budget Consumed / Orders / Conv. Value).
- The existing per-tier influencer **count** cards (`getInfluencerCounts`) stay as-is.

### 4c. Influencer detail — editable Identity section (`/influencers/detail`)
- Add an **Edit** toggle on the Identity block. In edit mode the fields become inputs:
  `channel_name`, `person_name`, `channel_link`, `channel_platform`, `influencer_type`,
  `categories[]`, `reach`, `audience`, `location`, `contact_number`, `email`, `contact_poc_type`,
  `contact_poc_name`, `address`. Save → `updateInfluencer` (POST), then reload.
- `influencer_code` is rendered **read-only** (immutable, RULE-IGN-001 — worker already strips it).
- Reuse the toast pattern correctly (`useToast()` → `showToast(msg,'success'|'error')`).
- Editable field set must be a subset of the worker's `INFLUENCER_FIELDS` allow-list (worker side
  already enforces; keep the UI list aligned).

## 5. Out of scope (later slices)
- **Slice C — influencer growth history (request 2):** time-series snapshots of reach/followers.
  Needs a new `influencer_metrics_history` table + a data-source decision (manual vs platform/GA4
  pull). Own spec.
- **Slice B — monthly targets & budgets (request 4):** new `monthly_targets` table + entry UI +
  actual-vs-target. Own spec.
- Niche (`categories[]`) breakdowns — only tier breakdowns are in scope here.

## 6. Build sequence
1. ignitionops: extend `getReports` (by_tier / engagement_totals / ugc) + `getKpis`
   (engagement_totals / ugc_summary). `cd 05_Throttle/ignitionops-worker && npx wrangler deploy`
   (blast radius: Ignition only).
2. App: Reports page sections + CSV; Dashboard tiles/card; Influencer-detail Identity edit.
   `npx turbo build --filter=ignition`, commit, push (auto-deploy).
3. Smoke: open Reports with a date range → By Tier + UGC + engagement totals populate and match a
   manual spot-check; CSV includes them; Dashboard tiles show all-time totals; edit an influencer's
   identity and confirm it persists (and `influencer_code` can't be changed).
