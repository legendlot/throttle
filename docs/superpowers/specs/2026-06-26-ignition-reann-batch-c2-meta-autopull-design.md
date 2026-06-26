# Ignition — Reann Batch C2 (Meta ad auto-pull) design

> Design spec · 2026-06-26 (Session 177)
> Status: approved (decisions locked in chat), pre-implementation
> Systems touched: Ignition (ignitionops + apps/ignition), `ignition` schema
> Source: Reann's UGC message `1782433531.017199` item #8

## Goal
Auto-fill each UGC creative's ad performance from Meta. The team enters a **Meta Ad ID** once on a
UGC deal; a daily job pulls that ad's stats and writes them onto the deal (which C1's dashboard/table/
card already render). Manual entry stays as a fallback.

## Hard scope guarantee (Afshaan)
**Strictly per-ad-ID.** C2 only ever queries the specific `meta_ad_id` values entered on UGC
engagements — one `GET /{ad_id}/insights` per ad. It does **NOT** call `act_<account>/insights`, does
**NOT** sweep all ads, and does **NOT** create a second ad dashboard. Account-level ad reporting stays
**Odo's** job (`mkt_fact`). Same token (`META_SYSTEM_USER_TOKEN`), deliberately narrow query scope.

## Data model (migration `ignition_ugc_meta_v1`)
- `ignition.engagements.meta_synced_at timestamptz` — last successful Meta pull (shown on the card).
  (All metric targets — `ad_spend`, `conversions_value`, `ctr`, `frequency`, `impressions`,
  `purchases`, `meta_ad_id` — already exist from C1.)

## Worker (ignitionops)
- **Secret:** `META_SYSTEM_USER_TOKEN` (the same permanent System User token already on odoops) set via
  `wrangler secret put`.
- **Cron:** add `[triggers] crons = ["20 2 * * *"]` (~07:50 IST daily) to `ignitionops-worker/wrangler.toml`
  (approved). Add a `scheduled()` export that runs `syncUgcMetaMetrics(env)` via `ctx.waitUntil`.
- **`syncUgcMetaMetrics(env)`** (the daily job): select UGC engagements that are **active** (stage NOT in
  `retired,dropped`) **and have a non-empty `meta_ad_id`**, ordered by `meta_synced_at` asc nulls first
  (oldest-synced first). Cap at `META_MAX_ADS_PER_RUN = 40` per run (subrequest budget; the cron drains
  the rest next day — `log` what was deferred). For each ad id, one `GET https://graph.facebook.com/v21.0/
  {ad_id}/insights?fields=spend,impressions,clicks,ctr,frequency,actions,action_values
  &action_attribution_windows=['7d_click']&date_preset=maximum&access_token=…`. Parse (mirror odoops):
  purchases = `actions[]` where action_type ∈ {omni_purchase, purchase} (`.value`); revenue =
  `action_values[]` same types (`.value`). PATCH the engagement: `ad_spend=spend`,
  `conversions_value=revenue`, `purchases=purchases`, `impressions`, `ctr`, `frequency`,
  `meta_synced_at=now()`. ROAS stays computed (revenue/spend) at display. A bad/return-error ad id is
  skipped (logged), never fatal to the batch.
- **`refreshUgcMetrics({engagement_id})`** (POST, gate `ignition_manage`): the on-demand single-deal
  version — same per-ad pull for one deal; returns the updated fields. Surfaced as a "Refresh from Meta"
  button on the UGC detail card. Returns a clear error if the deal has no `meta_ad_id` or the token is unset.
- **Inert without the token:** if `!env.META_SYSTEM_USER_TOKEN`, `scheduled()` no-ops and
  `refreshUgcMetrics` returns `meta_not_configured` (graceful, mirrors other LOT connectors).

## Frontend (apps/ignition `/ugc/detail`)
- Ad-performance section: a **Refresh from Meta** button (→ `refreshUgcMetrics`) + a "last synced
  <meta_synced_at>" line. `meta_ad_id` is already an editable field (C1). The metric fields stay
  editable (manual fallback). No new page.

## Non-goals
- No account-level / all-ads pull (Odo owns that).
- No per-day snapshot/trend table (YAGNI — Reann asked for current numbers; days-active already uses
  `live_at`). Add later only if a trend chart is requested.

## Build sequence
1. Migration `ignition_ugc_meta_v1` (`meta_synced_at`).
2. ignitionops: `scheduled()` + `syncUgcMetaMetrics` + `refreshUgcMetrics` + Meta insights helper;
   add cron to wrangler.toml; set `META_SYSTEM_USER_TOKEN`; deploy.
3. apps/ignition: Refresh-from-Meta button + last-synced line on `/ugc/detail`. Build green; deploy.
4. Verify: set a real `meta_ad_id` on a UGC deal → Refresh → fields populate; confirm a no-ad-id deal is
   skipped and no account-level call is ever made.
