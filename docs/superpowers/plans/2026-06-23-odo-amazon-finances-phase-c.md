# Odo Phase C — Amazon net-revenue via Finances API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Amazon real discounts, GST split, and returns in the segregation ladder (fact grain + `/performance` order grain) by ingesting the SP-API Finances API alongside the existing all-orders report.

**Architecture:** A new finance phase inside `amazonAdapter.fetch` pulls `listFinancialEvents` (posted-date windows, own `fin_cursor`) into a new `sales.stg_amazon_fin` table. A `v_staged` branch turns shipment events into *zero-gross* sale rows (adding only discount+tax — no double-count) and refund events into return rows, so `recompute_facts` fills `sales_fact` with **no RPC change**. Order-grain returns go to `stg_orders` (mirrors Shopify); order-grain discount/tax come from one `f_order_rollup` edit.

**Tech Stack:** Cloudflare Worker (single-file `odoops-worker/src/index.js`, ES modules, `fetch`), Supabase Postgres (`sales` schema, PostgREST), SP-API Finances v0 (LWA token, EU host).

**Spec:** `docs/superpowers/specs/2026-06-23-odo-amazon-finances-phase-c-design.md`

**Conventions (from CLAUDE.md):** PostgREST numerics come back as strings → wrap arithmetic in `Number()`/the `num()` helper; integer inserts via `Math.round()`; 50-subrequest cap (never loop-await per row); every new `sales.*` table needs `GRANT ALL ... TO service_role`; cross-repo git via `git -C`; worker deploy = edit → commit → push → `cd odoops-worker && npx wrangler deploy`. There is **no unit-test harness** for the worker — verification is a `canConnector`-gated diagnostic probe (the established `amazonProbe`/`uniwareProbe` pattern) plus live SQL reconciliation. The plan uses **probe-first** (parse a real window and eyeball it before wiring staging) as the test-first analog.

Amazon channel id (`Amazon - FBA`): resolve once with
`SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA';` (currently `855de0ca-…`). Project id `jkxcnjabmrkteanzoofj`.

---

## Task 1: Migration — `stg_amazon_fin` table + `v_staged` enrichment branch

**Files:**
- DB migration (apply via Supabase `apply_migration`, name `odo_amazon_finances_staging_v1`)

- [ ] **Step 1: Apply the migration**

Run `apply_migration` with name `odo_amazon_finances_staging_v1` and this SQL:

```sql
-- Finance event store: atomic Principal/Tax/Promotion per Amazon order-item (shipment) and
-- per refund. Separate table → the orders-report date-range supersede of stg_amazon never wipes it.
CREATE TABLE IF NOT EXISTS sales.stg_amazon_fin (
  id              bigserial PRIMARY KEY,
  run_id          bigint,
  channel_id      uuid NOT NULL,
  amazon_order_id text NOT NULL,
  seller_sku      text NOT NULL,
  event_type      text NOT NULL,                       -- 'shipment' | 'refund'
  posted_date     date NOT NULL,                       -- IST day of the finance PostedDate
  qty             int  NOT NULL DEFAULT 0,
  principal       numeric(14,2) NOT NULL DEFAULT 0,    -- ex-tax item price
  tax             numeric(14,2) NOT NULL DEFAULT 0,    -- GST within the tax-incl gross
  promo           numeric(14,2) NOT NULL DEFAULT 0,    -- discount (positive magnitude)
  raw             jsonb,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, amazon_order_id, seller_sku, event_type, posted_date)
);
ALTER TABLE sales.stg_amazon_fin ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.stg_amazon_fin TO service_role;
GRANT USAGE, SELECT ON SEQUENCE sales.stg_amazon_fin_id_seq TO service_role;
CREATE INDEX IF NOT EXISTS stg_amazon_fin_lookup_idx ON sales.stg_amazon_fin (channel_id, event_type, posted_date);
CREATE INDEX IF NOT EXISTS stg_amazon_fin_order_lookup_idx ON sales.stg_amazon_fin (channel_id, amazon_order_id);

-- Recreate v_staged with two amazon_fin branches:
--   shipment → zero-gross 'sale' row (adds discount+tax only, dated to the ORDER's purchase date
--              from stg_orders so it lands on the same day as the gross it modifies);
--   refund   → 'return' row (qty + tax-incl gross, dated to the refund posted_date).
CREATE OR REPLACE VIEW sales.v_staged AS
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled,
         'shopify'::text AS src, row_type, discount_value, tax_value FROM sales.stg_shopify
  UNION ALL
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled,
         'snorkel'::text, row_type, discount_value, tax_value FROM sales.stg_snorkel
  UNION ALL
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled,
         'qc'::text, row_type, discount_value, tax_value FROM sales.stg_qc
  UNION ALL
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled,
         'amazon'::text, row_type, discount_value, tax_value FROM sales.stg_amazon
  UNION ALL
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled,
         'uniware'::text, row_type, discount_value, tax_value FROM sales.stg_uniware
  UNION ALL                                                   -- amazon_fin: shipment enrichment
  SELECT f.channel_id, ord.sale_date, f.seller_sku,
         0::int AS qty, 0::numeric AS gross_value, false AS is_cancelled,
         'amazon_fin'::text, 'sale'::text AS row_type,
         f.promo AS discount_value, f.tax AS tax_value
  FROM sales.stg_amazon_fin f
  JOIN sales.stg_orders ord
    ON ord.channel_id = f.channel_id AND ord.source_order_id = f.amazon_order_id AND ord.row_kind = 'order'
  WHERE f.event_type = 'shipment'
  UNION ALL                                                   -- amazon_fin: refund → return row
  SELECT f.channel_id, f.posted_date AS sale_date, f.seller_sku,
         f.qty, (f.principal + f.tax) AS gross_value, false AS is_cancelled,
         'amazon_fin'::text, 'return'::text AS row_type,
         0::numeric AS discount_value, f.tax AS tax_value
  FROM sales.stg_amazon_fin f
  WHERE f.event_type = 'refund';
```
- [ ] **Step 2: Verify the table and view shape**

Run via `execute_sql`:

```sql
SELECT count(*) AS rows FROM sales.stg_amazon_fin;                       -- expect 0
SELECT count(*) AS staged_total FROM sales.v_staged;                     -- expect = pre-migration count (no error)
SELECT DISTINCT src FROM sales.v_staged ORDER BY 1;                      -- expect incl. 'amazon_fin'
```
Expected: table empty, view selectable, `amazon_fin` present in `src`. Because `stg_amazon_fin` is empty, `staged_total` is unchanged from before — confirms no double-count yet.

- [ ] **Step 3: Confirm recompute is still byte-identical (idempotency guard)**

Pick a recent settled Amazon date with facts, snapshot it, re-run recompute, diff:

```sql
SELECT product_code, units, gross_value, discount_value, tax_value
FROM sales.sales_fact f JOIN public.dispatch_channels d ON d.id=f.channel_id
WHERE d.name='Amazon - FBA' AND f.sale_date='2026-06-15' ORDER BY product_code;
-- then:
SELECT sales.recompute_facts((SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA'), ARRAY['2026-06-15']::date[], NULL);
-- re-run the first SELECT — rows must be identical (stg_amazon_fin empty → no change).
```
Expected: identical before/after. This proves the new view branch is inert until finance data lands.

- [ ] **Step 4: Commit (migration is already in the DB; record it in the repo if migrations are tracked there)**

No repo file changes in this task (migration applied directly via MCP, per the web/remote Supabase workflow). Proceed to Task 2.

---

## Task 2: Migration — `f_order_rollup` folds Amazon finance discount/tax

**Files:**
- DB migration (apply via `apply_migration`, name `odo_f_order_rollup_amazon_finance_v1`)

**Why a sum works for all channels:** only Amazon has `stg_amazon_fin` rows, and Amazon's `stg_orders` order rows carry `discount=0`/`tax=0` (the report can't fill them). Non-Amazon channels have no finance rows. So `stg_orders_discount + finance_discount` equals the finance value for Amazon and the `stg_orders` value for everyone else — no channel hardcoding. Returns at order grain already come from `stg_orders` return rows (Task 3 writes Amazon's), so `f_order_rollup` needs **no** returns change.

- [ ] **Step 1: Apply the migration**

Run `apply_migration` with name `odo_f_order_rollup_amazon_finance_v1` and this SQL (the `fin` CTE + two added terms are the only changes vs the live definition):

```sql
CREATE OR REPLACE FUNCTION sales.f_order_rollup(p_from date, p_to date, p_channels uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(sale_date date, channel_id uuid, orders bigint, cancelled_orders bigint, gross numeric, cancelled_value numeric, discount numeric, tax numeric, returns_count bigint, returns_value numeric, replacement_orders bigint, influencer_orders bigint, repair_orders bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'sales', 'public'
AS $function$
  WITH o AS (
    SELECT s.*,
      COALESCE(ARRAY(
        SELECT DISTINCT r.order_type FROM sales.order_type_rules r
        WHERE r.is_active AND (r.channel_id IS NULL OR r.channel_id = s.channel_id)
          AND EXISTS (SELECT 1 FROM unnest(s.tags) t WHERE
                (r.match_kind='tag_exact'  AND lower(t)=lower(r.pattern)) OR
                (r.match_kind='tag_prefix' AND lower(t) LIKE lower(r.pattern)||'%'))
      ), '{}')::text[] AS types
    FROM sales.stg_orders s
    WHERE s.sale_date BETWEEN p_from AND p_to
      AND (p_channels IS NULL OR s.channel_id = ANY(p_channels))
  ),
  fin AS (                                   -- Amazon finance shipment discount/GST, keyed to the order's purchase date
    SELECT f.channel_id, ord.sale_date,
           SUM(f.promo) AS fin_discount,
           SUM(f.tax)   AS fin_tax
    FROM sales.stg_amazon_fin f
    JOIN sales.stg_orders ord
      ON ord.channel_id = f.channel_id AND ord.source_order_id = f.amazon_order_id AND ord.row_kind='order'
    WHERE f.event_type='shipment'
      AND ord.sale_date BETWEEN p_from AND p_to
      AND (p_channels IS NULL OR f.channel_id = ANY(p_channels))
    GROUP BY f.channel_id, ord.sale_date
  )
  SELECT o.sale_date, o.channel_id,
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled),
    COUNT(*)  FILTER (WHERE row_kind='order' AND is_cancelled),
    COALESCE(SUM(gross)    FILTER (WHERE row_kind='order' AND NOT is_cancelled),0),
    COALESCE(SUM(gross)    FILTER (WHERE row_kind='order' AND is_cancelled),0),
    COALESCE(SUM(discount) FILTER (WHERE row_kind='order' AND NOT is_cancelled),0) + COALESCE(MAX(fin.fin_discount),0),
    COALESCE(SUM(tax)      FILTER (WHERE row_kind='order' AND NOT is_cancelled),0) + COALESCE(MAX(fin.fin_tax),0),
    COUNT(*)  FILTER (WHERE row_kind='return'),
    COALESCE(SUM(returned_value) FILTER (WHERE row_kind='return'),0),
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled AND 'replacement'=ANY(types)),
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled AND 'influencer'=ANY(types)),
    COUNT(*)  FILTER (WHERE row_kind='order' AND NOT is_cancelled AND 'repair'=ANY(types))
  FROM o LEFT JOIN fin ON fin.channel_id=o.channel_id AND fin.sale_date=o.sale_date
  GROUP BY o.sale_date, o.channel_id
$function$;
```

`MAX(fin.fin_discount)` is correct because `fin` has exactly one row per `(channel_id, sale_date)`, so the value is constant across the group and the LEFT JOIN does not multiply `o` rows.

- [ ] **Step 2: Verify signature unchanged + non-Amazon untouched**

```sql
-- Shape unchanged (13 columns, same names):
SELECT * FROM sales.f_order_rollup('2026-06-01','2026-06-20') LIMIT 1;
-- A non-Amazon channel (Website) is byte-identical to before — finance CTE is empty for it:
SELECT sale_date, discount, tax FROM sales.f_order_rollup('2026-06-01','2026-06-20',
  ARRAY[(SELECT id FROM public.dispatch_channels WHERE name ILIKE '%website%' OR name ILIKE '%shopify%' LIMIT 1)])
ORDER BY sale_date LIMIT 5;
```
Expected: runs without error; Website discount/tax match values seen before this migration (finance rows don't exist for Website). Amazon discount/tax still 0 here (no finance data yet — fills in after Task 4).

---

## Task 3: Worker — finance fetch + parse + staging + diagnostic

**Files:**
- Modify: `odoops-worker/src/index.js` — add finance helpers + `fetchAmazonFinanceWindow`; extract the report state machine into `amazonReportPhase`; extend `amazonAdapter.fetch`/`stage`/`datesOf`; add `stageAmazonFinance`; one-line `executeRun` edit; add `financeProbe` action.

- [ ] **Step 1: Add finance parse + window-fetch helpers** (immediately after `createAmazonReport`, before `const amazonAdapter`)

```javascript
// ── Amazon Finances (SP-API listFinancialEvents) → discount/GST/returns ────────
// The all-orders report carries gross+units+cancellations but the IN marketplace ships
// item-tax/promotion BLANK. The Finances API exposes Principal/Tax/Promotion per order-item
// (+ refund events). Stored in stg_amazon_fin; surfaced via the v_staged amazon_fin branch.
// Own posted-date cursor (config.fin_cursor) — independent of the report cursor.
const AMZ_FIN_WINDOW_MS = 7 * 24 * 3600 * 1000;   // posted-date windows
const AMZ_FIN_MAX_PAGES = 6;                       // ≤~600 events/tick — keeps subreqs well under the cap
function amzCharge(list, type) { let s = 0; for (const c of (list || [])) if (c.ChargeType === type) s += num(c.ChargeAmount?.CurrencyAmount); return s; }
function amzPromo(list) { let s = 0; for (const p of (list || [])) s += num(p.PromotionAmount?.CurrencyAmount); return s; }
// One financialEvents payload → flat finance rows (aggregated by stageAmazonFinance).
function parseAmazonFinance(fe) {
  const out = [];
  for (const ev of (fe?.ShipmentEventList || [])) {
    const oid = ev.AmazonOrderId, pd = ev.PostedDate ? istDate(ev.PostedDate) : null;
    if (!oid || !pd) continue;
    for (const it of (ev.ShipmentItemList || [])) {
      const sku = it.SellerSKU; if (!sku) continue;
      out.push({ amazon_order_id: oid, seller_sku: sku, event_type: 'shipment', posted_date: pd,
        qty: Math.abs(num(it.QuantityShipped)),
        principal: amzCharge(it.ItemChargeList, 'Principal'), tax: amzCharge(it.ItemChargeList, 'Tax'),
        promo: Math.abs(amzPromo(it.PromotionList)), raw: it });
    }
  }
  for (const ev of (fe?.RefundEventList || [])) {
    const oid = ev.AmazonOrderId, pd = ev.PostedDate ? istDate(ev.PostedDate) : null;
    if (!oid || !pd) continue;
    for (const it of (ev.ShipmentItemAdjustmentList || [])) {
      const sku = it.SellerSKU; if (!sku) continue;
      out.push({ amazon_order_id: oid, seller_sku: sku, event_type: 'refund', posted_date: pd,
        qty: Math.abs(num(it.QuantityShipped)),
        principal: Math.abs(amzCharge(it.ItemChargeAdjustmentList, 'Principal')),
        tax: Math.abs(amzCharge(it.ItemChargeAdjustmentList, 'Tax')),
        promo: Math.abs(amzPromo(it.PromotionAdjustmentList)), raw: it });
    }
  }
  return out;
}
// Fetch ONE posted-date finance window (paged, ≤AMZ_FIN_MAX_PAGES). PostedBefore must be ≥2min ago.
async function fetchAmazonFinanceWindow(host, H, cfg, nowMs) {
  const startISO = cfg.fin_cursor || cfg.backfill_start || BACKFILL_START;
  const startMs = Date.parse(startISO) || nowMs;
  if (startMs >= nowMs - 120_000) return { events: [], finCursorAfter: null, partial: false, subreqs: 0 }; // caught up
  const endMs = Math.min(startMs + AMZ_FIN_WINDOW_MS, nowMs - 120_000);
  const endISO = new Date(endMs).toISOString();
  const events = []; let nextToken = null, pages = 0, subreqs = 0, partial = false;
  do {
    const qs = nextToken
      ? `MaxResultsPerPage=100&NextToken=${encodeURIComponent(nextToken)}`
      : `MaxResultsPerPage=100&PostedAfter=${encodeURIComponent(startISO)}&PostedBefore=${encodeURIComponent(endISO)}`;
    const r = await fetch(`${host}/finances/v0/financialEvents?${qs}`, { headers: H }); subreqs++;
    if (r.status === 429) { partial = true; break; }                       // throttled → resume window next tick
    if (!r.ok) throw new Error(`Amazon finances ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
    const j = await r.json();
    events.push(...parseAmazonFinance(j.payload?.FinancialEvents || {}));
    nextToken = j.payload?.NextToken || null; pages++;
    if (nextToken && pages >= AMZ_FIN_MAX_PAGES) { partial = true; break; } // more pages → resume next tick
  } while (nextToken);
  return { events, finCursorAfter: partial ? null : endISO, partial, subreqs }; // advance only on a fully-paged (incl. empty) window
}
```

- [ ] **Step 2: Add `financeProbe` diagnostic FIRST (probe-first — eyeball real data before wiring staging)**

Add a new `case` next to `amazonProbe` (after the `amazonProbe` block, ~line 1375). It fetches one window and returns parsed counts + a sample, WITHOUT writing anything:

```javascript
          case 'financeProbe': {  // diagnostic: parse one Finances window (no staging) — verify the mapping
            if (!canConnector(P)) return err('No permission', 403);
            let token; try { token = await getAmazonToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const host = qp('host') || 'https://sellingpartnerapi-eu.amazon.com';
            const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token, 'Content-Type': 'application/json' };
            const after = qp('after'); const before = qp('before');
            if (!after || !before) return err('after + before (ISO) required');
            const r = await fetch(`${host}/finances/v0/financialEvents?MaxResultsPerPage=100&PostedAfter=${encodeURIComponent(after)}&PostedBefore=${encodeURIComponent(before)}`, { headers: H });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) return err(`finances ${r.status}: ${JSON.stringify(j).slice(0, 200)}`, 400);
            const fe = j.payload?.FinancialEvents || {};
            const ev = parseAmazonFinance(fe);
            const ship = ev.filter(e => e.event_type === 'shipment'), ref = ev.filter(e => e.event_type === 'refund');
            return ok({ status: r.status, hasNextToken: !!j.payload?.NextToken,
              shipmentItems: ship.length, refundItems: ref.length,
              shipTotals: { principal: ship.reduce((s, e) => s + e.principal, 0), tax: ship.reduce((s, e) => s + e.tax, 0), promo: ship.reduce((s, e) => s + e.promo, 0) },
              sampleShipment: ship[0] || null, sampleRefund: ref[0] || null });
          }
```

- [ ] **Step 3: Extract the report state machine into `amazonReportPhase`**

Replace the body of `amazonAdapter.fetch` (lines ~495–542, from `async fetch(...)` through the final `return { rows: [], cursorAfter: null, subreqs, partial: true };`) so the report logic lives in a standalone function that **returns** its config patch (instead of patching directly on success) — required so the finance fin_cursor patch later merges onto the post-report config and doesn't clobber `pending_report_id`. Add this function just before `const amazonAdapter`:

```javascript
// Report state machine (create→poll→ingest, one ≤30-day window/tick). Returns the rows for this
// window + the config it should persist (configAfter) so the caller can merge fin_cursor in one write.
async function amazonReportPhase(host, H, mkt, columns, cfg, channelId, nowMs, cursor) {
  let subreqs = 1; // token already fetched by caller; count it once here for parity with prior logs
  if (cfg.pending_report_id) {
    const pr = await fetch(`${host}/reports/2021-06-30/reports/${cfg.pending_report_id}`, { headers: H }); subreqs++;
    if (!pr.ok) throw new Error(`Amazon getReport ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
    const rep = await pr.json();
    const st = rep.processingStatus;
    if (st === 'IN_QUEUE' || st === 'IN_PROGRESS') return { rows: [], cursorAfter: null, subreqs, partial: true, configAfter: cfg };
    if (st === 'CANCELLED' || st === 'FATAL') { await patchConnectorConfig(channelId, cfg, { pending_report_id: null, pending_through: null }); throw new Error(`Amazon report ${st}`); }
    const dr = await fetch(`${host}/reports/2021-06-30/documents/${rep.reportDocumentId}`, { headers: H }); subreqs++;
    if (!dr.ok) throw new Error(`Amazon getDocument ${dr.status}`);
    const doc = await dr.json();
    const text = await fetchAmazonDoc(doc); subreqs++;
    if (/date range exceeded/i.test(text)) throw new Error('Amazon: ' + text.trim().slice(0, 120));
    const grid = text.split(/\r?\n/).filter(l => l.length).map(l => l.split('\t'));
    const rows = grid.length >= 2 ? gridToQcRows(grid, columns, todayISO()) : [];
    const windowEnd = cfg.pending_through;
    const endMs = Date.parse(windowEnd || '') || 0;
    let partial = false, next = { pending_report_id: null, pending_through: null };
    if (endMs && endMs < nowMs - 60_000) {
      const nextEnd = new Date(Math.min(endMs + AMZ_WINDOW_MS, nowMs)).toISOString();
      try { const rid = await createAmazonReport(host, H, mkt, windowEnd, nextEnd); subreqs++; next = { pending_report_id: rid, pending_through: nextEnd }; partial = true; }
      catch (_) { /* leave pending cleared — next tick re-creates from the advanced cursor */ }
    }
    return { rows, cursorAfter: windowEnd, subreqs, partial, configAfter: { ...cfg, ...next } };
  }
  const startISO = cursor || cfg.backfill_start || BACKFILL_START;
  const startMs = Date.parse(startISO) || nowMs;
  const endISO = new Date(Math.min(startMs + AMZ_WINDOW_MS, nowMs)).toISOString();
  const rid = await createAmazonReport(host, H, mkt, startISO, endISO); subreqs++;
  return { rows: [], cursorAfter: null, subreqs, partial: true, configAfter: { ...cfg, pending_report_id: rid, pending_through: endISO } };
}
```

Then replace `amazonAdapter.fetch` with the thin orchestrator that runs report + finance and persists config **once**:

```javascript
const amazonAdapter = {
  kind: 'amazon_spapi', stgTable: 'stg_amazon', sourceKind: 'amazon',
  async fetch({ env, channelId, cursor, config }) {
    const cfg = config || {};
    const host = cfg.region_host || 'https://sellingpartnerapi-eu.amazon.com';
    const mkt = cfg.marketplace_id;
    if (!mkt) throw new Error('amazon config missing marketplace_id (set connector_config.config)');
    const columns = cfg.columns || AMZ_COLUMNS_DEFAULT;
    const token = await getAmazonToken(env);
    const H = { Authorization: `Bearer ${token}`, 'x-amz-access-token': token, 'Content-Type': 'application/json' };
    const nowMs = Date.now();
    const rep = await amazonReportPhase(host, H, mkt, columns, cfg, channelId, nowMs, cursor);
    // Finance phase — cheap (≤AMZ_FIN_MAX_PAGES pages). Must never break the orders pipeline.
    let finance = { events: [] }, finSub = 0, configAfter = rep.configAfter;
    try {
      const fw = await fetchAmazonFinanceWindow(host, H, configAfter, nowMs);
      finSub = fw.subreqs; finance = { events: fw.events };
      if (fw.finCursorAfter) configAfter = { ...configAfter, fin_cursor: fw.finCursorAfter };
    } catch (e) { finance = { events: [], error: String(e?.message || e) }; }
    // Persist report + finance config in ONE write (avoids clobbering pending_report_id).
    await patchConnectorConfig(channelId, cfg, configAfter);
    return { rows: rep.rows, cursorAfter: rep.cursorAfter, subreqs: rep.subreqs + finSub, partial: rep.partial, finance };
  },
```

Note: `patchConnectorConfig(channelId, cfg, configAfter)` merges `configAfter` onto `cfg`; since `configAfter` already started from `cfg`, this writes the full intended jsonb. The CANCELLED/FATAL path still patches+throws inside `amazonReportPhase` (error path — finance won't run; correct).

- [ ] **Step 4: Extend `amazonAdapter.stage` + add `datesOf`** (replace the existing `stage(rows, runId, channelId)` and close the object)

```javascript
  async stage(rows, runId, channelId, fetched) {
    if (rows.length) {
      const from = rows.reduce((m, x) => x.sale_date < m ? x.sale_date : m, rows[0].sale_date);
      const to   = rows.reduce((m, x) => x.sale_date > m ? x.sale_date : m, rows[0].sale_date);
      await sbSales(`/rest/v1/stg_amazon?channel_id=eq.${channelId}&sale_date=gte.${from}&sale_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
      const body = rows.map(r => ({
        run_id: runId, channel_id: channelId, source_order_id: r.source_order_id || null, sale_date: r.sale_date,
        channel_sku: r.channel_sku, title: r.title, qty: Math.round(r.qty), gross_value: r.gross_value,
        discount_value: r.discount_value || 0, tax_value: r.tax_value || 0, row_type: 'sale',
        order_status: r.order_status || null, is_cancelled: !!r.is_cancelled, raw: r.raw,
      }));
      await sbInsertChunked('/rest/v1/stg_amazon', body, 'return=minimal');
      const byOrder = {};
      for (const r of rows) {
        const oid = r.source_order_id; if (!oid) continue;
        const o = (byOrder[oid] = byOrder[oid] || { source_order_id: oid, refund_id: '', row_kind: 'order', sale_date: r.sale_date, order_name: oid, gross: 0, discount: 0, tax: 0, currency: 'INR', is_cancelled: false, returned_value: 0, tags: [] });
        o.gross += num(r.gross_value); o.discount += num(r.discount_value); o.tax += num(r.tax_value);
        if (r.is_cancelled) o.is_cancelled = true;
        if (r.sale_date && r.sale_date < o.sale_date) o.sale_date = r.sale_date;
      }
      await stageOrders(Object.values(byOrder), runId, channelId);
    }
    // Finance: stg_amazon_fin (+ order-grain return rows) and record the dates recompute must touch.
    const ev = (fetched && fetched.finance && fetched.finance.events) || [];
    const affected = await stageAmazonFinance(ev, runId, channelId);
    if (fetched && fetched.finance) fetched.finance.affectedDates = affected;
  },
  datesOf(rows, fetched) {
    const ds = new Set(distinctDates(rows));
    for (const d of ((fetched && fetched.finance && fetched.finance.affectedDates) || [])) ds.add(d);
    return [...ds];
  },
};
```

- [ ] **Step 5: Add `stageAmazonFinance`** (just after the `amazonAdapter` object)

```javascript
// Stage finance events: aggregate by the unique key (split shipments → multiple events/order/sku/date),
// upsert into stg_amazon_fin, write order-grain RETURN rows into stg_orders, and return the set of
// dates recompute_facts must touch (shipment → the order's purchase date; refund → posted_date).
async function stageAmazonFinance(events, runId, channelId) {
  if (!events.length) return [];
  const agg = {};
  for (const e of events) {
    const k = `${e.amazon_order_id}|${e.seller_sku}|${e.event_type}|${e.posted_date}`;
    const a = (agg[k] = agg[k] || { amazon_order_id: e.amazon_order_id, seller_sku: e.seller_sku, event_type: e.event_type, posted_date: e.posted_date, qty: 0, principal: 0, tax: 0, promo: 0, raw: e.raw });
    a.qty += e.qty; a.principal += e.principal; a.tax += e.tax; a.promo += e.promo;
  }
  const all = Object.values(agg);
  const body = all.map(a => ({ run_id: runId, channel_id: channelId, amazon_order_id: a.amazon_order_id, seller_sku: a.seller_sku, event_type: a.event_type, posted_date: a.posted_date, qty: Math.round(a.qty), principal: a.principal, tax: a.tax, promo: a.promo, raw: a.raw }));
  await sbInsertChunked('/rest/v1/stg_amazon_fin?on_conflict=channel_id,amazon_order_id,seller_sku,event_type,posted_date', body, 'return=minimal,resolution=merge-duplicates');
  // Order-grain returns → stg_orders (mirrors Shopify; distinct refund_id so the orders report never wipes them).
  const refundRows = {};
  for (const a of all) {
    if (a.event_type !== 'refund') continue;
    const k = `${a.amazon_order_id}|${a.posted_date}`;
    const o = (refundRows[k] = refundRows[k] || { source_order_id: a.amazon_order_id, refund_id: `fin:${a.posted_date}`, row_kind: 'return', sale_date: a.posted_date, order_name: a.amazon_order_id, gross: 0, discount: 0, tax: 0, currency: 'INR', is_cancelled: false, returned_value: 0, tags: [] });
    o.returned_value += a.principal + a.tax;
  }
  await stageOrders(Object.values(refundRows), runId, channelId);
  // Affected recompute dates: shipment → the order's PURCHASE date (from stg_orders); refund → posted_date.
  const shipOrderIds = uniq(all.filter(a => a.event_type === 'shipment').map(a => a.amazon_order_id));
  let purchaseDates = [];
  if (shipOrderIds.length) {
    const q = await sbSales(`/rest/v1/stg_orders?channel_id=eq.${channelId}&row_kind=eq.order&source_order_id=in.${inList(shipOrderIds)}&select=sale_date`);
    purchaseDates = (q.ok ? q.data : []).map(x => x.sale_date);
  }
  return uniq([...purchaseDates, ...all.filter(a => a.event_type === 'refund').map(a => a.posted_date)]);
}
```

- [ ] **Step 6: One-line `executeRun` edit — pass `fetched` to `datesOf`** (line ~1111)

Change:
```javascript
    const dates = adapter.datesOf ? adapter.datesOf(rows) : distinctDates(rows);
```
to:
```javascript
    const dates = adapter.datesOf ? adapter.datesOf(rows, fetched) : distinctDates(rows);
```
This is backward-compatible: existing `datesOf` impls (e.g. marketing/traffic adapters) ignore the second arg.

- [ ] **Step 7: Sanity-grep the edits**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
grep -n "amazonReportPhase\|fetchAmazonFinanceWindow\|stageAmazonFinance\|parseAmazonFinance\|financeProbe\|datesOf(rows, fetched)" odoops-worker/src/index.js
node --check odoops-worker/src/index.js && echo "SYNTAX OK"
```
Expected: each symbol appears (definition + use sites), and `SYNTAX OK` prints (no parse errors).

- [ ] **Step 8: Commit + deploy**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add odoops-worker/src/index.js
git commit -m "odo: Amazon Finances connector (Phase C) — discount/GST/returns via listFinancialEvents

New finance phase in amazonAdapter (own fin_cursor) → stg_amazon_fin; v_staged
enrichment + recompute fill the ladder; order-grain returns to stg_orders;
financeProbe diagnostic. Report state machine extracted to amazonReportPhase.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push
cd odoops-worker && npx wrangler deploy && cd ..
```
Expected: deploy succeeds (new version id printed).

---

## Task 4: Backfill walk + live reconciliation

**Files:** none (operational — MCP SQL + worker actions)

- [ ] **Step 1: Probe a known window FIRST (before trusting the pipeline)**

Hit `financeProbe` for a recent ~7-day window with known Amazon activity (replace dates):
`GET <worker>/?action=financeProbe&after=2026-06-08T00:00:00Z&before=2026-06-15T00:00:00Z` (authenticated; `sales_connector_manage`).
Expected: `status:200`, `shipmentItems > 0`, `sampleShipment` has non-zero `principal` and a `tax` value, `promo` ≥ 0. **Eyeball that `principal + tax` for the sample ≈ that order-item's `item-price` in `stg_amazon`.** If the field shapes differ from the parser (e.g. charges nested differently), fix `parseAmazonFinance` now and redeploy before proceeding.

- [ ] **Step 2: Set `fin_cursor` and let the backfill walk**

Seed the finance cursor to the Amazon backfill start (so it walks the same history the report covered):
```sql
UPDATE sales.connector_config
SET config = config || jsonb_build_object('fin_cursor', config->>'backfill_start')
WHERE channel_id = (SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA')
  AND (config ? 'fin_cursor') = false;
SELECT config->>'fin_cursor' AS fin_cursor, config->>'backfill_start' AS backfill_start
FROM sales.connector_config WHERE channel_id=(SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA');
```
Then trigger several refreshes (or wait for cron ticks). Each tick advances `fin_cursor` by ≤7 days. Watch it climb:
```sql
SELECT config->>'fin_cursor' AS fin_cursor, now() FROM sales.connector_config
WHERE channel_id=(SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA');
SELECT count(*) shipments FILTER (WHERE event_type='shipment'),
       count(*) refunds   FILTER (WHERE event_type='refund') FROM sales.stg_amazon_fin;
```
Expected: `fin_cursor` advances each tick; `stg_amazon_fin` rows grow.

- [ ] **Step 3: Reconcile gross (no double-count) — the critical check**

Over a settled window the finance backfill has reached, confirm units/gross are UNCHANGED but discount/tax/returns now populate:
```sql
SELECT round(sum(units)) units, round(sum(gross_value)) gross,
       round(sum(discount_value)) discount, round(sum(tax_value)) tax,
       round(sum(returned_value)) returns
FROM sales.sales_fact f JOIN public.dispatch_channels d ON d.id=f.channel_id
WHERE d.name='Amazon - FBA' AND f.sale_date BETWEEN '2026-05-01' AND '2026-05-20';
```
Expected: `units`/`gross` match the pre-deploy values for that window (capture them before Task 3 deploy, or compare against the orders-report-only expectation), and `discount`/`tax`/`returns` are now > 0. **If `gross` jumped, the enrichment rows aren't zero-gross — stop and inspect the v_staged amazon_fin shipment branch.**

- [ ] **Step 4: Spot-check one order end-to-end**

```sql
SELECT event_type, qty, principal, tax, promo FROM sales.stg_amazon_fin
WHERE channel_id=(SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA')
  AND amazon_order_id='<pick a real order id>';
-- vs the same order's stg_amazon item-price (tax-incl):
SELECT channel_sku, qty, gross_value FROM sales.stg_amazon
WHERE channel_id=(SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA')
  AND source_order_id='<same order id>';
```
Expected: `principal + tax` ≈ `gross_value`; `promo` matches any promotion on that order.

- [ ] **Step 5: `/performance` order grain**

```sql
SELECT sale_date, orders, gross, discount, tax, returns_count, returns_value
FROM sales.f_order_rollup('2026-05-01','2026-05-20',
  ARRAY[(SELECT id FROM public.dispatch_channels WHERE name='Amazon - FBA')])
ORDER BY sale_date;
```
Expected: `discount`/`tax` now > 0 for Amazon; `returns_count`/`returns_value` > 0 where refunds exist; `orders`/`gross`/cancellations unchanged. Open the `/performance` page in the app and confirm the Amazon column shows the ladder.

- [ ] **Step 6: Net sanity for one day**

Hand-check one day: `Net ex-GST = gross − discount − cancelled_value − returns_value − tax` is positive and sensible vs the day's gross. Note it in the session log.

---

## Task 5: Knowledge files + close-out

**Files:**
- Modify: `systems/odo.md` (workspace root), `BACKLOG.md`, `memory/` as needed.

- [ ] **Step 1: Update `systems/odo.md`** — add a Session entry: Phase C live (Amazon Finances connector); `stg_amazon_fin` + `v_staged` amazon_fin branch + `f_order_rollup` finance fold; `fin_cursor` second cursor; `financeProbe`; Settlement → C.2. Bump `Last updated`.

- [ ] **Step 2: Update `BACKLOG.md`** — move the `[odo] NET revenue everywhere` item's Amazon (Phase C) sub-item to done; add `[odo] Phase C.2 — Amazon settlement report (fees / true payout / margin)` as a new open item.

- [ ] **Step 3: Update the `project_odo_net_revenue` memory** if the Amazon basis is now confirmed live (Principal+Tax = tax-incl gross, discount=Promotion, returns=refund events).

- [ ] **Step 4: Commit workspace root**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add -A && git commit -m "session: Odo Phase C — Amazon net-revenue via Finances API" && git push
```

- [ ] **Step 5: Confirm clean state** — `git status` on root + `05_Throttle` both clean and synced.

---

## Self-Review notes (author)

- **Spec coverage:** Finances fetch (T3), `stg_amazon_fin` (T1), `v_staged` enrichment incl. purchase-date alignment via `stg_orders` join (T1), zero-gross no-double-count (T1/T4 §3), refund→return rows + dating to posted_date (T1/T3), `f_order_rollup` fold (T2), graceful degradation (inherent — finance trickles in, recompute idempotent), budget guard (bounded windows/pages, T3), Settlement deferred to C.2 (T5 backlog). All spec sections map to a task.
- **No double-count** is the load-bearing risk → it has a dedicated reconciliation step (T4 §3) with an explicit stop condition.
- **Type/name consistency:** `parseAmazonFinance`/`fetchAmazonFinanceWindow`/`stageAmazonFinance`/`amazonReportPhase`/`financeProbe` and `fin_cursor` / `stg_amazon_fin` / unique key `(channel_id, amazon_order_id, seller_sku, event_type, posted_date)` are used identically across tasks.
- **Reused helpers verified present:** `num`, `istDate`, `todayISO`, `uniq`, `inList`, `sbSales`, `sbInsertChunked`, `patchConnectorConfig`, `stageOrders`, `distinctDates`, `gridToQcRows`, `createAmazonReport`, `fetchAmazonDoc`, `getAmazonToken`, `canConnector`, `ok`, `err`, `qp`.
- **Field-shape risk:** `parseAmazonFinance` assumes the documented `ShipmentEventList[].ShipmentItemList[].{ItemChargeList,PromotionList}` and `RefundEventList[].ShipmentItemAdjustmentList[].{ItemChargeAdjustmentList,PromotionAdjustmentList}` shapes. T4 §1 (`financeProbe`) verifies against real data BEFORE any staging — fix the parser there if reality differs.
```
