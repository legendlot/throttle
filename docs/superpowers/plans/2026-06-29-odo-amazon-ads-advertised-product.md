# Odo Amazon Ads P2 — advertised-product → SKU/model metrics · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `/amazon` cockpit per-SKU and per-Model Amazon ad metrics (Spend · Ad sales · ROAS · ACOS · TACOS · Organic%) by ingesting the Sponsored-Products **advertised-product** report into a new product-grain marketing fact.

**Architecture:** A new `amazon_ads_product` connector (its own `is_sale=false` synthetic channel, own report state-machine, own per-connector Workflow instance) pulls the v3 `spAdvertisedProduct` report → `stg_amazon_ads_product` → `recompute_amzn_ads_product` resolves `advertisedSku → product_code` via the existing Amazon-FBA `sku_map` → `sales.mkt_product_fact` (grain `the_date × platform × product_code`). A new `getAdProduct` worker GET + `f_mkt_product_rollup` feed extra columns on the existing sellers table. `mkt_fact` (campaign-grain) is untouched.

**Tech Stack:** Cloudflare Workers (single-file `odoops-worker/src/index.js`), Supabase Postgres (`sales` schema, PostgREST + RPCs), Next.js static-export (`apps/odo`), Amazon Advertising API v3 (LWA refresh-token, EU host).

**Spec:** `docs/superpowers/specs/2026-06-29-odo-amazon-ads-advertised-product-design.md`

**No new secrets, no `wrangler.toml` change** (the generic `ConnectorWorkflow` already binds; a new enabled `connector_config` row auto-gets an instance). Reuses the LWA secrets already on odoops.

**Key constants (reuse / verify against live worker):**
- Amazon-FBA sales channel (sku_map source): `855de0ca-9498-4d5a-90f3-3a370a228762`
- Amazon Ads profile id (India): `202246193452230`; region host `https://advertising-api-eu.amazon.com`
- Supabase project id: `jkxcnjabmrkteanzoofj`

---

## File structure

- **Migration `odo_amazon_ads_product_v1`** — `sales.stg_amazon_ads_product`, `sales.mkt_product_fact`, RLS+grants, `sales.recompute_amzn_ads_product`, `sales.f_mkt_product_rollup`. (Applied via `apply_migration` MCP tool.)
- **Seed SQL** (not a migration — data, like the `…a3` channel) — one `public.dispatch_channels` row + one `sales.connector_config` row.
- **`odoops-worker/src/index.js`** (modify) — generalize `createAdsReport`; add `AMZ_ADS_PRODUCT_COLUMNS`; add `amazonAdsProductAdapter`; register in `ADAPTERS`; add GET `getAdProduct` + GET `adProductProbe`.
- **`apps/odo/src/components/AmazonPage.js`** (modify) — fetch `getAdProduct`, build per-key ad map, add 6 columns to the sellers table.
- **Knowledge files** (modify at end) — `systems/odo.md`, `BACKLOG.md`, `CORE.md` (one bullet).

---

## Task 1: DB migration — staging + product-grain fact + RPCs

**Files:**
- Apply migration: `odo_amazon_ads_product_v1` (via `mcp__plugin_supabase_supabase__apply_migration`, project `jkxcnjabmrkteanzoofj`).

- [ ] **Step 1: Verify the sku_map source channel + a sample SKU exist (pre-check)**

Run (via `execute_sql`):
```sql
SELECT count(*) AS map_rows,
       (SELECT channel_sku FROM sales.sku_map WHERE channel_id='855de0ca-9498-4d5a-90f3-3a370a228762' LIMIT 1) AS sample_sku
FROM sales.sku_map WHERE channel_id='855de0ca-9498-4d5a-90f3-3a370a228762';
```
Expected: `map_rows` ≈ 150, a non-null `sample_sku`. Confirms the resolver join target.

- [ ] **Step 2: Apply the migration**

Apply migration name `odo_amazon_ads_product_v1` with this SQL:
```sql
-- ── staging: raw advertised-product report rows (superseded by date-range) ──
CREATE TABLE IF NOT EXISTS sales.stg_amazon_ads_product (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          bigint,
  channel_id      uuid NOT NULL,
  ad_account_id   text,
  campaign_id     text,
  campaign_name   text,
  advertised_sku  text,
  advertised_asin text,
  the_date        date NOT NULL,
  spend           numeric DEFAULT 0,
  impressions     bigint  DEFAULT 0,
  clicks          bigint  DEFAULT 0,
  conversions     numeric DEFAULT 0,
  conv_value      numeric DEFAULT 0,
  raw             jsonb,
  ingested_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stg_amazon_ads_product_ch_date_idx
  ON sales.stg_amazon_ads_product (channel_id, the_date);
ALTER TABLE sales.stg_amazon_ads_product ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.stg_amazon_ads_product TO service_role;

-- ── product-grain marketing fact (idempotent recompute) ──
CREATE TABLE IF NOT EXISTS sales.mkt_product_fact (
  the_date     date NOT NULL,
  platform     text NOT NULL,
  product_code text NOT NULL,          -- '' = unmapped-ad-spend residual bucket
  spend        numeric DEFAULT 0,
  impressions  bigint  DEFAULT 0,
  clicks       bigint  DEFAULT 0,
  conversions  numeric DEFAULT 0,
  conv_value   numeric DEFAULT 0,
  run_id       bigint,
  CONSTRAINT mkt_product_fact_grain UNIQUE (the_date, platform, product_code)
);
ALTER TABLE sales.mkt_product_fact ENABLE ROW LEVEL SECURITY;
GRANT ALL ON sales.mkt_product_fact TO service_role;

-- ── recompute: staging → fact, resolve advertised_sku→product_code via Amazon-FBA sku_map ──
CREATE OR REPLACE FUNCTION sales.recompute_amzn_ads_product(p_channel uuid, p_dates date[], p_run_id bigint)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = sales, public AS $$
DECLARE n int;
BEGIN
  DELETE FROM sales.mkt_product_fact WHERE platform='amazon' AND the_date = ANY(p_dates);
  INSERT INTO sales.mkt_product_fact (the_date, platform, product_code, spend, impressions, clicks, conversions, conv_value, run_id)
  SELECT s.the_date, 'amazon',
         COALESCE(m.product_code, '') AS product_code,
         SUM(s.spend), SUM(s.impressions), SUM(s.clicks), SUM(s.conversions), SUM(s.conv_value),
         p_run_id
  FROM sales.stg_amazon_ads_product s
  LEFT JOIN sales.sku_map m
    ON m.channel_id = '855de0ca-9498-4d5a-90f3-3a370a228762'
   AND lower(m.channel_sku) = lower(s.advertised_sku)
  WHERE s.channel_id = p_channel AND s.the_date = ANY(p_dates)
  GROUP BY s.the_date, COALESCE(m.product_code, '');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION sales.recompute_amzn_ads_product(uuid, date[], bigint) TO service_role;

-- ── rollup for the cockpit ──
CREATE OR REPLACE FUNCTION sales.f_mkt_product_rollup(p_from date, p_to date, p_platform text DEFAULT NULL, p_product_code text DEFAULT NULL)
RETURNS TABLE(product_code text, spend numeric, impressions bigint, clicks bigint, conversions numeric, conv_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = sales, public AS $$
  SELECT product_code, SUM(spend), SUM(impressions), SUM(clicks), SUM(conversions), SUM(conv_value)
  FROM sales.mkt_product_fact
  WHERE the_date BETWEEN p_from AND p_to
    AND (p_platform IS NULL OR platform = p_platform)
    AND (p_product_code IS NULL OR product_code = p_product_code)
  GROUP BY product_code;
$$;
GRANT EXECUTE ON FUNCTION sales.f_mkt_product_rollup(date, date, text, text) TO service_role;
```

- [ ] **Step 3: Verify the objects exist and the RPCs run clean on empty data**

Run (via `execute_sql`):
```sql
SELECT to_regclass('sales.stg_amazon_ads_product') AS stg,
       to_regclass('sales.mkt_product_fact')        AS fact;
SELECT sales.recompute_amzn_ads_product('00000000-0000-4000-a000-0000000000a5'::uuid, ARRAY['2026-06-01']::date[], NULL) AS recomputed;
SELECT * FROM sales.f_mkt_product_rollup('2026-06-01','2026-06-29','amazon',NULL) LIMIT 1;
```
Expected: both `to_regclass` non-null; `recomputed = 0` (no staging yet, no error); rollup returns 0 rows without error. (The channel uuid `…a5` is the one Task 2 seeds.)

- [ ] **Step 4: Confirm advisors are clean (RLS posture)**

Use `mcp__plugin_supabase_supabase__get_advisors` (type `security`). Expected: no new "RLS disabled" / "policy exposes" findings for the two new tables (RLS is enabled; service_role bypasses; no anon grant added — matches RULE-RLS-001).

- [ ] **Step 5: Commit (knowledge/migration record only — DB change already applied)**

No repo files changed yet; nothing to commit this task. (Migration is recorded in Supabase `supabase_migrations`.)

---

## Task 2: Seed the synthetic ads-product channel + connector config (disabled)

**Files:**
- `execute_sql` only (data seed, like the `…a3` Amazon Ads channel — not a migration).

Seed it **disabled** so the cron does not run the connector before the worker adapter is deployed (Task 3).

- [ ] **Step 1: Confirm the `…a5` channel id is free, then insert the channel + config**

Run (via `execute_sql`):
```sql
INSERT INTO public.dispatch_channels (id, name, is_sale)
VALUES ('00000000-0000-4000-a000-0000000000a5', 'Amazon Ads — Products', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sales.connector_config (channel_id, adapter_kind, enabled, config)
VALUES (
  '00000000-0000-4000-a000-0000000000a5',
  'amazon_ads_product',
  false,
  '{"region_host":"https://advertising-api-eu.amazon.com","profile_id":"202246193452230","ad_product":"SPONSORED_PRODUCTS","backfill_start":"2025-04-01"}'::jsonb
)
ON CONFLICT (channel_id) DO UPDATE
  SET adapter_kind='amazon_ads_product', config=EXCLUDED.config;
RETURNING channel_id, adapter_kind, enabled, config;
```
Expected: one row back, `enabled=false`, config as given.

> NB the `dispatch_channels` insert may need columns beyond `(id,name,is_sale)` if the table has NOT-NULL columns without defaults. If the INSERT errors on a missing column, first run
> `SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='dispatch_channels' ORDER BY ordinal_position;`
> and supply the required columns (mirror the existing `…a3` Amazon Ads row: `SELECT * FROM public.dispatch_channels WHERE id='00000000-0000-4000-a000-0000000000a3';`).

- [ ] **Step 2: Verify it is invisible to the sales UI (is_sale=false)**

Run:
```sql
SELECT id, name, is_sale FROM public.dispatch_channels WHERE id='00000000-0000-4000-a000-0000000000a5';
```
Expected: `is_sale=false` → excluded from `getBootstrap` (`dispatch_channels?is_sale=eq.true`), so it never appears in the cockpit's channel filter or sub-channel bands.

---

## Task 3: Worker — generalize report builder + new adapter + GET endpoints

**Files:**
- Modify: `odoops-worker/src/index.js` — `createAdsReport` (~L832), add const + adapter after `amazonAdsAdapter` (~L928), `ADAPTERS` (~L1266), GET switch (add `getAdProduct` near `getMarketing` ~L1658, `adProductProbe` near `uniwareProbe`/`amazonPeek`).

- [ ] **Step 1: Make `createAdsReport` accept `groupBy` + `columns` (backward-compatible)**

Find (~L832):
```js
async function createAdsReport(host, H, adProduct, reportTypeId, startDate, endDate) {
  const cr = await fetch(`${host}/reporting/reports`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: `odo-${reportTypeId}-${startDate}-${endDate}`, startDate, endDate,
      configuration: { adProduct, groupBy: ['campaign'], columns: AMZ_ADS_COLUMNS, reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON' },
    }),
  });
```
Replace the signature + body line with:
```js
async function createAdsReport(host, H, adProduct, reportTypeId, startDate, endDate, groupBy = ['campaign'], columns = AMZ_ADS_COLUMNS) {
  const cr = await fetch(`${host}/reporting/reports`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: `odo-${reportTypeId}-${startDate}-${endDate}`, startDate, endDate,
      configuration: { adProduct, groupBy, columns, reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON' },
    }),
  });
```
The existing 6-arg call sites (campaign adapter) keep working via defaults.

- [ ] **Step 2: Add the advertised-product column set + adapter**

Immediately AFTER the closing `};` of `amazonAdsAdapter` (the line `};` at ~L928, just before `const ADAPTERS = …`), insert:
```js
// ── Amazon Ads — advertised-product (SP) report → product-grain mkt_product_fact (S185) ──
// Mirrors amazonAdsAdapter's create→poll→walk state machine; differs only in report type (groupBy
// 'advertiser'), columns (advertised SKU/ASIN), staging table, and recompute RPC. Intentionally a
// separate adapter (not a refactor of amazonAdsAdapter) to keep zero blast-radius on the live
// campaign connector — both ride the generic ConnectorWorkflow, each with its own instance.
const AMZ_ADS_PRODUCT_COLUMNS = ['date', 'campaignId', 'campaignName', 'advertisedSku', 'advertisedAsin', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'];
const amazonAdsProductAdapter = {
  kind: 'amazon_ads_product', stgTable: 'stg_amazon_ads_product',
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, config }) {
    const cfg = config || {};
    const host = cfg.region_host || 'https://advertising-api-eu.amazon.com';
    const adProduct = cfg.ad_product || 'SPONSORED_PRODUCTS';
    const reportTypeId = 'spAdvertisedProduct';
    const groupBy = ['advertiser'];
    const token = await getAmazonAdsToken(env);
    let subreqs = 1;

    let profileId = cfg.profile_id;
    if (!profileId) {
      const pr = await fetch(`${host}/v2/profiles`, { headers: { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, Authorization: `Bearer ${token}` } }); subreqs++;
      if (!pr.ok) throw new Error(`Amazon Ads /v2/profiles ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
      const profiles = await pr.json();
      const pick = (profiles || []).find(p => p.countryCode === 'IN') || (profiles || [])[0];
      if (!pick) throw new Error('Amazon Ads: no profiles on this login (no Ads account linked?)');
      profileId = String(pick.profileId);
      await patchConnectorConfig(channelId, cfg, { profile_id: profileId }); cfg.profile_id = profileId;
    }
    const H = { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' };
    const nowMs = Date.now();

    // ── pending report → poll ──
    if (cfg.pending_report_id) {
      const pr = await fetch(`${host}/reporting/reports/${cfg.pending_report_id}`, { headers: H }); subreqs++;
      if (!pr.ok) throw new Error(`Amazon Ads getReport ${pr.status}: ${(await pr.text().catch(() => '')).slice(0, 160)}`);
      const rep = await pr.json();
      const st = (rep.status || '').toUpperCase();
      if (st === 'PENDING' || st === 'PROCESSING') return { rows: [], cursorAfter: null, subreqs, partial: true };
      if (st !== 'COMPLETED') { await patchConnectorConfig(channelId, cfg, { pending_report_id: null, pending_through: null }); throw new Error(`Amazon Ads report ${st}: ${(rep.failureReason || '').slice(0, 120)}`); }
      let rows = [];
      if (rep.url) {
        const dl = await fetch(rep.url); subreqs++;
        if (!dl.ok) throw new Error('Amazon Ads doc download ' + dl.status);
        const text = await new Response(dl.body.pipeThrough(new DecompressionStream('gzip'))).text();
        let arr = []; try { arr = JSON.parse(text); } catch { arr = []; }
        rows = (Array.isArray(arr) ? arr : []).map(d => ({
          channel_id: channelId, ad_account_id: profileId, campaign_id: String(d.campaignId ?? ''),
          campaign_name: d.campaignName || null, advertised_sku: d.advertisedSku || null, advertised_asin: d.advertisedAsin || null,
          the_date: d.date,
          spend: num(d.cost), impressions: num(d.impressions), clicks: num(d.clicks),
          conversions: num(d.purchases14d), conv_value: num(d.sales14d), raw: d,
        })).filter(r => r.the_date);
      }
      const windowEnd = cfg.pending_through;
      const endMs = Date.parse((windowEnd || '') + 'T00:00:00Z') || 0;
      let partial = false, next = { pending_report_id: null, pending_through: null };
      if (endMs && endMs < nowMs - 36_000_000) {
        const nextStart = amzAdsDay(endMs + 86400000);
        const nextEnd = amzAdsDay(Math.min(endMs + AMZ_ADS_WINDOW_MS, nowMs));
        try { const rid = await createAdsReport(host, H, adProduct, reportTypeId, nextStart, nextEnd, groupBy, AMZ_ADS_PRODUCT_COLUMNS); subreqs++; next = { pending_report_id: rid, pending_through: nextEnd }; partial = true; }
        catch (_) { /* leave cleared — next tick re-creates from the advanced cursor */ }
      }
      await patchConnectorConfig(channelId, cfg, next);
      return { rows, cursorAfter: windowEnd, subreqs, partial };
    }

    // ── no pending → create the next window (trailing-30d floor for steady state) ──
    let startStr = (cursor || cfg.backfill_start || amzAdsDay(nowMs - AMZ_ADS_WINDOW_MS)).slice(0, 10);
    const trailingStart = amzAdsDay(nowMs - AMZ_ADS_WINDOW_MS);
    if (startStr > trailingStart) startStr = trailingStart;
    const startMs = Date.parse(startStr + 'T00:00:00Z') || nowMs;
    const endStr = amzAdsDay(Math.min(startMs + AMZ_ADS_WINDOW_MS, nowMs));
    const rid = await createAdsReport(host, H, adProduct, reportTypeId, startStr, endStr, groupBy, AMZ_ADS_PRODUCT_COLUMNS); subreqs++;
    await patchConnectorConfig(channelId, cfg, { pending_report_id: rid, pending_through: endStr });
    return { rows: [], cursorAfter: null, subreqs, partial: true };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const from = rows.reduce((m, x) => x.the_date < m ? x.the_date : m, rows[0].the_date);
    const to   = rows.reduce((m, x) => x.the_date > m ? x.the_date : m, rows[0].the_date);
    await sbSales(`/rest/v1/stg_amazon_ads_product?channel_id=eq.${channelId}&the_date=gte.${from}&the_date=lte.${to}`, { method: 'DELETE', prefer: 'return=minimal' });
    const body = rows.map(r => ({ run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id, campaign_name: r.campaign_name, advertised_sku: r.advertised_sku, advertised_asin: r.advertised_asin, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions), clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw }));
    await sbInsertChunked('/rest/v1/stg_amazon_ads_product', body, 'return=minimal');
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_amzn_ads_product', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};
```

- [ ] **Step 3: Register the adapter in `ADAPTERS`**

Find (~L1266):
```js
const ADAPTERS = { shopify: shopifyAdapter, snorkel_internal: snorkelAdapter, qc_upload: qcAdapter, qc_gsheet: gsheetAdapter, amazon_spapi: amazonAdapter, amazon_ads: amazonAdsAdapter, meta_ads: metaAdsAdapter, google_ads: googleAdsAdapter, ga4: ga4Adapter, uniware: uniwareAdapter };
```
Add `amazon_ads_product: amazonAdsProductAdapter,`:
```js
const ADAPTERS = { shopify: shopifyAdapter, snorkel_internal: snorkelAdapter, qc_upload: qcAdapter, qc_gsheet: gsheetAdapter, amazon_spapi: amazonAdapter, amazon_ads: amazonAdsAdapter, amazon_ads_product: amazonAdsProductAdapter, meta_ads: metaAdsAdapter, google_ads: googleAdsAdapter, ga4: ga4Adapter, uniware: uniwareAdapter };
```

- [ ] **Step 4: Add GET `getAdProduct` (mirror `getMarketing`'s guard exactly)**

First read the existing guard:
Run: `grep -n -A3 "case 'getMarketing'" odoops-worker/src/index.js`
Copy the FIRST line's permission guard verbatim (it is the `sales_view` gate). Then add, right after the `getMarketing` case block:
```js
          case 'getAdProduct': {   // S185 — product-grain Amazon ad metrics for the /amazon sellers table
            // <-- paste the SAME guard getMarketing uses on its first line (sales_view) -->
            const r = await rpcSales('f_mkt_product_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(), p_platform: qp('platform') || null });
            return r.ok ? ok({ rows: r.data || [] }) : err(r.error || 'rollup failed', 500);
          }
```

- [ ] **Step 5: Add GET `adProductProbe` (diagnostic, `canConnector`-gated)**

Right after the `uniwareProbe` case block (~L1817, before `default:`), add:
```js
          case 'adProductProbe': {  // diagnostic: create OR poll an advertised-product report; confirm columns
            if (!canConnector(P)) return err('No permission', 403);
            const host = 'https://advertising-api-eu.amazon.com';
            const profileId = '202246193452230';
            let token; try { token = await getAmazonAdsToken(env); } catch (e) { return err(String(e?.message || e), 400); }
            const H = { 'Amazon-Advertising-API-ClientId': env.AMAZON_ADS_CLIENT_ID, 'Amazon-Advertising-API-Scope': profileId, Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' };
            const rid = qp('report_id');
            if (!rid) {
              const end = amzAdsDay(Date.now() - 2 * 86400000), start = amzAdsDay(Date.now() - 5 * 86400000);
              try { const id = await createAdsReport(host, H, 'SPONSORED_PRODUCTS', 'spAdvertisedProduct', start, end, ['advertiser'], AMZ_ADS_PRODUCT_COLUMNS); return ok({ created: id, start, end, note: 'poll again: &action=adProductProbe&report_id=' + id }); }
              catch (e) { return err(String(e?.message || e), 502); }
            }
            const pr = await fetch(`${host}/reporting/reports/${rid}`, { headers: H });
            const rep = await pr.json().catch(() => ({}));
            const st = (rep.status || '').toUpperCase();
            if (st !== 'COMPLETED') return ok({ status: st, failureReason: rep.failureReason || null });
            let sample = [], count = 0, keys = [];
            if (rep.url) { const dl = await fetch(rep.url); const text = await new Response(dl.body.pipeThrough(new DecompressionStream('gzip'))).text(); let arr = []; try { arr = JSON.parse(text); } catch {} count = (arr || []).length; sample = (arr || []).slice(0, 3); keys = sample[0] ? Object.keys(sample[0]) : []; }
            return ok({ status: st, count, keys, sample });
          }
```

- [ ] **Step 6: Commit, push, deploy the worker**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git -C . add odoops-worker/src/index.js
git -C . commit -m "feat(odo): amazon_ads_product connector + getAdProduct/adProductProbe (S185)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git -C . push
cd odoops-worker && npx wrangler deploy
```
Expected: deploy succeeds, prints a new worker version id. (No `wrangler.toml` change — the generic ConnectorWorkflow already binds.)

---

## Task 4: Probe columns, enable, backfill, verify the data path

**Files:** `execute_sql` + worker GET calls (no code).

> The worker GETs need a JWT. Run these from the deployed odo app (logged in as Afshaan/Vinay super-admin) by hitting `https://odoops.afshaan.workers.dev/?action=…`, OR ask Afshaan to paste the JSON. The probe is `canConnector`-gated (admin has it).

- [ ] **Step 1: Probe — confirm the report's actual column keys**

Call `GET https://odoops.afshaan.workers.dev/?action=adProductProbe` → returns `{created, note}`. Wait ~1–3 min, then call the `report_id` URL from `note`.
Expected COMPLETED: `keys` includes `date, campaignId, advertisedSku, advertisedAsin, impressions, clicks, cost, purchases14d, sales14d`.
**If a key differs** (e.g. `cost` vs `spend`, or `purchases14d` naming), update `AMZ_ADS_PRODUCT_COLUMNS` AND the `d.<field>` reads in the adapter's row map (Task 3 Step 2), re-commit + re-deploy, then re-probe.

- [ ] **Step 2: Enable the connector**

Run (via `execute_sql`):
```sql
UPDATE sales.connector_config SET enabled=true
WHERE channel_id='00000000-0000-4000-a000-0000000000a5'
RETURNING channel_id, enabled;
```

- [ ] **Step 3: Kick a manual refresh and let the workflow drain a window**

Call `POST https://odoops.afshaan.workers.dev/` with body `{"action":"refreshNow","data":{"channel_id":"00000000-0000-4000-a000-0000000000a5"}}` (or use the `/connectors` page "Refresh"/"Backfill"). The report is async — the connector's ConnectorWorkflow polls across `step.sleep`s; allow a few minutes. Re-run refresh if the first tick only created the report.

- [ ] **Step 4: Verify staging populated**

Run:
```sql
SELECT count(*) rows, min(the_date) lo, max(the_date) hi,
       count(*) FILTER (WHERE advertised_sku IS NOT NULL) AS with_sku,
       round(100.0*count(*) FILTER (WHERE advertised_sku IS NOT NULL)/greatest(count(*),1),1) AS sku_pct
FROM sales.stg_amazon_ads_product;
```
Expected: rows > 0, a recent `hi`, high `sku_pct` (SP advertised-product carries `advertisedSku` for own products).

- [ ] **Step 5: Verify the fact + mapping coverage**

Run:
```sql
SELECT
  (SELECT count(*) FROM sales.mkt_product_fact WHERE platform='amazon') AS fact_rows,
  (SELECT round(sum(spend),0) FROM sales.mkt_product_fact WHERE platform='amazon') AS total_spend,
  (SELECT round(sum(spend),0) FROM sales.mkt_product_fact WHERE platform='amazon' AND product_code='') AS unmapped_spend,
  (SELECT round(sum(spend),0) FROM sales.mkt_fact WHERE platform='amazon'
     AND the_date BETWEEN (SELECT min(the_date) FROM sales.mkt_product_fact WHERE platform='amazon')
                      AND (SELECT max(the_date) FROM sales.mkt_product_fact WHERE platform='amazon')) AS campaign_total_same_window;
```
Expected: `fact_rows` > 0; `unmapped_spend` a small fraction of `total_spend`; `total_spend` reconciles roughly with `campaign_total_same_window` (advertised-product is a finer cut of the same spend — within report-timing/rounding). Investigate if unmapped is large (a SKU casing/format mismatch → check `sku_map.channel_sku` vs `stg_amazon_ads_product.advertised_sku`).

- [ ] **Step 6: Verify the rollup endpoint returns product rows**

Call `GET …/?action=getAdProduct&from=2026-06-01&to=2026-06-29` → expect `{rows:[{product_code, spend, conv_value, …}]}` with several mapped product_codes and non-zero spend.

---

## Task 5: UI — extend the sellers table with ad columns

**Files:**
- Modify: `apps/odo/src/components/AmazonPage.js`

- [ ] **Step 1: Fetch `getAdProduct` in the data load**

In the `Promise.all([...])` (the block starting ~L73), add a 8th call and capture it. Change the array + the `.then` destructure + `setD`:
```js
    Promise.all([
      salesGet('getSegregation', { from, to, channel_id: idsKey }, session),
      salesGet('getSegregation', { from: pp.from, to: pp.to, channel_id: idsKey }, session),
      salesGet('getMarketing', { from, to, group: 'platform' }, session),
      salesGet('getMarketing', { from: pp.from, to: pp.to, group: 'platform' }, session),
      salesGet('getAmazonReturns', { from, to, group: 'overall' }, session),
      salesGet('getAmazonGeo', { from, to }, session),
      salesGet('getSales', { from, to, group: 'variant', channel_id: idsKey }, session),
      salesGet('getAdProduct', { from, to }, session),
    ]).then(([seg, segPrev, mkt, mktPrev, ret, geo, sv, adp]) => {
      setD({ seg: seg?.rows || [], segPrev: segPrev?.rows || [], mkt: mkt?.rows || [], mktPrev: mktPrev?.rows || [], ret: ret?.rows || [], geo: geo?.rows || [], salesVar: sv?.rows || [], adProd: adp?.rows || [] });
    }).catch(e => setErr(e.message || String(e)));
```
Also update the empty-state `setD` (~L71) to include `adProd: []`:
```js
    if (!idsKey) { setD({ seg: [], segPrev: [], mkt: [], mktPrev: [], ret: [], geo: [], salesVar: [], adProd: [] }); return; }
```

- [ ] **Step 2: Build a per-key ad map (keyed the same way as the sellers rollup)**

Right after `const sellers = useMemo(...)` (~L91), add:
```js
  // ad metrics per sellers-key (SKU mode → product_code; Model mode → product family via c2p).
  // The '' unmapped-residual bucket from f_mkt_product_rollup is skipped (falsy code).
  const adByKey = useMemo(() => {
    const by = {};
    for (const r of (d?.adProd || [])) {
      const code = r.product_code; if (!code) continue;
      const key = grp === 'product' ? (c2p[code] || code) : code;
      (by[key] = by[key] || { spend: 0, adSales: 0, clicks: 0, impr: 0 });
      by[key].spend += Number(r.spend) || 0; by[key].adSales += Number(r.conv_value) || 0;
      by[key].clicks += Number(r.clicks) || 0; by[key].impr += Number(r.impressions) || 0;
    }
    return by;
  }, [d, grp, c2p]);
```

- [ ] **Step 3: Extend the sellers table header + rows**

Replace the table block (`<table className="so-table">…</table>`, ~L225-237) with:
```jsx
                <table className="so-table">
                  <thead><tr>
                    <th>{grp === 'product' ? 'Model' : 'SKU'}</th>
                    <th className="so-num">Units</th><th className="so-num">Gross</th><th className="so-num">ASP</th>
                    <th className="so-num">Spend</th><th className="so-num">Ad Sales</th>
                    <th className="so-num">ROAS</th><th className="so-num">ACOS</th><th className="so-num">TACOS</th><th className="so-num">Organic%</th>
                  </tr></thead>
                  <tbody>
                    {sellers.arr.map(v => {
                      const a = adByKey[v.code] || { spend: 0, adSales: 0 };
                      const sp = a.spend, ads = a.adSales, has = sp > 0;
                      const roas = has ? ads / sp : 0;
                      const acos = ads > 0 ? (sp / ads) * 100 : 0;
                      const tacos = v.gross > 0 ? (sp / v.gross) * 100 : 0;
                      const organicPct = v.gross > 0 ? ((v.gross - ads) / v.gross) * 100 : 0;
                      return (
                        <tr key={v.code}>
                          <td>{v.label}</td>
                          <td className="so-num">{fmtInt(v.units)}</td>
                          <td className="so-num">{inr(v.gross)}</td>
                          <td className="so-num">{inr(v.units ? v.gross / v.units : 0)}</td>
                          <td className="so-num">{has ? inr(sp) : '—'}</td>
                          <td className="so-num">{has ? inr(ads) : '—'}</td>
                          <td className="so-num">{has ? roas.toFixed(2) + '×' : '—'}</td>
                          <td className="so-num">{has ? acos.toFixed(1) + '%' : '—'}</td>
                          <td className="so-num">{has ? tacos.toFixed(1) + '%' : '—'}</td>
                          <td className="so-num">{has ? organicPct.toFixed(0) + '%' : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
```

- [ ] **Step 4: Build the app (zero errors required)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
npx turbo build --filter=odo
```
Expected: build succeeds, 0 errors. (If the filter name differs, use the package name from `apps/odo/package.json`'s `"name"`.)

- [ ] **Step 5: Commit + push (CI auto-deploys odo)**

```bash
git -C . add apps/odo/src/components/AmazonPage.js
git -C . commit -m "feat(odo): SKU/model ad columns (ROAS/ACOS/TACOS/organic) on /amazon sellers table (S185)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git -C . push
```
Expected: pushed; `deploy-odo.yml` builds + publishes to gh-pages (~3-4 min).

---

## Task 6: Live verification + knowledge files

**Files:**
- Modify: `systems/odo.md`, `BACKLOG.md`, `CORE.md` (workspace root).

- [ ] **Step 1: Live-verify the cockpit**

After the odo deploy, sign in to `https://odo.legendoftoys.com/channels/amazon` (super-admin). Confirm:
- Top sellers table shows the 6 new columns; a known advertised SKU shows a sane ROAS (e.g. 2–10×) and ACOS; un-advertised SKUs show "—".
- Toggle **Model ⇄ SKU**: Model rows aggregate ad spend across the family (sum of its SKUs); numbers stay consistent.
- Use `preview_*` tools only if running locally; otherwise visual confirm + a `getAdProduct` spot-check is sufficient.

- [ ] **Step 2: Update `systems/odo.md`**

Add an S185 bullet at the top "Last updated" narrative summarizing: advertised-product connector (`amazon_ads_product` on synthetic channel `…a5`, `spAdvertisedProduct` report) → `stg_amazon_ads_product` → `recompute_amzn_ads_product` → `sales.mkt_product_fact` (product-grain) → `getAdProduct`/`f_mkt_product_rollup` → SKU/model ROAS·ACOS·TACOS·organic columns on the `/amazon` sellers table; SKU→product_code via the Amazon-FBA sku_map; unmapped→`''` residual. Note `mkt_fact` untouched. Add the channel ingestion table row.

- [ ] **Step 3: Update `BACKLOG.md`**

Under the `[odo]` Nikhil-suite item: mark P2 advertised-product **DONE** (SKU/model ROAS/ACOS/TACOS/organic shipped); keep **remaining P2** = search-term report + alt-purchase + ASIN-only resolution + per-SKU RTO/RTV as open fast-follows. Bump the `Last updated` header line.

- [ ] **Step 4: Update `CORE.md` `sales` schema bullet**

Append to the `sales` schema line: NEW `mkt_product_fact` (date×platform×product_code) + `stg_amazon_ads_product` + `recompute_amzn_ads_product`/`f_mkt_product_rollup` (Amazon advertised-product, product-grain ad metrics, S185); synthetic ads-product channel `…a5`. Bump CORE `Last updated`.

- [ ] **Step 5: Commit + push the knowledge files**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add systems/odo.md BACKLOG.md CORE.md
git commit -m "knowledge: Odo Amazon Ads P2 advertised-product (S185)"
git push
```

- [ ] **Step 6: Confirm clean state**

Run: `git -C . status` (root) and `git -C 05_Throttle status` — both clean, in sync with remotes. Worker version bumped, odo deployed, connector enabled + draining.

---

## Self-review notes
- **Spec coverage:** stg + fact + RPCs (Task 1) ✓; synthetic is_sale=false channel (Task 2) ✓; adapter + generalized createAdsReport + getAdProduct + adProductProbe (Task 3) ✓; sku_map reuse + unmapped residual (Task 1 RPC) ✓; UI 6 columns + Model/SKU aggregation (Task 5) ✓; two-sales-bases semantics (ROAS/ACOS use ad `conv_value`, TACOS/Organic use `sales_fact` gross via row gross) ✓; verification incl. reconciliation vs campaign total + mapped-coverage (Task 4) ✓; knowledge files (Task 6) ✓.
- **Type consistency:** RPC names `recompute_amzn_ads_product` / `f_mkt_product_rollup`, table `stg_amazon_ads_product` / `mkt_product_fact`, adapter kind `amazon_ads_product`, channel `00000000-0000-4000-a000-0000000000a5`, worker action `getAdProduct`, UI field `adProd` / `adByKey` — used identically across tasks.
- **Known confirm-at-build points (not placeholders):** exact report column keys (probe, Task 4 Step 1); `getMarketing` guard helper name to copy (Task 3 Step 4); `dispatch_channels` required columns (Task 2 Step 1 note); `turbo` filter name (Task 5 Step 4).
