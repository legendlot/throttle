# Salesops — Consolidated Cross-Channel Sales Dashboard (Design)

> Status: APPROVED (brainstorming, Session 154 · 2026-06-18). Next: implementation plan → Phase 1 build.
> System home: NEW standalone app `apps/sales` + worker `salesops-worker` + new `sales` schema.

## 1. Context & goal

LOT sells across many channels — Amazon, Flipkart, our Website (Shopify), Quick Commerce
(Zepto / Blinkit / Instamart), and offline GT/MT. There is **no single place** to see sales.
GT/MT already has a real revenue ledger (Snorkel `store.sales_orders`); every other channel's
sales live only inside that platform's own portal.

**Goal:** a **live consolidated sales dashboard** showing sales at **product-variant × day ×
channel** (units + gross ₹), with **CSV/XLSX download** of any view for further analysis.

**Decisions locked in brainstorming:**
- New standalone system (own app + worker + schema + permission layer), alongside the other
  LOT systems in the Throttle monorepo. Subdomain `sales.legendoftoys.com`.
- **API-first** ingestion where an API exists; report-file ingestion where it doesn't.
- **Sell-out** semantics — actual consumer purchases (for GT/MT, the confirmed sales order).
- Metrics: **units + gross sales value (₹)**. Marketplace fees / net settlement are **out of
  scope** (gross only).
- **Hourly** auto-refresh (Cloudflare cron) + a **manual "refresh now"**.
- SKU identity via a **mapping table** with an **unmapped queue** (one-time admin mapping).

## 2. Channel reality (researched 2026-06)

| Channel | Sell-out source | Auth | Phase |
|---|---|---|---|
| Website | **Shopify Admin GraphQL** (orders) | client-credentials token (infra exists in csops/ignition) | 1 — live now |
| GT / MT | existing **Snorkel `store.sales_orders`** confirmed orders | internal DB read | 1 — live now |
| Zepto / Blinkit / Instamart | **NO self-sales API** → seller-portal report files (CSV/XLSX) the team already downloads daily; some settlement reports emailed | n/a | 1 — file upload; later mailbox auto |
| Amazon | **SP-API Orders API** | LWA OAuth2 refresh token → 1h access token | 2 — needs LWA app + seller auth |
| Flipkart | **Marketplace Seller API v3** (Order Mgmt / Shipments) | OAuth2 client-credentials (self-access) | 3 — needs seller API creds |

**Research note:** the third-party "Blinkit/Zepto/Instamart APIs" found online are all
*competitor-pricing scrapers*, not your-own-sales feeds. QC sales come only from the seller
portals. So QC ingestion is report-based, designed swappable to a mailbox/API feed later with
zero pipeline rework.

## 3. Architecture

A **connector framework**: per-channel adapters all feed one normalized daily fact store
through a shared `normalize → map SKU → upsert fact` tail.

### 3.1 New `sales` schema (Supabase `jkxcnjabmrkteanzoofj`)
Expose to PostgREST (`db-schemas = …, sales`) + `GRANT USAGE/ALL … TO service_role`.

- **`sales.sales_fact`** — PRIMARY view source. Grain **(sale_date, channel_id, product_code)**.
  Cols: `units int`, `gross_value numeric(14,2)`, `currency char(3)`, `source_kind`,
  `last_run_id`, `updated_at`. **UNIQUE(sale_date, channel_id, product_code)** = idempotency
  key; recomputed per (channel, date) window from staging so re-pulls never double-count.
- **`sales.stg_<adapter>`** (`shopify`/`amazon`/`flipkart`/`qc`/`snorkel`) — raw normalized
  order-LINE rows, UNIQUE on the source line id (`line_gid` / `order_item_id` /
  `sales_order_line_id` / `(upload_batch_id,row_no)`); carry `is_cancelled`/`order_status` +
  `raw jsonb`. Replay/audit source. Aggregate = `SUM(units), SUM(gross) … GROUP BY
  sale_date, channel_id, product_code WHERE NOT is_cancelled`.
- **`sales.sku_map`** — `(channel_id, channel_sku) → product_code`, UNIQUE. Resolution order:
  exact map hit → auto-match `public.product_master` by `sku` → `ean` → `product_code`
  (auto-insert a map row, record `match_on`) → else **unmapped queue**.
- **`sales.unmapped_sku`** — one-time admin queue (`channel_id, channel_sku, sample_title,
  occurrences, pending_units, pending_gross, status`). Resolve → write `sku_map` + backfill
  the affected staging dates so history fills in.
- **`sales.connector_runs`** — sync log (`window_from/to`, `cursor_before/after`, `status`,
  `rows_fetched/mapped/unmapped`, `facts_upserted`, `subrequests_used`, `error`, timings,
  `trigger` cron|manual|upload|backfill).
- **`sales.connector_config`** — PK `channel_id` → `public.dispatch_channels.id`;
  `adapter_kind`, `enabled`, live `cursor`, `last_ok_at`, `last_error`. Cron iterates only
  `enabled=true`.
- **`sales.upload_batch`** — QC report files: `storage_path` (private bucket
  `salesops-uploads`), `report_period_from/to`, `status`, row counts. A new upload for an
  overlapping period **supersedes** the prior batch's `stg_qc` rows for those dates
  (re-upload replaces, never adds).
- **Permission tables in `store`** (mirror snorkel/manifest): `store.salesops_roles`,
  `store.salesops_user_roles` (`active` kill-switch). Keys: `sales_view`, `sales_refresh`,
  `sales_upload`, `sales_mapping_manage`, `sales_connector_manage`, `salesops_admin`,
  `salesops_super_admin`.

**Channel registry:** reuse `public.dispatch_channels` UUIDs (`is_sale=true`) as the canonical
channel id — no parallel registry. `connector_config` is the thin per-channel adapter extension.

### 3.2 Connector / adapter interface (`salesops-worker/src/adapters/<kind>.js`)
Each adapter implements only:
```js
fetch({ env, channelId, cursor, windowFrom, windowTo, budget })
  → { rows: NormLine[], cursorAfter, subreqs, partial }
stage(rows, runId, sb)   // idempotent insert into its stg_* table
```
`NormLine = { source_line_id, source_order_id, channel_sku, title, variant_title, qty,
gross_value, occurred_at, sale_date, is_cancelled, raw }`.

Shared tail `pipeline.js → mapAndUpsert(channelId, affectedDates, sb)`:
`resolveSkus` (map → product_master → unmapped) then `recomputeFacts` (Postgres RPC/view,
not per-row). **QC upload** swaps `fetch` for `parseUpload` (read Storage file → CSV/XLSX →
NormLine[]), then identical `stage` + tail. **GT/MT** adapter `fetch` reads
`store.sales_orders?status=eq.confirmed` + `sales_order_lines` (cross-schema read, no HTTP).
Mailbox-QC later = a new adapter with the same `fetch` signature; tail unchanged.

### 3.3 Hourly cron (clone Manifest's FX-cron template)
`wrangler.toml [triggers] crons = ["0 * * * *"]`; `scheduled(event, env, ctx)` iterates
`connector_config?enabled=true`, hands each adapter a **global subrequest budget (<45, under
the 50 cap)**, defers remaining channels to the next hour if the budget runs low, advances
`cursor` only on a fully successful run. Cursor = **updatedAt watermark** so cancels/refunds
re-enter the window and net out. `refreshNow`/`backfill` use `ctx.waitUntil` to return the
HTTP response immediately and continue work.

### 3.4 Worker actions (`salesops-worker/src/index.js`, cloned from manifest scaffold)
GET: `getMe`, `getBootstrap` (channels + config + KPIs + unmapped count + roles/accessUsers if
admin), **`getSales`** (primary rollup via `sales.f_sales_rollup` RPC; params
`from/to/channel_id[]/product_code/group=date|channel|variant`), `getSalesExport`,
`getConnectorStatus` (config + last run + **secret-presence booleans only**), `getRuns`,
`getSkuMap`, `getUnmapped`, `getUploadBatches`, `getSalesRoles`/`getSalesUsers`.
POST: `refreshNow`, `uploadReport` (signed-URL upload, then POST the path), `createSkuMap`/
`updateSkuMap`/`deleteSkuMap`, `resolveUnmapped`, `setConnectorEnabled`, `backfill`, and
super-admin access-control (`createSalesRole`/`setUserActive`/`grantAccess`/`deleteRole`, with
last-super-admin / self / system-role guards, verbatim from manifest).

### 3.5 Frontend (`apps/sales`, standard monorepo Next.js + `@throttle/{auth,db,ui,domain}`)
Mirror Docket/Manifest scaffold (root layout, `(auth)` route group, `AppLauncher`,
Sidebar/Topbar, GH-Pages deploy workflow → `sales.legendoftoys.com`).
- **`/` Dashboard** — date-range picker (default last 30d), channel multi-select, KPI cards
  (total units, gross ₹, by-channel split), the primary **variant × day** grid with channel
  breakdown, trend chart, per-cell drill to the underlying orders. **Download CSV/XLSX** on
  every view (export respects active filters).
- **`/mapping`** — `sku_map` table + the **unmapped queue** (resolve = pick a `product_master`
  variant; shows pending units/₹ impact).
- **`/connectors`** — per-channel status, enable/disable, last run + log, **refresh-now**,
  secret-presence indicators, **backfill** trigger.
- **`/uploads`** — QC report upload (channel + period + file), batch history, parse status.
- **`/admin`** — roles (permissions builder) + access control (mirror manifest 3-tab).

## 4. Gross value derivation (gross only; fees/settlement OUT of scope)
- **Shopify (Website):** line `originalTotalSet.shopMoney.amount`; sell-out = order placed.
- **Amazon SP-API:** `OrderItem.ItemPrice`; sell-out = non-cancelled order.
- **Flipkart v3:** `sellingPrice × qty`; sell-out = non-cancelled/returned order.
- **QC:** report's sold-units × price column (per-portal column map in the parser).
- **GT/MT (Snorkel):** `Σ sales_order_lines.taxable_value` (pre-GST, post-discount), units
  `Σ qty`, date `order_date`, status `confirmed`, channel `channel_key`→GT/MT.
All INR; non-INR lines (Export) stored with `currency` and excluded from the ₹ rollup Phase 1.

## 5. Idempotency / cancellations / timezone
- Staging UNIQUE on source line id + fact UNIQUE on grain → re-pull is a no-op on totals.
- **Cancels/returns:** updatedAt watermark re-pulls the order → `is_cancelled`/`order_status`
  flips → aggregate drops it → fact recompute lowers that **original sale_date's** units/gross.
  QC corrected report supersedes by period.
- **IST day grain:** `sale_date = (occurred_at AT TIME ZONE 'Asia/Kolkata')::date`. Do NOT
  copy Snorkel's UTC `todayISO()` for the grain. GT/MT `order_date` is already an IST date.

## 6. Phasing
- **Phase 1** — `sales` schema + all tables + perms; worker scaffold + cron + pipeline tail;
  **Shopify adapter (live)** + **QC file-upload** + **GT/MT from Snorkel**; dashboard rollup +
  CSV/XLSX; mapping/unmapped; uploads; admin. Backfill default: **current FY (2026-27) + prior
  FY**, per-channel configurable.
- **Phase 2** — Amazon SP-API adapter (LWA refresh-token → access token; Orders API),
  `stg_amazon`, ASIN/SKU mapping. Blocked on LWA app + seller authorization.
- **Phase 3** — Flipkart v3 adapter (OAuth2 client-credentials), `stg_flipkart`, FSN mapping.
  Blocked on Flipkart seller API creds.
- **Later** — QC mailbox auto-ingest (`qc_mailbox` adapter, same `fetch` signature).

## 7. Risks / mitigations
- **50-subrequest cap** — global budget counter in cron, defer channels, aggregate in Postgres
  (RPC/view), never await-per-row, chunked self-rescheduling backfill.
- **Worker CPU/time** — heavy GROUP BY/joins in Postgres; `ctx.waitUntil` for refresh/backfill.
- **Secrets** — all via `wrangler secret put` (never in `wrangler.toml`); status = presence
  booleans only. Reuse the csops/ignition Shopify Dev Dashboard app creds.
- **Rate limits** — module-scope token cache + backoff (Shopify `THROTTLED`, Amazon
  `x-amzn-RateLimit`, Flipkart quota); hourly windows keep steady-state pulls to 1–2
  pages/channel.

## 8. Critical files (clone / reuse)
- `05_Throttle/manifestops-worker/src/index.js` + `wrangler.toml` — worker scaffold, verifyJWT,
  Accept-Profile schema select, `scheduled()` cron, access-control admin.
- `05_Throttle/csops-worker/src/index.js` (~L93–188) — Shopify token mint + GraphQL orders.
- `05_Throttle/snorkelops-worker/src/index.js` — `snorkel_roles` perm pattern + `sales_orders`/
  `sales_order_lines` read shape.
- `05_Throttle/apps/manifest/**` + `.github/workflows/deploy-manifest.yml` — app + deploy template.
- `05_Throttle/CLAUDE.md` — 50-subrequest cap, `Number()`/`Math.round()`, GRANT rule.

## 9. Verification
- Schema: `information_schema.columns` checks + Supabase advisors clean after migration.
- Shopify adapter: `refreshNow` on Website → `connector_runs` ok, `stg_shopify` rows, facts
  populate; re-run → totals unchanged (idempotent); cancel a test order → next pull nets it out.
- GT/MT: confirm a Snorkel sales order → appears in `sales_fact` under GT/MT on `order_date`.
- QC upload: upload a sample Blinkit report → batch parsed, unknown SKUs queue, resolve one →
  fact backfills; re-upload corrected report for same period → supersedes, no double-count.
- Dashboard: variant×day×channel grid matches raw, filters work, CSV/XLSX export opens clean.
- Build all monorepo apps green before commit; deploy `salesops` worker (own blast radius).
