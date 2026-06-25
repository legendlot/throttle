# Odo — Nikhil's Amazon Metrics Suite, Phase 1 — Design

> Date: 2026-06-25 (Session 169). System: Odo. Requester: Nikhil Das (Amazon power user, Slack DM 2026-06-24). Status: design.
> Phasing agreed with Afshaan: **P1 = surface-existing + location + RTO/RTV/replacement; P2 = ASIN-level ads + search-term + alt-purchase; scraper (ranking/competitor) = separate deferred build.** This doc is **Phase 1 only**.

## Requirement (verbatim groups, Amazon-only)
Every metric cut **OVERALL / MODELWISE (product family) / SKUWISE**. Per Nikhil, **SKU = one Product-Variant-Colour** = `sales.sales_fact.product_code` (native grain — no remap). Model = product family rollup.
- **Order value & Sales value:** total · organic · net · cancelled · return · replacement · RTO · RTV.
- **Metrics:** ROAS · TACOS · ACOS · CTR · CPC · conversion · RTO-vs-RTV-vs-overall · location-wise sales (graphical).
- (Search-term report, alternate-purchase, indexing/competitor scraping → P2 / deferred.)

**Clarified definitions (Afshaan, 2026-06-25):**
- **RTO** = order came back **undelivered / refused / never reached the customer** → **undamaged, resellable**.
- **RTV** = customer **used and returned** (any reason).
- **Organic** = **not paid for / not attributable to our ad spend** (= total − ad-attributed).

## Current-state facts (verified against live data 2026-06-25)
- **Fulfilment mix: ~95% FBA** (98,486 `stg_amazon` rows fulfilment-channel="Amazon") vs **~3% Merchant/Easy-Ship** (3,170, "Merchant"). RTO handling differs by the two.
- **RTO is partly already in the data we pull.** The all-orders report `order-status` (raw line index **[4]**) carries `Shipped - Returned to Seller` (348), `Shipped - Returning to Seller` (22), `Shipped - Rejected by Buyer` (1) — these are **Easy-Ship/MFN RTOs**, currently ingested but not modeled (we only map status→`is_cancelled`).
- **FBA returns (the 95%) are NOT in the all-orders feed** — they happen post-delivery and need the dedicated FBA returns report.
- **Ship-state is already in `stg_amazon.raw`** (positional line: city [24], **state [25]**, postal [26], country [27] — verified: KARNATAKA 14,279 / TAMIL NADU 13,569 / …). Location-wise sales needs **no new source**, just extraction.
- **Returns value already flows** via the Finances API (`stg_amazon_fin` RefundEvent → `sales_fact.returned_*` + `stg_orders` return rows). What's missing is the **reason/disposition → RTO/RTV classification**, not the money.
- **`mkt_fact` ad data is campaign-grain only** (`spend/impressions/clicks/conversions/conv_value` per campaign). No ASIN/SKU/keyword grain → SKU/model-wise ROAS/ACOS/organic is **P2**.

---

## Phase 1 scope

Split into **1A (pure surfacing — zero new ingest, ship first)** and **1B (RTO/RTV/replacement — one new ingest + a classification decision)**.

### 1A — Surface metrics from data we already have

All overall + per-channel (and campaign where ad-sourced); **SKU/model where the grain already supports it** (sales/units/returns are product_code-grain in `sales_fact`; ad metrics stay overall/campaign until P2).

| Metric | Formula | Source (have) |
|---|---|---|
| Total / net / cancelled / return — **sales & orders** | (existing ladder) | `sales_fact` + `f_order_rollup` |
| **TACOS** | Amazon ad spend ÷ **total** Amazon sales | `mkt_fact` (Amazon Ads) ÷ `sales_fact` |
| **ACOS** | ad spend ÷ **ad-attributed** sales | `mkt_fact.spend ÷ conv_value` |
| **ROAS** | attributed sales ÷ spend | `mkt_fact` |
| **CTR / CPC / conversion** | clicks÷impr / spend÷clicks / conv÷clicks | `mkt_fact` |
| **Organic** orders/sales (overall) | total − ad-attributed | `sales_fact` − `mkt_fact.conv_value` |

- **No DB change.** New worker read action(s) compose these from existing rollups (or extend `getMarketing`/`getSegregation` to also return spend/attributed alongside totals for the Amazon channel). Add a small `f_amazon_metrics` helper RPC only if the client-side compose gets unwieldy.
- **Organic caveat (state in UI):** overall/channel only in P1 — SKU/model organic needs ASIN-level attribution (P2). Organic = total − attributed is the standard seller definition Nikhil confirmed.

### 1B — Location-wise sales (graphical)

- **Migration `odo_amazon_ship_state_v1`:** add `sales.stg_amazon.ship_state text` + `ship_city text` + backfill from `raw->'line'->>25` / `->>24` (one UPDATE). Going forward, the amazon `stage()` writes them from the parsed line.
- **Geo rollup:** new RPC `sales.f_amazon_geo_rollup(p_from, p_to, p_group)` → units + gross by `ship_state` (and optionally city). (Kept Amazon-specific in P1; generalise to other channels later only if asked.)
- **UI:** an India choropleth/bar on the Amazon page (reuse Recharts; a simple ranked-bar + optional map). State names are clean uppercase — normalise to a canonical set for the map.

### 1B — RTO vs RTV + replacement

**Sources:**
- **MFN/Easy-Ship RTO (already pulled):** classify all-orders `order-status` ∈ {`Shipped - Returned to Seller`, `Shipped - Returning to Seller`, `Shipped - Rejected by Buyer`} → **RTO**.
- **FBA returns (NEW ingest):** Amazon report **`GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA`** (reuse the existing report create→poll→download machinery in `amazonAdapter`; cols: `return-date, order-id, sku, asin, quantity, detailed-disposition, reason, status`). New staging `sales.stg_amazon_returns` (migration `odo_amazon_returns_v1`; grain order×sku×return-date, idempotent supersede-by-date-range).

**Classification (DEFAULT — needs Nikhil's sign-off, see Open Decisions):**
- **RTO** = MFN returned-to-seller/rejected statuses **+** FBA returns whose `detailed-disposition = SELLABLE` and `reason` indicates undelivered/refused (resellable, untouched).
- **RTV** = FBA returns with `detailed-disposition ∈ {CUSTOMER_DAMAGED, DEFECTIVE, CARRIER_DAMAGED}` or a used/unwanted-after-delivery `reason`.
- Anything unmatched → `unknown` bucket (shown, not hidden).

**Data model:**
- Add `return_kind text` (`rto`|`rtv`|`unknown`) to the return representation — on `stg_orders` return rows and a `returned_units`/`returned_value` split path. Extend `f_order_rollup` to emit `rto_units/rto_value/rtv_units/rtv_value` alongside the existing `returns_*`.
- **No double-count (key invariant):** returns **value** continues to come from Finances refunds (already live, RULE-SALES-001). The returns report is the **classifier + unit/reason source** — it assigns `return_kind` to existing return rows by joining on `order-id`+`sku`; it does **not** add new return value. FBA returns with no matching refund (e.g. returnless refunds / replacements) are reconciled explicitly, not summed twice.

**Replacement (Amazon) — P1 stretch / confirm signal first:**
- Amazon has **no replacement tag** like Shopify (`order_type_rules` is tag-based, Shopify-only). Candidate signals: ₹0-value `Shipped` orders in all-orders (Amazon-issued replacement shipments), or Finances events with no `Principal`. **Needs one investigation pass** to confirm the reliable signal before modeling — do NOT block 1A/location/RTO-RTV on it.

---

## UI — an Amazon cockpit (`/amazon`)
Nikhil wants everything in one place. Add a dedicated **Amazon** page (reuse `components/kit.js` + `ChannelFamilyPage` patterns + Recharts), `sales_view`-gated:
- **Order/Sales value block** — the 8-metric table (total/organic/net/cancelled/return/replacement/RTO/RTV) × an **Overall / Model / SKU** toggle (`SegmentedToggle`), values + units.
- **Ad metrics strip** — ROAS / TACOS / ACOS / CTR / CPC / conversion (overall + per campaign), prior-period deltas.
- **RTO vs RTV vs overall** — split tiles + trend.
- **Location-wise sales** — ranked-bar / India map, range-filtered.
All on the shared `RangePicker` (default MTD) + prior-period deltas, matching the S169 kit.

## Out of scope (later)
- **P2:** ASIN/targeting-level Amazon Ads (unlocks SKU/model ROAS·ACOS·organic) · search-term report (leak/winner KW) · alternate-purchase analysis.
- **Deferred separate build:** ranking-position tracker + competitor/price/BSR scraping (Nikhil #9/#10) — backlogged, scope with Afshaan after this suite ships.

## Open decisions / risks
1. **RTO/RTV classification rules** — Amazon's `disposition`/`reason`/`status` fields don't map 1:1 to Nikhil's definitions. Ship the default mapping above, show an `unknown` bucket, and have **Nikhil confirm/adjust the reason→kind rules** against a week of real returns (the rules live in a small lookup so they're editable without a deploy).
2. **Returns value reconciliation** — the FBA returns report must enrich, not re-sum, the Finances-sourced returned value. Build a reconciliation check (returns-report units vs refund-events) and log unmatched.
3. **Replacement signal** — confirm the Amazon signal before modeling (don't block the rest).
4. **FBA returns report cadence** — daily pull, supersede-by-return-date window; runs as its own connector window inside the existing Workflows machinery (no scheduler change).

## Verification model
Same as the worker norm (no unit harness): bundle dry-run + deploy + SQL on staging/rollups + a diagnostic peek of the returns report. Specifically: (1) location rollup totals reconcile to `sales_fact` Amazon gross; (2) RTO/RTV units reconcile to total returns (rto+rtv+unknown = returns); (3) TACOS/ACOS/organic spot-checked against Amazon Ads console for a known window; (4) no double-count — Amazon `sales_fact` gross/returned unchanged after the returns-report ingest.
