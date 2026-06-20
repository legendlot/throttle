# Odo — Control-Station Architecture & Data-Granularity Charter

> Spec / decision record. Written Session 159 (2026-06-20).
> Owner: Afshaan. Status: **directional — the durable reference for building Odo out.**
> Supersedes nothing; sits above the per-feature specs (master-tool vision, sales-segregation).
> Companion docs: `2026-06-19-odo-master-tool-vision.md`, `2026-06-19-odo-sales-segregation-design.md`.

---

## 0. Why this doc exists

Odo started as a consolidated **sales** dashboard. The decided direction (Afshaan, S156–159) is
that it becomes the company's **central business control station** — the one place to monitor
sales, ads, inventory, pricing, returns, and ultimately a federated P&L across every channel and
every internal system, accurate enough to drive decisions and "intelligent discussions."

Afshaan's stated constraints for this doc:
1. **We are early.** Build *basic but important numbers, accurate and up ASAP.* Heavy formatting,
   reskins, and depth come later — no rush.
2. **Accuracy > recency.** Recency can be compromised; accuracy cannot.
3. **THE anxiety this doc must resolve:** *"I do not want to go back in the future and have to
   redefine data granularity and change schemas/migrations to get more information."* — i.e. get
   the **grain** right now so future depth is additive, never a re-integration.

This doc answers two things: **(A)** is the stack scalable for the full vision, and **(B)** what
granularity must we capture *now* so we never have to re-pull or re-architect to get more detail.

---

## 1. The vision (recorded, so it stays)

Odo = a **central business control station**, built breadth-first, federating data from the
existing LOT systems rather than rebuilding them. Native systems stay the system-of-record; Odo
reads, cleans, consolidates, and composes.

**Four headline deliverables (Afshaan's list):**
1. **Per-channel dashboards** — headline numbers + product/variant breakdown, with time windows
   (today, yesterday, this week, this month, last 7d, last 30d, custom) and metric filters.
2. **Net sales & metrics for all channels** — net = the number we recognise as revenue: net of
   GST, returns, refunds — *what's left after all settlements are done.*
3. **Running P&L view** — per channel + consolidated, in the existing contribution-margin format
   (see §5 / the reference screenshot): GMV → RTO → Refund → Taxes → NMV/Revenue → COGS → GM →
   Logistics → Platform Fee → CM1 → CAC → CM2 → Brand Marketing → SG&A → EBITDA.
4. **Ad analytics** — all channels with performance marketing, drill-down to weed out bad
   performers / keep good ones.

**Use cases it must enable:**
- Sales team monitors business done across any period, down to product-variant level (yesterday,
  MTD, etc.).
- Monitor performance-ad spend across channels and the returns (ROAS), drill down, prune.
- Keep an eye on inventory, pricing, availability across channels — plus discounts, refunds,
  returns.
- Look at a **product P&L over time** (improving / worsening / stable?).
- Understand growth areas — product / channel / inventory / fill-rate.

**Long-term federation (each element feeds the P&L from its native system):**
- **COGS** ← Manifest + Snorkel (PO / landed cost).
- **Per-unit production cost, manpower** ← Redline.
- **Producibility, procurement planning, inventory alerts** ← Garage.
- **Burn / SG&A (salaries)** ← Podium.
- **Finished-goods availability, fill-rate planning** ← Depot.
- **Product launches, influencer management** ← Ignition.
- **Customer-success metrics, feedback** ← Pitstop.

This is a long road. **First step = collect and clean as much data as possible, in the right
format, at the right grain.**

---

## 2. Stack scalability verdict

**Bottom line: the stack scales to the full vision, with one architectural change (ingestion) and
a few disciplines. No re-platforming. Spend goes to Supabase tier + Cloudflare Workflows usage —
both modest.**

### 2.1 Supabase / Postgres — not the bottleneck for years
Fact grain is tiny. Sales at `(sale_date, channel_id, product_code)` is tens of thousands of
rows/year. Order-grain `stg_orders` at ~1–2k orders/day across all channels is ~500k–700k rows/
year. Add marketing, traffic, inventory snapshots, P&L lines — still small-to-medium. Postgres
handles tens of millions of rows trivially.
- **What to add as dashboards widen:** composite indexes on each fact grain + date; **materialized
  daily/monthly rollups** (refreshed by cron) so wide dashboard loads hit pre-aggregated data.
- **When Odo becomes the nerve center:** turn on **PITR (point-in-time recovery)** and add a
  **read replica** so analytical reads don't contend with operational writes. Both are paid-tier
  toggles, not rebuilds.

### 2.2 Cloudflare Workers — the one piece to change
Workers are excellent as the **fast API/auth gateway** (what `odoops` mostly is). They are a poor
fit as the **heavy ETL engine** — and we've already hit the wall: the **50-subrequest limit blew
up the Shopify pull in S158** (chunked inserts each cost a subrequest), and the fix was a
workaround (cap 12 pages/run, let cron crawl). As connectors and backfills grow, "one cron worker
pulls everything" keeps hitting that ceiling and the CPU/wall-clock limit.

**Decision: move heavy/growing ingestion to a durable execution model.**
- **Preferred (stay on-platform): Cloudflare Workflows + Queues** — durable, checkpointed,
  multi-step execution with retries that survives the subrequest/CPU ceiling by breaking a pull
  into steps. Each connector run becomes a workflow: fetch page → stage → checkpoint → next.
- **Alternative: Supabase Edge Functions + pg_cron** if we'd rather ETL live next to the DB.
- Keep Workers as the request/response API the apps call. **Do this before scaling connector
  count.**

### 2.3 Federated P&L — the stack's strongest suit
Normally the hardest part of a control station (a warehouse + ETL between systems). **We don't
need any of it: every LOT system already lives in the same Postgres database as a separate schema**
(`manifest`, `snorkel`, `podium`, `store`, `sales`, …). Odo's service-role worker reads across
schemas in plain SQL. Near-free federation.
- **Discipline that makes it robust:** each source system exposes **stable contract views**
  (e.g. `manifest.v_landed_cost_per_unit`, `podium.v_monthly_burn`,
  `redline.v_unit_production_cost`, `depot.v_fill_rate`) and Odo reads **those, never raw tables**.
  A schema change inside Podium then can't silently break the P&L — the source system owns its
  contract.

### 2.4 Security — the underweighted part
Once Odo holds sales + margin + COGS + salary-derived SG&A + CAC in one place, it is **the most
sensitive surface in the company — more than Podium.** Before wide rollout it needs a first-class
role model: who sees revenue vs. margin vs. salary-derived costs vs. ad spend. Template already
exists — the **Manifest super-admin + permissions-builder pattern (S153)** with the `active`
kill-switch. Build the `sales_view` / `cost_view` / `margin_view` tiering deliberately, not as an
afterthought (the backlog's "gate /marketing + /funnel behind cost_view" is thread #1).

---

## 3. THE DATA-GRANULARITY CHARTER (the part that must not be gotten wrong)

### 3.1 The principle that resolves the anxiety

> **Staging is the system-of-record for grain and is retained at full fidelity. Fact tables are
> derived, idempotent, and cheap to extend. Adding a measure or dimension later is a column +
> recompute — NOT a re-integration.**

Odo already runs the right shape: adapters stage raw rows into `stg_*`, and
`recompute_*(channel, dates[])` **deletes + reinserts** facts from staging. Because the raw event
is retained, a future "we also want X" is satisfied by:
1. add a column to the fact (or a new fact),
2. extend the recompute to populate it from the **already-stored** staging row,
3. re-run recompute.

**No re-pull. No re-integration.** This is the whole answer to "I don't want to redo schemas to get
more info." It holds *only if staging captures the atomic event at full fidelity.* So the rule:

> **Capture the finest atomic grain and every native attribute at ingestion — even attributes we
> don't use today. Aggregate up in views/RPCs. You can always roll up; you can never split down
> after the fact.**

### 3.2 The "costless now, impossible to backfill later" checklist

These attributes cost nothing to store at ingestion and **cannot be reconstructed from an
aggregate later.** Capture them in staging now for every applicable source:

| Attribute | Why it's needed later | Lost if not captured? |
|---|---|---|
| **Raw source IDs** (order_id, line_id, settlement_id, ad_id, refund_id) | Idempotent dedupe, reconciliation, re-pull keying | Yes — can't re-key |
| **Full timestamp (UTC)** + derived IST date | Intraday, cohort timing, correct day-grain (RULE-SALES-001) | Yes — date-only loses the time |
| **Raw channel SKU** + resolved product_code | Recover unmapped, re-map history | Yes |
| **qty, unit/gross price, discount, tax** (per line) | Net ladder, AOV, margin | Yes |
| **Ship-to geography (state)** | GST CGST/SGST vs IGST split; regional analysis | Yes |
| **Fulfillment node / type** (FBA/FBM/Flex/IXD, warehouse) | Channel attribution, fill-rate, double-count guards | Yes |
| **Order status + cancellation flag + return/refund linkage** | Cancellations vs returns split (already a RULE) | Yes |
| **Currency** | Export channels, multi-currency | Yes |
| **Customer id / new-vs-returning** | Cohorts, repeat-rate, CAC payback | Yes — aggregates erase identity |
| **Order tags / type** | Replacement/influencer/repair/internal segregation | Yes |

### 3.3 Per-domain target grain

**Sales — atomic = order LINE + order HEADER (both retained in staging).**
- Line grain: order_id, line_id, channel, channel_sku, product_code, qty, unit_price, gross,
  discount, tax, row_type(sale|return), fulfillment node/type, occurred_at(UTC).
- Header grain: order_id, channel, order_date(UTC), ship-to state, currency, customer_id,
  new/returning, status, cancellation flag, tags, order-level discount/tax totals (authoritative —
  per-line undercounts order-level codes, per S158).
- Derived facts: `sales_fact` (product×day×channel) for the variant mix; `stg_orders`
  (order/return grain) queried directly for order metrics. **Keep both** — order counts/tags are
  intrinsically order-grain; the product fact can't express them.

**Settlement — a FIRST-CLASS SEPARATE FACT, not a column on sales.** (Currently missing — the gap.)
- True net (NMV / Platform Fee / CM1) comes from **marketplace settlement / payout reports**, not
  order data. Order APIs give GMV + order-level tax/discount/cancellations; settlement gives
  commission, payment fee, shipping charged/charged-back, TCS/TDS, **actually-settled amount**,
  settlement date.
- Grain: settlement-line, keyed to order/line where the marketplace provides it. This is the data
  source that makes deliverable #2 (net) and #3 (P&L) *accurate* rather than estimated.

**Marketing / ads — go as DEEP as the API returns cheaply; roll up in views.**
- `mkt_fact` today = (platform, ad_account, campaign, date). Per-creative weed-out (use case #2)
  needs **ad-group / ad / creative / keyword / target / ASIN** grain. Capture those raw in staging
  now where the report provides them — otherwise we re-pull to get creative-level later.
- Keep ad_id / adset_id / creative_id / keyword / ASIN identifiers raw.

**Traffic / web (GA4).**
- Grain: date × source/medium × campaign × landing page × device. Item-level (item views,
  add-to-cart, purchases) for funnel-by-product. Capture source/medium/campaign + device + landing
  page; don't collapse to channel-group only if product-funnel is wanted.

**Inventory / pricing / availability (not built yet — design the grain now).**
- **Append-only DAILY SNAPSHOT** = (snapshot_date, channel/location, product_code) →
  quantity_available, quantity_reserved, in_transit, MRP/listed_price, discount, listing_status.
- Snapshot, not "current" — capturing only current state loses history and kills "availability/
  pricing over time" (use case #3). Storage is cheap; a daily snapshot per SKU×channel is
  hundreds of thousands of rows/year (fine).

**P&L line-item fact.**
- Grain: (period_start, period_grain[day|month], channel, line_code, value, source_system).
- `line_code` = ordered waterfall enum (GMV, RTO, Refund, Taxes, NMV, COGS, GM, Logistics,
  Platform_Fee, CM1, CAC, CM2, Brand_Marketing, SGA, EBITDA).
- **Don't lock to month-only** — lines have mixed native grain (GMV is daily; SG&A is monthly).
  Store each line at its finest natural grain and aggregate. `source_system` tags provenance for
  traceability (which fact/schema produced the number).

### 3.4 Cross-cutting grain rules (do not violate)
- **IST day grain** for sale_date (`occurred_at AT TIME ZONE 'Asia/Kolkata'`) — never a UTC
  `todayISO()` (RULE-SALES-001).
- **Idempotency = recompute, not append** — every adapter upserts staging on a real natural key
  (`?on_conflict=`, per the S158 fix / PATTERN-150) and facts are delete+reinsert by
  (channel, dates). A re-pull is a no-op on totals; a cancellation/refund nets out on recompute.
- **Channel registry = `public.dispatch_channels`** (never a parallel registry).
  **Variant key = `public.product_master.product_code`.**
- **Unmapped SKUs are retained in staging** (excluded from facts until mapped) so resolving a
  mapping backfills history with a recompute — never a re-pull.

---

## 4. Channel acquisition strategy (accuracy-first)

**Principle (Afshaan): direct integrations where we have access; aggregator only where we don't.**
- **Direct:** Amazon (SP-API, live), Flipkart (v3, blocked on Flipkart approval), Shopify (live).
- **Aggregator fallback — Unicommerce:** already plugged in, has APIs. Strong fit for **quick
  commerce + long-tail + CRED** (CRED has no reporting at all) because it's *one* integration that
  covers many quirky platforms — exactly the consolidation goal. Use it for channels we don't
  control directly; it can also serve as an **accuracy cross-check** against direct pulls.
- **Retire** the gsheet QC connectors once Unicommerce covers QC.
- Long-term north star: our own internal systems run the business with direct integrations; Odo is
  the consolidation layer until then.

### 4.1 Unicommerce (Uniware) integration brief (researched S159, official docs)

Two API families — we use the **Uniware Seller APIs** (pull our own data out), NOT the Marketplace
APIs (those are for marketplaces plugging *into* Unicommerce). REST/JSON/HTTPS.

**Auth — OAuth password grant:**
- Token endpoint: `https://{tenant}.unicommerce.com/oauth/token`
- Params: `grant_type=password`, `client_id=my-trusted-client` (fixed), `username`, `password`.
- Returns `access_token` (bearer), `refresh_token`, `expires_in` (~11–12h). Refresh token valid 30d.
- Every call: `Authorization: bearer {token}` + a **`Facility`** header (facility code).
- Prereq: API user is an **Admin** in Uniware with facility access.

**Data-pull patterns:**
- **Export Job (async CSV) — THE ingestion path.** `POST /services/rest/v1/export/job/create`
  (body: `exportJobTypeName` = the Uniware report name e.g. Sale Order Item report, `exportColums`,
  `exportFilters` with `channel` + `dateRange`, `frequency:"ONETIME"`) → returns `jobCode` → poll
  `GET /docs/export-status.html` (`export/job/status`) until complete → download `.csv` link.
  Line-level, bulk, channel+date filtered, **no N+1** — pairs with the Workflows/Queues async
  ingestion model (create→poll→download across steps). Use `dateType=UPDATED` so re-pulls catch
  cancellations/returns/status changes → feeds idempotent recompute.
- `POST /services/rest/v1/oms/saleOrder/search` — header-level only (channel, status, fromDate/
  toDate, dateType CREATED|UPDATED|FULFILLMENT_TAT, facilityCodes, pagination). No SKU/qty/price.
- `POST /services/rest/v1/oms/saleorder/get` (`code`, `facilityCodes`) — full line detail per
  order, but N+1; use only for spot lookups, not bulk.

**Granularity (matches our charter — line level):** `channel`, `displayOrderDateTime`, `itemSku`,
`channelProductId`, `quantity`, `sellingPrice`, `totalPrice`, `discount`, **full GST split**
(`totalCentralGst`/`totalStateGst`/`totalIntegratedGst`/`totalUnionTerritoryGst` + %), `cod`,
`prepaidAmount`, `paymentMode`, shipping charges, `voucherCode`/`voucherValue`/`storeCredit`,
`status` (incl. CANCELLED). Order-level: ship-to `state` (CGST/SGST vs IGST), `customerGSTIN`,
`currencyCode`. Returns via the Returns API + `returnStatuses` filter.

**Caveat:** Unicommerce is an OMS — it has the ORDER (GMV/GST/discount/qty/channel/returns), NOT the
marketplace SETTLEMENT. Settlement-grade net (commission, fees, actual payout) still comes from each
marketplace's settlement report (the separate settlement fact, §3.3). Unicommerce closes the
order-grain gap for channels we can't reach directly; it does not replace settlement ingestion.

**Inventory:** `Get Inventory Snapshot` exists but is **SOAP** (not REST) — usable for the
daily-snapshot inventory domain, different call style.

**Flipkart-via-Unicommerce:** Flipkart is already a configured channel in our Uniware, so its orders
flow in tagged `channel=FLIPKART…` — the Export Job filtered to that channel gives Flipkart sell-out
at line level with **no Flipkart developer approval needed**. This is the backstop if direct Flipkart
access stays blocked.

**To start (need from Afshaan):** (1) tenant subdomain; (2) an Admin API user (username+password)
created in Uniware with facility access; (3) facility code(s); (4) which channels are live in our
Uniware. Then: build a `unicommerce` adapter (OAuth + token cache/refresh → Export Job create/poll →
CSV → `stg_*` → recompute), same shape as existing connectors.

Sources: documentation.unicommerce.com (oauth.html, using-the-uniware-apis.html, export-create.html,
saleorder-search.html, saleorder-get.html) + support.unicommerce.com (get-inventory-snapshot).

---

## 5. Running P&L model (per channel + consolidated)

Matches the reference contribution-margin format:

```
GMV
  − RTO
  − Refund
  − Taxes (GST)
= NMV / Revenue          ← the recognised-revenue number (net of GST, returns, refunds, settlement)
  − COGS
= GM (Gross Margin)
  − Logistics
  − Platform Fee
= CM1
  − CAC
= CM2
  − Brand Marketing
  − SG&A
= EBITDA
```

- Some lines come from Odo's own facts (GMV, Refund, Taxes, CAC, Brand Marketing).
- Some come from **settlement** (NMV-grade, Platform Fee, Logistics-charged).
- Some come from **federation** via contract views (COGS ← Manifest/Snorkel; SG&A ← Podium;
  per-unit cost ← Redline).
- **Product P&L over time** (use case #4) = the same line model sliced to product_code across
  periods.

---

## 6. Sequencing — Now vs Later (respecting "basic but accurate, ASAP")

**NOW (the immediate, important, accurate-numbers phase):**
1. **Fix accuracy on the major live channels** — verify the S158 undercount fix landed (Website
   reconciles), close the channel-coverage gaps for the channels we *can* read today.
2. **Ingestion infra** — move connectors onto Cloudflare Workflows/Queues (or Edge Functions) so
   the subrequest ceiling stops being a constraint and backfills are durable.
3. **Lock the grain** per §3 — make sure staging captures the full-fidelity atomic event +
   the "costless now" attributes (§3.2) for every live connector, **before** building depth.
4. **A little polish** — enough that Odo is a daily-usable platform (the per-channel dashboard +
   net ladder). Defer heavy formatting/reskins.

**LATER (depth over time, no rush):**
- Settlement ingestion → accurate net + P&L.
- Inventory/pricing daily-snapshot domain.
- Marketing depth (creative/keyword drill, per-channel ROAS/CAC).
- Federated P&L lines via contract views (COGS, SG&A, production cost, fill-rate).
- Cost-tier role model before wide rollout.
- Unicommerce for QC/long-tail/CRED.
- Eventually: actions / control plane (write-back behind approvals + audit).

---

## 7. Open decisions for Afshaan
1. **Ingestion infra:** Cloudflare Workflows/Queues (stay on-platform) vs Supabase Edge
   Functions/pg_cron — pick the lane before scaling connectors.
2. **Net-revenue governing rules** — still TBD (see `[[project-odo-net-revenue]]`). Net = ex-GST,
   after cancellations/returns/settlement, but the exact definition (e.g. how RTO vs return vs
   refund net out, what counts as "settled") needs to be pinned before the all-channel net default.
3. **Which channels are material** among the unwired long-tail (Events, Export, Sold-from-WH, Cred,
   Peeko, Firstcry) — decides Unicommerce scope vs manual upload.
4. **First deliverable to build out** — recommended: all-channel dashboard + net model (#1/#2),
   since P&L (#3) and ad depth (#4) build on that foundation.
