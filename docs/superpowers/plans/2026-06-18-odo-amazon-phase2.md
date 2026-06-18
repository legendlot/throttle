# Odo Phase 2 — Amazon (SP-API) — Implementation Plan

> **STATUS (paused S154):** approved + started. **DB migration `salesops_amazon_v1` APPLIED**
> (`sales.stg_amazon` + `v_staged` UNION — see `odoops-worker/migrations/0003`). **Adapter code
> NOT yet written.** **Blocked on Amazon onboarding:** the user must finish the SP-API **Production**
> app gate — Verify Identity (business registration + ID doc) + Profile/Permissions — before a real
> refresh token exists. Sandbox apps = static fake data (useless). **RESUME at Step 2 (build adapter)
> once the 3 Amazon creds land; then Step 3.**

## Context
Add Amazon to Odo (live: Shopify + QC-gsheet + GT/MT). Auth is **LWA-only** (AWS IAM/SigV4 dropped
Oct 2023). Data via the **Reports API** (NOT Orders API — `getOrders` is rate-limited ~1/min + N+1
`getOrderItems` → blows the 50-subrequest Worker cap). Pull one
**`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL`** report (order-line: purchase-date, sku,
product-name, quantity, item-price, order-status) over a date range → download → parse → existing
QC pipeline. One report = all history; async (create→poll→ingest state machine across cron ticks).
**Channel = single "Amazon" bucket** (reuse the `Amazon - FBA` dispatch_channel row).

## Onboarding (USER — Amazon side, the current blocker)
Solution Provider Portal (solutionproviderportal.amazon.com) is global — no separate India dev
portal. The account shows "Legend Of Toys → United States" (same login, India not separately listed);
**the marketplace(s) the token covers are confirmed at self-authorize, not by that switcher** — so we
create the app, authorize, then probe `getMarketplaceParticipations` to confirm India (`A21TJRUUN4KGV`)
vs US. To create a **Production** app the user must first:
1. **Verify Identity** (~20 min) — business registration (Pvt Ltd; likely *Fraternitas Ventures
   Private Limited* per Blinkit data) + director ID. Amazon reviews.
2. **Profile & Permissions** — request **Reports** role (+ Orders). **NO PII / restricted / DTC-shipping
   roles** (we read only aggregate sales — date/sku/qty/amount, no buyer data → avoids the heavy
   security review). Use-case: "internal read-only sales dashboard, no buyer PII."
3. After approval → create **Production** SP-API app → **self-authorize** → copy **refresh token** +
   **LWA client id/secret** → hand to me.

## STEP 2 — Build the adapter (ME, in `05_Throttle/odoops-worker/src/index.js`)
Region-agnostic — endpoint + marketplace are CONFIG, set from the verified token.
- ✅ DONE: migration `salesops_amazon_v1` (`sales.stg_amazon` + `v_staged` UNION).
- `getAmazonToken(env)` — POST `https://api.amazon.com/auth/o2/token` `grant_type=refresh_token`
  + `AMAZON_SP_REFRESH_TOKEN` + `AMAZON_LWA_CLIENT_ID`/`SECRET` → access token (module-scope cache ~1h).
- `amazonAdapter` (kind `amazon_spapi`, stgTable `stg_amazon`) — Reports state machine, state in
  `connector_config.config` `{region_host, marketplace_id, backfill_start, columns, pending_report_id, pending_through}`:
  - No pending: `POST {region_host}/reports/2021-06-30/reports`
    {reportType:'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', marketplaceIds:[mkt],
    dataStartTime:cursor||backfill_start, dataEndTime:now} → save pending_report_id + pending_through=now;
    return `partial:true` (no cursorAfter).
  - Pending: `GET .../reports/{id}` → IN_QUEUE/IN_PROGRESS → partial; DONE → `GET .../documents/{reportDocumentId}`
    → fetch pre-signed url → **gunzip if compressionAlgorithm=GZIP** (`DecompressionStream('gzip')`) →
    split TSV (`\n`/`\t`) → grid → reuse **`gridToQcRows`** with the Amazon column map → rows; clear
    pending; cursorAfter=pending_through. CANCELLED/FATAL → clear pending + throw.
  - Headers on every SP-API call: `Authorization: Bearer <t>` + `x-amz-access-token: <t>`.
  - `stage(rows)` → supersede `stg_amazon` by [from,to] (like gsheetAdapter) + insert.
  - Column map: date=`purchase-date`, sku=`sku`, title=`product-name`, units=`quantity`,
    gross=`item-price`, status=`order-status`; extend `gridToQcRows` to set `is_cancelled` when the
    status cell matches /cancel/i (recompute already excludes is_cancelled).
- Register `amazon_spapi` in `ADAPTERS`. `executeRun` already passes `config` + advances cursor on
  cursorAfter (incl. partial=false). `mapAndUpsert` tail handles SKU mapping + recompute. Add `stg_amazon`
  staging is already in `v_staged`.

## STEP 3 — Configure, deploy, verify
1. `cd 05_Throttle/odoops-worker && npx wrangler secret put AMAZON_LWA_CLIENT_ID` (+ SECRET +
   `AMAZON_SP_REFRESH_TOKEN`); commit+push+`wrangler deploy`.
2. **Probe marketplace first:** with the token, curl `getMarketplaceParticipations` on NA + EU to
   confirm India (`A21TJRUUN4KGV`, host `sellingpartnerapi-eu.amazon.com`) vs US.
3. `connector_config` for `Amazon - FBA`: `adapter_kind='amazon_spapi'`, `enabled=true`,
   `config={region_host, marketplace_id, backfill_start:'2025-04-01T00:00:00Z', columns:{...}}`.
4. Refresh now → run1 creates report (partial) → wait → Refresh again → run2 ingests. Verify
   `connector_runs` ok, `stg_amazon` rows, `sales_fact` Amazon rows; map Amazon SKUs (auto + seed pass).
5. `getConnectorStatus` already surfaces `amazon: !!env.AMAZON_LWA_CLIENT_ID`.

## Notes / open
- Returns/refunds = later (separate report, v2 net-settlement). v1 = non-cancelled item-price gross.
- `item-price` in the all-orders flat file is the line total (use as gross). Confirm at first pull.
- Backfill: one report covers the whole range; chunk the date range if a single report is huge.
- Keep the 3 Amazon dispatch_channels; only `Amazon - FBA` wired (single bucket).
