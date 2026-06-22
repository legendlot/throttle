# Odo — Uniware (Unicommerce) connector

> Design spec · 2026-06-22 · Status: approved, building
> Feeds the Channels-section pages (2026-06-22-odo-channels-section-design.md) for Flipkart + long-tail.
> Scope decided with Afshaan: **fallback only** — Uniware feeds channels we can't get directly;
> the live direct Amazon SP-API + Shopify connectors are untouched.

## Why

Flipkart gives no direct Seller API while Unicommerce (uniware) sits on the account. Unicommerce
is LOT's OMS and already receives Flipkart + Firstcry (+ Cred/Peeko) orders, so we pull sell-out
from there. Tenant: **`fraternitas`** (`https://fraternitas.unicommerce.com`).

## Probe findings (2026-06-22, verified live)

- **Auth:** `GET /oauth/token?grant_type=password&client_id=my-trusted-client&username=&password=`
  → `access_token` (~12h, `expires_in` ~43199s) + `refresh_token`. Requires an **Admin** user with
  facility access. Created a dedicated native-password user `systems@legendoftoys.com` (SSO users
  have no native password; the API needs one).
- **Channels seen** (last 8d, 1,107 orders): `FLIPKART`, `FIRSTCRY`, and `LEGEND_OF_TOYS`
  (96% of volume; its `source`=`SHOPIFY` → the website flow → **must be EXCLUDED**, we have it direct).
  Cred/Peeko had no recent volume.
- **Search** `POST /services/rest/v1/oms/saleOrder/search` — filter `channel`, `fromDate`/`toDate`
  (ISO `yyyy-MM-ddTHH:mm:ss.SSSZ`, i.e. `Date.toISOString()`), `dateType` CREATED|**UPDATED**|…,
  paginate `searchOptions.{displayStart,displayLength}`. Returns **metadata only** (code, channel,
  status, displayOrderDateTime, created, **updated**; epoch-millis) — **no financials**.
- **Get** `POST /services/rest/v1/oms/saleorder/get` body `{code}` → `saleOrderDTO` with
  `saleOrderItems[]` (Unicommerce **explodes to 1 item = 1 unit**). Per item: `itemSku`
  (`fk-shadow-asphalt-black`), `ean` (`5949999234230`), `sellerSkuCode` (`lotcars-shadow-asphalt-black`
  — same grammar Amazon uses), `channelProductId` (FSN), `sellingPrice`, `totalPrice`, `discount`,
  `totalIntegratedGst/StateGst/CentralGst/UnionTerritoryGst`, `statusCode` (incl `CANCELLED`),
  `cancelledBySeller`, `replacementSaleOrderCode`. Order: `status` (incl `CANCELLED`), `returns[]`.

## Architecture (mirrors the Amazon adapter + the S158 order-grain model)

- **Auth** `getUniwareToken(env)` — password grant, cached ~12h (refresh by re-mint).
  Secrets: `UNIWARE_TENANT` (=`fraternitas`), `UNIWARE_USERNAME`, `UNIWARE_PASSWORD`.
- **`uniwareAdapter`** (`kind:'uniware'`, `stgTable:'stg_uniware'`):
  - Per-channel `connector_config.config = { uniware_channel, backfill_start, window_days?, max_gets? }`.
  - **Forward-walking windows** like Amazon: search `[cursor, cursor+30d]` (dateType=UPDATED) filtered to
    the one `uniware_channel`; collect codes (low volume → 1–2 pages); `get` each, sorted updated-asc,
    bounded to `max_gets` (~40)/run to stay under the 50-subrequest cap; advance cursor to the window
    end when fully drained, else to the last processed `updated` (partial → next tick continues). Empty
    window still advances → no stall. **N+1 is fine**: target channels are ~4% of volume (~dozens/day).
  - Maps each item → a line row (`stg_uniware`, qty=1) + accumulates an order-grain row (`stg_orders`).
    `is_cancelled` per-item (cancelled items drop from sales_fact). Order row: cancelled order →
    `is_cancelled=true`, gross = full value (cancelled_value); live order → gross = sum of non-cancelled
    items. **gross = `sellingPrice`** (customer-paid, tax-incl, mirrors Shopify); **tax = Σ GST fields**;
    **discount = `discount`**. `source_line_id = ${orderCode}:${itemCode}`.
  - **UPDATED cursor** means late-populated GST/cancellations re-pull and recompute (idempotent).
- **Mapping:** reuse `resolveSkus` — `channel_sku` = `itemSku`; auto-match sku→**ean**→product_code
  (EAN present per line → strong auto-map), else `unmapped_sku` queue. (No new mapping code.)
- **DB (migration `odo_uniware_staging_v1`, additive):** `sales.stg_uniware` (mirrors `stg_snorkel`
  + `row_type`/`discount_value`/`tax_value`, UNIQUE `source_line_id`); recreate `sales.v_staged`
  to UNION a `'uniware'` branch (so `recompute_facts` → `sales_fact` picks it up). `stg_orders` /
  `f_order_rollup` are channel-agnostic — fed via `stageOrders`, no change.
- **Channel wiring:** Uniware emits a single `FLIPKART` (no Flex/Managed split, even in `source`) →
  map all Flipkart to ONE Odo channel (**Flipkart Managed**); the Channels "Flipkart" page aggregates
  Flex+Managed anyway. `FIRSTCRY` → Firstcry. (Cred/Peeko: add a one-line config when they transact —
  exact uniware codes unconfirmed, no recent volume.) `LEGEND_OF_TOYS` is never wired (Shopify dup).

## v1 scope / out of scope
- **v1:** sales + cancellations (both confirmed). Full **returns** (order `returns[]` / Return API) =
  fast-follow once a populated returns shape is captured (sample was empty).
- **Partial item-cancellation value** within a still-live order isn't booked as cancelled_value at order
  grain in v1 (cancelled items just drop from sales). Whole-order cancellations are exact. Refine later.
- If target volume ever grows enough that N+1 strains the Worker budget, move ingestion to Cloudflare
  Workflows/Queues (control-station charter).

## Verify
Build worker → deploy → set secrets → wire Flipkart Managed + Firstcry connectors → backfill from
2025-04-01 → confirm `connector_runs` ok, `sales_fact` + `f_order_rollup` populate for Flipkart/Firstcry,
and the Channels pages light up. GST-on-COMPLETE-orders + the gross (sellingPrice vs totalPrice) to be
sanity-checked against a settled order during verification.
