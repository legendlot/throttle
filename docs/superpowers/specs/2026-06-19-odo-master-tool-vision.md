# Odo Master Tool — Vision & Roadmap

> Status: design / roadmap (Session 156, 2026-06-19). This is the umbrella vision.
> Each phase below gets its own implementation spec → plan → build. Phase 1 is detailed
> enough here to hand straight to writing-plans.
> Spoke: `systems/odo.md`. Spine: CORE + BUSINESS_RULES + BACKLOG.

## 1. Vision

Make Odo the **single place the whole LOT sales team lives** — every channel's data, cross-platform
insight, and (eventually) the actions to run the business. Today Odo is a read-only sell-out
dashboard. The target is a **master sales + platform-management tool**: data → insight → action,
across every channel and every marketing surface.

**Decided this session (the forks that shape everything):**

1. **Read/report is v1; full control plane is the north star.** We architect so a write/command +
   approval + audit layer can bolt on later (Phase 6), but build read/intelligence first.
2. **Federate, don't rebuild.** Odo unifies data for one cross-platform view; each source system
   stays the system of record (Snorkel = GT/MT orders, `store` = inventory, Shopify = web orders,
   marketplaces = their own). Future write-actions target the **native platform APIs**, not a
   re-implemented order/pricing system inside Odo.
3. **Breadth-first.** Connect every source we *can* today, land the data, build thin views so each
   source "finds its place," then layer intelligence and refine by real use-cases. Sources blocked on
   an external dependency (Flipkart approval, Google Ads developer-token) are parked and picked up the
   moment they clear — we take what we can get today.

**Principles:** YAGNI on intelligence until the data is visible; one shared dimensional model so any
domain can be joined to any other; reuse the existing connector framework and the `store.salesops_*`
permission layer; no new system-of-record.

## 2. The core architectural shift: one fact table → a multi-domain warehouse

Odo today holds a single fact domain — **sell-out** (`sales.sales_fact`: `date × channel × product →
units + gross`). A master tool needs **parallel fact domains that share the same dimensions** (date,
channel, product/variant) so they join cleanly for intelligence.

| Domain | Grain | Source(s) | Status |
|---|---|---|---|
| **Sales (sell-out)** | date × channel × product → units, gross (→ net, returns later) | Shopify, Amazon, QC gsheet, Snorkel GT/MT, Flipkart | ✅ live (Flipkart pending) |
| **Marketing performance** | date × platform × ad-account × campaign (→ ad-group/ad; product where attributable) → spend, impressions, clicks, conversions, conv-value | Meta Ads, Google Ads, Amazon Ads, Flipkart Ads | 🆕 new domain |
| **Web / funnel** | date × channel/source × (landing/item) → sessions, ATC, checkouts, conv-rate | GA4, Shopify analytics | 🆕 new domain |
| **Inventory & availability** | date × channel × product → on-hand, days-of-cover, OOS flag, buybox | `store` schema, Amazon FBA Inventory, marketplace stock | federate |
| **Margin** | per product → landed cost, COGS → contribution margin | Manifest (landed CPU), Snorkel (PO cost) | federate |

The intelligence everyone wants is **joins across these**: blended & per-channel **ROAS** (revenue ÷
ad spend), **CAC**, **contribution margin** (gross − marketing − landed cost), **OOS-lost-sales**,
**funnel conversion**, price/velocity. None of it is buildable until the domains exist — hence
breadth-first.

**Framework generalization.** The current pattern is `adapter.fetch() → adapter.stage() → shared tail
(mapAndUpsert → resolveSkus → recompute_facts)`. Keep adapter `fetch/stage`. The shared tail is
sell-out-specific; **marketing and traffic get their own staging tables, their own recompute
functions, and their own fact tables.** Sales mapping (channel_sku → product_code) stays as-is;
marketing maps campaign→(channel, optional product), traffic maps source→channel + item_id→product.

### Data-model sketch (DDL deferred to each phase's plan)
- **Marketing:** `sales.stg_mkt_<platform>` (raw rows, UNIQUE on platform line id, `is_active`/spend/
  metrics, `raw jsonb`) → `sales.mkt_fact` (date × channel_id × platform × ad_account × campaign_id →
  spend, impressions, clicks, conversions, conv_value; optional product_code) + dims
  `sales.mkt_account` / `sales.mkt_campaign`. Recompute = delete+reinsert per (platform, account,
  dates) from staging (same idempotency contract as `recompute_facts`).
- **Traffic:** `sales.stg_ga4` / `stg_shopify_analytics` → `sales.traffic_fact` (date × channel_id ×
  source/medium × optional product_code → sessions, add_to_cart, checkouts, purchases, conv_value).
- **Inventory/margin:** mostly **views/read-through** over `store` + `manifest` + SP-API pulls; only
  snapshot what isn't already query-able (e.g. `sales.inventory_snapshot` for marketplace stock/OOS
  over time).
- **Shared dims unchanged:** channel = `public.dispatch_channels`; product = `public.product_master`;
  IST day grain (`AT TIME ZONE 'Asia/Kolkata'`).
- **Channel↔ad-account map:** an ad account isn't a sales channel 1:1 (Meta "LOT Ads" drives Website +
  marketplaces). New `sales.channel_ad_account` map so spend can be attributed/allocated to channel(s);
  blended-only where allocation is ambiguous.

## 3. Connector inventory (what to build + access status — grounded in recon)

Worker `odoops` currently holds secrets: `SHOPIFY_*`, `AMAZON_LWA_*` + `AMAZON_SP_REFRESH_TOKEN`,
`GOOGLE_SA_JSON`, `SUPABASE_SERVICE_KEY`.

| Connector | Domain | Access today | Build effort |
|---|---|---|---|
| Website / Shopify (sales) | sales | ✅ live | — |
| Amazon SP-API (sales) | sales | ✅ live | — |
| QC gsheet (Zepto/Blinkit/Instamart) | sales | ✅ live | — |
| Snorkel GT/MT (sales) | sales | ✅ live | — |
| **Flipkart (sales)** | sales | ⛔ **BLOCKED** — app "Odo Sales read" Pending Flipkart approval (creds valid; 401 "not in Approved state"). Chase Seller Support. | built-ready |
| **GA4 (traffic)** | traffic | 🟢 **TODAY-ish** — reuse `GOOGLE_SA_JSON`; needs **GA4 property ID** + SA granted Viewer on the property (user-supplied) | small |
| **Meta Ads (marketing)** | marketing | 🟢 **REACHABLE** — 2 active accounts confirmed: **LOT Ads** `1744812979746488`, **LOT Ads 2** `1404587267520027` (business "Legend of Toys" `3133044926864564`, INR). Worker needs a **long-lived system-user token** (we control the Business — no external approval) | medium |
| **Amazon Ads (marketing)** | marketing | 🟡 **SETUP** — reuse the `AMAZON_LWA` app but authorize the **Advertising API scope** + fetch a profile per marketplace | medium |
| Shopify deep analytics (traffic) | traffic | 🟢 token exists — ShopifyQL/Analytics | small |
| **Google Ads (marketing)** | marketing | ⛔ **BLOCKED/lead-time** — needs a **Developer Token approval** + OAuth client + refresh token + MCC id. Start the approval now (like Flipkart). | medium |
| Flipkart Ads (marketing) | marketing | ⛔ after Flipkart unblocks | later |
| Quick-com ad consoles (Zepto/Blinkit/Instamart) | marketing | report-upload only (no API) | later |
| Inventory: `store` schema | inventory | ✅ internal read | small |
| Inventory: Amazon FBA | inventory | ✅ reuse SP-API | medium |
| Margin: Manifest landed CPU | margin | 🟡 after Manifest v2 landed-cost ships | later |
| Margin: Snorkel PO cost | margin | ✅ internal read | small |

**External dependencies to start chasing in parallel (no build until they clear):**
1. **Flipkart** self-access app approval (Seller Support).
2. **Google Ads** developer-token approval (Google API Console).
3. **GA4 property ID** + share property with the service-account email (user — quick).
4. **Meta system-user token** generation in Business Settings (user — quick; access already exists).

## 4. Surfaces / Information architecture

1. **Overview** (have a cockpit) — exec blended KPIs: revenue, units, ASP, ROAS, margin, growth vs prior.
2. **Channel pages** — one per channel = that channel's mini-P&L: sales trend + top SKUs + *its* ad
   spend/ROAS + inventory/availability + returns + alerts. The "channel owner's home."
3. **Marketing** — cross-platform spend / ROAS / CAC / budget pacing; per-platform + blended.
4. **Products** — per-SKU cross-channel: where it sells, price, margin, velocity, stock, days-of-cover.
5. **Funnel / Web** — GA4 + Shopify: traffic → ATC → checkout → purchase by source.
6. **Reports** — scheduled + ad-hoc, exportable (CSV/XLSX), Slack/email delivery, saved views.
7. **Alerts / Intelligence** — anomaly detection (sales drop, OOS, ROAS spike, buybox loss, ad
   disapproval) + periodic digests.
8. **Ops surfaces (have):** Mapping, Connectors, Uploads, Admin — + **role scoping** so a channel
   owner lands on their channel.
9. **(Phase 6) Actions** — write-back controls layered onto Channel/Marketing/Product pages, every
   action behind approval + an audit log.

## 5. Permissions / team

Extend the existing `store.salesops_roles`/`salesops_user_roles` layer (keys `sales_view`/`sales_refresh`/
`sales_upload`/`sales_mapping_manage`/`sales_connector_manage`/`salesops_admin`/`salesops_super_admin`,
`active` kill-switch). Add:
- **Channel scoping** — a channel-owner role sees/owns specific channel page(s) (channel-id scoped).
- **`marketing_view`** — performance-marketing pages.
- **`cost_view`** — margin/landed-cost (mirrors Manifest; not everyone sees cost).
- (Phase 6) **action/approval** keys per action class.

## 6. Phasing (each phase = its own spec → plan → build)

- **Phase 0 — Sell-out foundation** — ✅ done. 5 channels live; Flipkart pending; full SKU-mapping sweep (S156).
- **Phase 1 — BREADTH: connect everything available + thin views.** *(next — detailed in §7)*
- **Phase 2 — Marketing intelligence** — blended/per-channel ROAS + CAC; Marketing page; channel-page ad metrics; channel↔ad-account allocation. (Adds Google Ads once its token clears.)
- **Phase 3 — Web/funnel** — GA4 + Shopify deep analytics; funnel page; traffic→conversion.
- **Phase 4 — Margin & inventory** — Manifest landed CPU + Snorkel COGS + stock → contribution margin, OOS-lost-sales, days-of-cover.
- **Phase 5 — Net settlement** — marketplace fees/commissions/returns → net revenue alongside gross.
- **Phase 6 — Actions / control plane (north star)** — write-back (ad budget/pause, price, inventory, listing, orders) behind approvals + audit; native-API targets.

Refinement of pages/intelligence is continuous — thin views go in during Phase 1 and get reshaped as
real use-cases surface.

## 7. Phase 1 scope (breadth — hand to writing-plans)

**Goal:** every source we can reach today is landing data into its domain, each with a thin view so the
team can see the width. No deep intelligence yet.

**Build:**
1. **Generalize the connector framework** for multi-domain: add marketing + traffic staging/fact
   tables + per-domain recompute (migration), keeping sales untouched.
2. **GA4 connector** (`ga4` adapter, reuse `GOOGLE_SA_JSON`) → `traffic_fact`. *Dependency: property ID + SA grant.*
3. **Meta Ads connector** (`meta_ads` adapter) → `mkt_fact` for accounts LOT Ads + LOT Ads 2.
   *Dependency: system-user token.*
4. **Amazon Ads connector** (`amazon_ads`, reuse LWA app + Advertising scope) → `mkt_fact`.
   *Dependency: authorize ads scope + profile.*
5. **Federated internal reads** (no external API): inventory (`store`), PO cost (Snorkel) — as views.
6. **Thin views** in `apps/odo`: a **Marketing** page (spend/clicks/conv by platform×account×campaign,
   with a blended-ROAS strip once sales+spend coexist) and a **Funnel** page (GA4 sessions/conversions
   by source). Plus a connector-health row for each new connector on the existing Connectors page.
7. **Connector config + cron** entries for the new adapters (respect the <45 subrequest budget; stagger
   heavy pulls; cursor per connector).

**Explicitly deferred to later phases:** channel-page redesign, per-product ROAS attribution, CAC,
contribution margin, net settlement, alerts, reporting/scheduling, any write-back.

**Parked on external dependency (move when they clear):** Flipkart sales, Google Ads, Flipkart Ads,
quick-com ad consoles, Manifest landed cost.

## 8. Open questions for Phase 1 planning
- GA4 **property ID(s)** — one property, or web + app separately? (user)
- Meta **system-user token** — generate with which ad-account scope (both LOT Ads accounts)? (user)
- Marketing **fact grain** — confirm campaign-level is enough for v1 (ad-group/ad later); product
  attribution only where the platform gives it (Amazon Ads ASIN→SKU, Meta catalog sets).
- Do we want the thin **Marketing/Funnel views gated** behind `marketing_view` from day one, or open to
  all `sales_view` until roles are split?
