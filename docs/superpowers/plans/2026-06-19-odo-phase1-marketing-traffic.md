# Odo Phase 1 — Marketing + Traffic Domains (Meta Ads + GA4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize Odo's connector framework from one sell-out fact table to a multi-domain warehouse, and land two new data domains — **Meta Ads spend/performance** and **GA4 web traffic** — each with a thin view, so the team can see the width and we can compute blended ROAS.

**Architecture:** Keep the existing `adapter.fetch() → adapter.stage() → recompute` pipeline. Add a per-adapter `recompute()` step so non-sales adapters route to their own fact tables instead of the sales `mapAndUpsert`. New Supabase objects live in the `sales` schema: `stg_meta`/`stg_ga4` staging, `mkt_fact`/`traffic_fact`, and `recompute_mkt`/`recompute_traffic` RPCs (same delete+reinsert idempotency contract as `recompute_facts`). Two new `dispatch_channels` rows (`is_sale=false`) host the Meta + GA4 connectors so the existing cron/run/refresh machinery works unchanged. Two new app pages (Marketing, Funnel) read new rollup RPCs.

**Tech Stack:** Cloudflare Worker (`odoops`, single file `src/index.js`), Supabase Postgres (`sales` schema, service-role REST + RPC), Next.js App Router (`apps/odo`), Meta Graph API v21.0 (Marketing insights), Google Analytics Data API v1beta. **No unit-test harness exists — verification is live `curl` against the worker + SQL against the facts**, consistent with how odoops ships.

**Blast radius:** `odoops` worker serves **Odo only** (not lotopsproxy) — a bad deploy affects Odo alone. Still: edit → commit → push → `cd 05_Throttle/odoops-worker && npx wrangler deploy`.

**Prereqs already done (Session 156):** Meta token stored as `META_SYSTEM_USER_TOKEN` (verified, both accounts). GA4 property `473412351` (web, IST, INR); SA `podium-sync@podium-directory-sync.iam.gserviceaccount.com` granted Marketer; **confirm the Google Analytics Data API is enabled in the `podium-directory-sync` project** before Task 5.

**Meta ad accounts:** LOT Ads `1744812979746488`, LOT Ads 2 `1404587267520027`.

---

## File Structure

- **Supabase migration** `sales_multidomain_v1` — applied via `apply_migration` (MCP). New tables/RPCs/seed rows. No code file.
- **`05_Throttle/odoops-worker/src/index.js`** (949 lines, single file — follow its conventions):
  - generalize `executeRun` to call `adapter.recompute(...)` (default = sales tail).
  - generalize `googleSheetsToken` → `googleToken(env, scope)` (keep old name as a wrapper).
  - add `metaAdsAdapter` (kind `meta_ads`, stg `stg_meta`, custom recompute → `recompute_mkt`).
  - add `ga4Adapter` (kind `ga4`, stg `stg_ga4`, custom recompute → `recompute_traffic`).
  - register both in `ADAPTERS`.
  - add GET actions `getMarketing` + `getTraffic` (rollup RPCs).
- **`05_Throttle/apps/odo/src/app/(auth)/marketing/page.js`** — new Marketing view.
- **`05_Throttle/apps/odo/src/app/(auth)/funnel/page.js`** — new Funnel view.
- **`05_Throttle/apps/odo/src/app/(auth)/layout.js`** — add two NAV entries.
- **`05_Throttle/apps/odo/src/lib/api.js`** — no change needed (generic `salesGet`/`salesPost`).

---

## Task 1: Migration — multi-domain schema (`sales_multidomain_v1`)

**Files:** Supabase migration (MCP `apply_migration`, name `sales_multidomain_v1`). No repo file.

- [ ] **Step 1: Verify the dispatch_channels CHECK values** so the platform-row INSERT is valid.

Run (MCP `execute_sql`):
```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid='public.dispatch_channels'::regclass AND contype='c';
```
Expected: shows allowed `type` / `fulfillment_model` values. Pick a valid `type` for a non-sales platform (e.g. an existing value; if a CHECK restricts `type`, use the closest allowed value and set `is_sale=false`). Note the chosen values for Step 2.

- [ ] **Step 2: Apply the migration.**

Apply via `apply_migration` (name: `sales_multidomain_v1`). This is additive (CREATE only) — it will run autonomously (no DROP/TRUNCATE/DELETE):

```sql
-- ============ platform "channels" to host non-sales connectors ============
-- connector_config.channel_id has no FK, but the worker + app resolve names from
-- public.dispatch_channels, so we seed two is_sale=false rows. Fixed UUIDs for idempotent wiring.
INSERT INTO public.dispatch_channels (id, name, type, fulfillment_model, is_sale, is_active)
VALUES
  ('00000000-0000-4000-a000-0000000000a1','Meta Ads','<TYPE_FROM_STEP1>','<FM_FROM_STEP1>',false,true),
  ('00000000-0000-4000-a000-0000000000a2','GA4 Web','<TYPE_FROM_STEP1>','<FM_FROM_STEP1>',false,true)
ON CONFLICT (id) DO NOTHING;

-- ============ MARKETING domain ============
CREATE TABLE IF NOT EXISTS sales.stg_meta (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        bigint,
  channel_id    uuid NOT NULL,           -- the 'Meta Ads' platform channel
  ad_account_id text NOT NULL,
  campaign_id   text NOT NULL,
  campaign_name text,
  the_date      date NOT NULL,
  spend         numeric NOT NULL DEFAULT 0,
  impressions   bigint  NOT NULL DEFAULT 0,
  clicks        bigint  NOT NULL DEFAULT 0,
  conversions   numeric NOT NULL DEFAULT 0,
  conv_value    numeric NOT NULL DEFAULT 0,
  raw           jsonb,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, ad_account_id, campaign_id, the_date)
);

CREATE TABLE IF NOT EXISTS sales.mkt_fact (
  the_date      date NOT NULL,
  channel_id    uuid NOT NULL,
  platform      text NOT NULL,           -- 'meta' (later 'google','amazon')
  ad_account_id text NOT NULL,
  campaign_id   text NOT NULL,
  campaign_name text,
  spend         numeric NOT NULL DEFAULT 0,
  impressions   bigint  NOT NULL DEFAULT 0,
  clicks        bigint  NOT NULL DEFAULT 0,
  conversions   numeric NOT NULL DEFAULT 0,
  conv_value    numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (the_date, platform, ad_account_id, campaign_id)
);

-- delete+reinsert per (channel, dates) from staging — idempotent (mirrors recompute_facts)
CREATE OR REPLACE FUNCTION sales.recompute_mkt(p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=sales AS $$
DECLARE n integer;
BEGIN
  DELETE FROM sales.mkt_fact f
   WHERE f.channel_id = p_channel AND f.the_date = ANY(p_dates);
  INSERT INTO sales.mkt_fact (the_date, channel_id, platform, ad_account_id, campaign_id, campaign_name,
                              spend, impressions, clicks, conversions, conv_value)
  SELECT s.the_date, s.channel_id, 'meta', s.ad_account_id, s.campaign_id,
         max(s.campaign_name), sum(s.spend), sum(s.impressions), sum(s.clicks),
         sum(s.conversions), sum(s.conv_value)
    FROM sales.stg_meta s
   WHERE s.channel_id = p_channel AND s.the_date = ANY(p_dates)
   GROUP BY s.the_date, s.channel_id, s.ad_account_id, s.campaign_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ============ TRAFFIC domain ============
CREATE TABLE IF NOT EXISTS sales.stg_ga4 (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       bigint,
  channel_id   uuid NOT NULL,            -- the 'GA4 Web' platform channel
  the_date     date NOT NULL,
  src_group    text NOT NULL,            -- sessionDefaultChannelGroup
  sessions     bigint  NOT NULL DEFAULT 0,
  add_to_carts bigint  NOT NULL DEFAULT 0,
  checkouts    bigint  NOT NULL DEFAULT 0,
  purchases    bigint  NOT NULL DEFAULT 0,
  conv_value   numeric NOT NULL DEFAULT 0,
  raw          jsonb,
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, the_date, src_group)
);

CREATE TABLE IF NOT EXISTS sales.traffic_fact (
  the_date     date NOT NULL,
  channel_id   uuid NOT NULL,
  src_group    text NOT NULL,
  sessions     bigint  NOT NULL DEFAULT 0,
  add_to_carts bigint  NOT NULL DEFAULT 0,
  checkouts    bigint  NOT NULL DEFAULT 0,
  purchases    bigint  NOT NULL DEFAULT 0,
  conv_value   numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (the_date, channel_id, src_group)
);

CREATE OR REPLACE FUNCTION sales.recompute_traffic(p_channel uuid, p_dates date[], p_run_id bigint DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=sales AS $$
DECLARE n integer;
BEGIN
  DELETE FROM sales.traffic_fact f
   WHERE f.channel_id = p_channel AND f.the_date = ANY(p_dates);
  INSERT INTO sales.traffic_fact (the_date, channel_id, src_group, sessions, add_to_carts, checkouts, purchases, conv_value)
  SELECT s.the_date, s.channel_id, s.src_group, sum(s.sessions), sum(s.add_to_carts),
         sum(s.checkouts), sum(s.purchases), sum(s.conv_value)
    FROM sales.stg_ga4 s
   WHERE s.channel_id = p_channel AND s.the_date = ANY(p_dates)
   GROUP BY s.the_date, s.channel_id, s.src_group;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ============ rollup RPCs for the app ============
CREATE OR REPLACE FUNCTION sales.f_mkt_rollup(p_from date, p_to date, p_group text DEFAULT 'platform')
RETURNS TABLE(grp text, spend numeric, impressions bigint, clicks bigint, conversions numeric, conv_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=sales AS $$
  SELECT CASE WHEN p_group='campaign' THEN campaign_name ELSE platform END AS grp,
         sum(spend), sum(impressions), sum(clicks), sum(conversions), sum(conv_value)
    FROM sales.mkt_fact WHERE the_date BETWEEN p_from AND p_to
   GROUP BY 1 ORDER BY 2 DESC;
$$;

CREATE OR REPLACE FUNCTION sales.f_traffic_rollup(p_from date, p_to date)
RETURNS TABLE(src_group text, sessions bigint, add_to_carts bigint, checkouts bigint, purchases bigint, conv_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=sales AS $$
  SELECT src_group, sum(sessions), sum(add_to_carts), sum(checkouts), sum(purchases), sum(conv_value)
    FROM sales.traffic_fact WHERE the_date BETWEEN p_from AND p_to
   GROUP BY 1 ORDER BY 2 DESC;
$$;

-- ============ register the two connectors (disabled until their adapter ships) ============
INSERT INTO sales.connector_config (channel_id, adapter_kind, enabled, cursor, config) VALUES
  ('00000000-0000-4000-a000-0000000000a1','meta_ads', false, NULL,
     '{"accounts":["1744812979746488","1404587267520027"],"backfill_start":"2025-04-01"}'::jsonb),
  ('00000000-0000-4000-a000-0000000000a2','ga4', false, NULL,
     '{"property_id":"473412351","backfill_start":"2025-04-01"}'::jsonb)
ON CONFLICT (channel_id) DO NOTHING;

-- grants (match existing sales objects: service_role only)
GRANT EXECUTE ON FUNCTION sales.recompute_mkt(uuid,date[],bigint),
  sales.recompute_traffic(uuid,date[],bigint),
  sales.f_mkt_rollup(date,date,text), sales.f_traffic_rollup(date,date) TO service_role;
```

- [ ] **Step 3: Verify the migration.**

Run (MCP `execute_sql`):
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='sales'
  AND table_name IN ('stg_meta','mkt_fact','stg_ga4','traffic_fact');
SELECT channel_id, adapter_kind, enabled FROM sales.connector_config WHERE adapter_kind IN ('meta_ads','ga4');
SELECT id, name, is_sale FROM public.dispatch_channels WHERE id IN
  ('00000000-0000-4000-a000-0000000000a1','00000000-0000-4000-a000-0000000000a2');
```
Expected: 4 tables present; 2 connector rows `enabled=false`; 2 channel rows `is_sale=false`.

- [ ] **Step 4: Check advisors** (no new lint).

Run MCP `get_advisors` (type `security`). Expected: no new errors on the created objects (SECURITY DEFINER + fixed search_path already set; service_role-only grants mean RLS warnings are acceptable and match existing `sales.*` tables — confirm they match the pattern of existing `sales_fact`).

- [ ] **Step 5: Confirm with user** (no git — DB only). Report the verify output. No commit (migrations are tracked by Supabase).

---

## Task 2: Worker — branch `executeRun` by domain

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` (`executeRun` ~line 580; `mapAndUpsert` ~line 572).

- [ ] **Step 1: Add a default `recompute` to the sales adapters and a branch in `executeRun`.**

In `executeRun`, replace the fixed `mapAndUpsert` call with a per-adapter recompute. Find (≈ lines 585–589):
```javascript
    const { rows, cursorAfter, subreqs, partial } = await adapter.fetch({ env, channelId: cfg.channel_id, channelName: cname, cursor, windowTo: nowISO(), budget, config: cfg.config });
    await adapter.stage(rows, runId, cfg.channel_id);
    const dates = distinctDates(rows);
    const res = dates.length ? await mapAndUpsert(cfg.channel_id, dates, runId, adapter.stgTable, cfg.started_by) : { mapped: 0, unmapped: 0, factsUpserted: 0 };
```
Replace the last two lines with:
```javascript
    const dates = adapter.datesOf ? adapter.datesOf(rows) : distinctDates(rows);
    let res = { mapped: 0, unmapped: 0, factsUpserted: 0 };
    if (dates.length) {
      res = adapter.recompute
        ? await adapter.recompute({ channelId: cfg.channel_id, dates, runId })
        : await mapAndUpsert(cfg.channel_id, dates, runId, adapter.stgTable, cfg.started_by);
    }
```
(Sales adapters have no `recompute`/`datesOf` → unchanged behaviour. `mapAndUpsert` returns `{mapped,unmapped,factsUpserted}`; new-domain `recompute` returns the same shape with `mapped=0,unmapped=0`.)

- [ ] **Step 2: Deploy and verify existing sales connectors are unaffected.**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/odoops-worker
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add odoops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "odoops: branch executeRun by domain (adapter.recompute override)"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
npx wrangler deploy
```
Then trigger a Website refresh and confirm sales facts still recompute (regression check). Get a JWT-free check via the worker logs, or run MCP SQL before/after:
```sql
SELECT count(*), max(sale_date) FROM sales.sales_fact WHERE channel_id='c8b9f1cb-7ef4-4d24-ac61-00f4f2119040';
```
Expected: unchanged/again-populated (no error). Wrangler deploy succeeds.

---

## Task 3: Worker — generalize the Google token helper

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` (`googleSheetsToken` ~lines 275–297).

- [ ] **Step 1: Replace `googleSheetsToken` with a scope-parameterized `googleToken`, keeping the old name as a wrapper.**

Replace the function with:
```javascript
let _gTokById = {};  // scope → { token, exp }
async function googleToken(env, scope) {
  if (!env.GOOGLE_SA_JSON) throw new Error('Google not configured (set GOOGLE_SA_JSON secret)');
  const now = Math.floor(Date.now() / 1000);
  const c = _gTokById[scope];
  if (c && now < c.exp - 60) return c.token;
  const sa = JSON.parse(env.GOOGLE_SA_JSON);
  const header = _b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = _b64urlStr(JSON.stringify({
    iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey('pkcs8', _pemToPkcs8(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signingInput}.${_b64urlBytes(sig)}` }),
  });
  const t = await res.json().catch(() => ({}));
  if (!t.access_token) throw new Error('Google token failed: ' + JSON.stringify(t).slice(0, 160));
  _gTokById[scope] = { token: t.access_token, exp: now + (Number(t.expires_in) || 3600) };
  return t.access_token;
}
const googleSheetsToken = (env) => googleToken(env, 'https://www.googleapis.com/auth/spreadsheets.readonly');
```

- [ ] **Step 2: Commit (deploy happens with Task 5).**
```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add odoops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "odoops: generalize googleToken(scope); googleSheetsToken is now a wrapper"
```
No behaviour change (gsheet adapter still uses `googleSheetsToken`). Verify the gsheet connector still works at Task 5 deploy via a Zepto refresh + SQL.

---

## Task 4: Worker — Meta Ads adapter

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` — add `metaAdsAdapter`, register in `ADAPTERS` (~line 447).

- [ ] **Step 1: Add the adapter** (near the other adapter definitions, before `const ADAPTERS`):

```javascript
// ── Meta Ads (Marketing API insights) — domain: marketing ──────────────
const META_API_VER = 'v21.0';
const metaAdsAdapter = {
  kind: 'meta_ads', stgTable: 'stg_meta',
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, budget, config }) {
    if (!env.META_SYSTEM_USER_TOKEN) throw new Error('Meta not configured (set META_SYSTEM_USER_TOKEN)');
    const accounts = (config && config.accounts) || [];
    if (!accounts.length) throw new Error('Meta config.accounts empty');
    const since = (cursor || (config && config.backfill_start) || BACKFILL_START).slice(0, 10);
    const until = istDate(nowISO());                 // IST today
    const rows = []; let subreqs = 0, partial = false, maxDate = since;
    for (const acct of accounts) {
      let url = `https://graph.facebook.com/${META_API_VER}/act_${acct}/insights`
        + `?level=campaign&time_increment=1`
        + `&fields=campaign_id,campaign_name,spend,impressions,clicks,actions,action_values`
        + `&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}`
        + `&limit=200&access_token=${env.META_SYSTEM_USER_TOKEN}`;
      while (url) {
        if (subreqs >= budget) { partial = true; break; }
        const res = await fetch(url).catch(() => null); subreqs++;
        if (!res || !res.ok) {
          const b = res ? await res.text().catch(() => '') : '';
          throw new Error(`Meta ${res ? res.status : 'network'} act_${acct}: ${b.slice(0, 160)}`);
        }
        const j = await res.json();
        for (const d of (j.data || [])) {
          const day = d.date_start;
          if (day > maxDate) maxDate = day;
          const purch = (d.actions || []).find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase');
          const purchVal = (d.action_values || []).find(a => a.action_type === 'omni_purchase' || a.action_type === 'purchase');
          rows.push({
            channel_id: channelId, ad_account_id: acct,
            campaign_id: d.campaign_id, campaign_name: d.campaign_name || null, the_date: day,
            spend: num(d.spend), impressions: num(d.impressions), clicks: num(d.clicks),
            conversions: purch ? num(purch.value) : 0, conv_value: purchVal ? num(purchVal.value) : 0,
            raw: d,
          });
        }
        url = (j.paging && j.paging.next) || null;
      }
      if (partial) break;
    }
    return { rows, cursorAfter: maxDate, subreqs, partial };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, ad_account_id: r.ad_account_id, campaign_id: r.campaign_id,
      campaign_name: r.campaign_name, the_date: r.the_date, spend: r.spend, impressions: Math.round(r.impressions),
      clicks: Math.round(r.clicks), conversions: r.conversions, conv_value: r.conv_value, raw: r.raw,
    }));
    await sbSales('/rest/v1/stg_meta', { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_mkt', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};
```

- [ ] **Step 2: Register it** — edit the `ADAPTERS` map (~line 447):
```javascript
const ADAPTERS = { shopify: shopifyAdapter, snorkel_internal: snorkelAdapter, qc_upload: qcAdapter, qc_gsheet: gsheetAdapter, amazon_spapi: amazonAdapter, meta_ads: metaAdsAdapter, ga4: ga4Adapter };
```
(`ga4Adapter` is added in Task 5; if deploying Task 4 alone, omit `ga4: ga4Adapter` here and add it in Task 5.)

- [ ] **Step 3: Deploy + enable + verify.**
```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add odoops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "odoops: Meta Ads adapter (marketing domain → mkt_fact)"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/odoops-worker && npx wrangler deploy
```
Enable + trigger a run via SQL (no JWT needed — set enabled, then the hourly cron picks it up; or force a one-off by calling the worker with a service flow). Simplest verify path — enable, then manually invoke the cron-equivalent by SQL-seeding is not possible; instead trigger `refreshNow` through the app once Task 8 lands, OR temporarily enable and wait for cron. For an immediate check, run a **direct staging test** by enabling and calling `refreshNow` via curl with an admin JWT (Afshaan's session token) if available; otherwise enable and verify after the next cron tick:
```sql
UPDATE sales.connector_config SET enabled=true WHERE channel_id='00000000-0000-4000-a000-0000000000a1';
-- after a refresh/cron run:
SELECT count(*), min(the_date), max(the_date), round(sum(spend)) spend FROM sales.mkt_fact;
SELECT status, rows_fetched, facts_upserted, error FROM sales.connector_runs
  WHERE channel_id='00000000-0000-4000-a000-0000000000a1' ORDER BY started_at DESC LIMIT 3;
```
Expected: `mkt_fact` populates (spend ≈ ₹30L+/recent-30d across both accounts over the backfill window grows over successive runs), `connector_runs.status='ok'` (or `partial` while backfilling), `error` null. The backfill walks from 2025-04-01 forward via the cursor; Meta returns full ranges so it may complete in one run.

---

## Task 5: Worker — GA4 adapter

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` — add `ga4Adapter`, ensure it's in `ADAPTERS`.

- [ ] **Step 0: Confirm the Data API is enabled** in the `podium-directory-sync` GCP project (user prereq). If not done, the first run errors `Google Analytics Data API has not been used in project …` — that error message itself confirms the fix.

- [ ] **Step 1: Add the adapter:**
```javascript
// ── GA4 (Analytics Data API) — domain: traffic ────────────────────────
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const ga4Adapter = {
  kind: 'ga4', stgTable: 'stg_ga4',
  datesOf(rows) { return [...new Set(rows.map(r => r.the_date))].sort(); },
  async fetch({ env, channelId, cursor, budget, config }) {
    const prop = config && config.property_id;
    if (!prop) throw new Error('GA4 config.property_id missing');
    const startDate = (cursor || (config && config.backfill_start) || BACKFILL_START).slice(0, 10);
    const endDate = istDate(nowISO());
    const token = await googleToken(env, GA4_SCOPE);
    const rows = []; let subreqs = 0, partial = false, maxDate = startDate, offset = 0;
    const LIMIT = 100000;
    while (true) {
      if (subreqs >= budget) { partial = true; break; }
      const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'addToCarts' }, { name: 'checkouts' }, { name: 'ecommercePurchases' }, { name: 'purchaseRevenue' }],
          limit: LIMIT, offset, keepEmptyRows: false,
        }),
      }).catch(() => null);
      subreqs++;
      if (!res || !res.ok) { const b = res ? await res.text().catch(() => '') : ''; throw new Error(`GA4 ${res ? res.status : 'network'}: ${b.slice(0, 200)}`); }
      const j = await res.json();
      for (const row of (j.rows || [])) {
        const dv = row.dimensionValues, mv = row.metricValues;
        const ymd = dv[0].value;                                   // 'YYYYMMDD' in property TZ (IST)
        const the_date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
        if (the_date > maxDate) maxDate = the_date;
        rows.push({
          channel_id: channelId, the_date, src_group: dv[1].value || '(none)',
          sessions: num(mv[0].value), add_to_carts: num(mv[1].value), checkouts: num(mv[2].value),
          purchases: num(mv[3].value), conv_value: num(mv[4].value), raw: row,
        });
      }
      const total = Number(j.rowCount || 0);
      offset += LIMIT;
      if (offset >= total || !(j.rows || []).length) break;
    }
    return { rows, cursorAfter: maxDate, subreqs, partial };
  },
  async stage(rows, runId, channelId) {
    if (!rows.length) return;
    const body = rows.map(r => ({
      run_id: runId, channel_id: channelId, the_date: r.the_date, src_group: r.src_group,
      sessions: Math.round(r.sessions), add_to_carts: Math.round(r.add_to_carts), checkouts: Math.round(r.checkouts),
      purchases: Math.round(r.purchases), conv_value: r.conv_value, raw: r.raw,
    }));
    await sbSales('/rest/v1/stg_ga4', { method: 'POST', body: JSON.stringify(body), prefer: 'return=minimal,resolution=merge-duplicates' });
  },
  async recompute({ channelId, dates, runId }) {
    const f = await rpcSales('recompute_traffic', { p_channel: channelId, p_dates: dates, p_run_id: runId });
    return { mapped: 0, unmapped: 0, factsUpserted: (f.ok ? Number(f.data) : 0) };
  },
};
```
(GA4 re-pulls the whole `[startDate, today]` window each run and `recompute_traffic` deletes+reinserts those dates — idempotent. The `stg_ga4` UNIQUE + `merge-duplicates` prevents staging bloat. `cursor` advances to the max date so subsequent runs still re-pull from cursor → today, catching late conversions; if window growth ever strains the subrequest budget, add date-window chunking like Amazon — not needed at current volume.)

- [ ] **Step 2: Ensure `ga4: ga4Adapter` is in the `ADAPTERS` map** (added in Task 4 Step 2; confirm present).

- [ ] **Step 3: Deploy + enable + verify.**
```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add odoops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "odoops: GA4 adapter (traffic domain → traffic_fact)"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/odoops-worker && npx wrangler deploy
```
```sql
UPDATE sales.connector_config SET enabled=true WHERE channel_id='00000000-0000-4000-a000-0000000000a2';
-- after a run:
SELECT count(*), min(the_date), max(the_date), sum(sessions) sess, round(sum(conv_value)) rev FROM sales.traffic_fact;
SELECT status, rows_fetched, facts_upserted, error FROM sales.connector_runs
  WHERE channel_id='00000000-0000-4000-a000-0000000000a2' ORDER BY started_at DESC LIMIT 3;
```
Expected: `traffic_fact` populated by `src_group` × day; run `ok`. If error mentions Data API not enabled or SA permission → fix that one thing (enable API / confirm `podium-sync` is the SA), re-run.

---

## Task 6: Worker — `getMarketing` + `getTraffic` GET actions

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` — add two GET cases near `f_sales_rollup` handling (~line 717).

- [ ] **Step 1: Add the handlers** (mirror the `getSales` pattern that calls `rpcSales('f_sales_rollup', …)`):
```javascript
    case 'getMarketing': {
      if (!canView(P)) return err('No permission', 403);
      const r = await rpcSales('f_mkt_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO(), p_group: qp('group') || 'platform' });
      return ok({ rows: r.ok ? r.data : [] });
    }
    case 'getTraffic': {
      if (!canView(P)) return err('No permission', 403);
      const r = await rpcSales('f_traffic_rollup', { p_from: qp('from') || todayISO(), p_to: qp('to') || todayISO() });
      return ok({ rows: r.ok ? r.data : [] });
    }
```
(Use the exact GET routing/`qp()` helper present in the file — match how `getSales` reads query params and returns via `ok(...)`.)

- [ ] **Step 2: Deploy + verify with an admin JWT** (Afshaan's session token from the app; capture from browser devtools or reuse a known token):
```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add odoops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "odoops: getMarketing + getTraffic rollup actions"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/odoops-worker && npx wrangler deploy
```
```bash
# JWT = a live Odo session token
curl -s "https://odoops.afshaan.workers.dev/?action=getMarketing&from=2026-05-01&to=2026-06-18&group=platform" -H "Authorization: Bearer $JWT"
curl -s "https://odoops.afshaan.workers.dev/?action=getTraffic&from=2026-05-01&to=2026-06-18" -H "Authorization: Bearer $JWT"
```
Expected: JSON `{data:{rows:[…]}}` with Meta spend by platform and GA4 sessions by src_group. (Confirm the worker base URL from `wrangler.toml`/the app's `NEXT_PUBLIC_*` env — it's `odoops.afshaan.workers.dev` per systems/odo.md.)

---

## Task 7: App — Marketing page

**Files:** Create `05_Throttle/apps/odo/src/app/(auth)/marketing/page.js`.

- [ ] **Step 1: Create the page** (mirror the Connectors/Dashboard fetch pattern: `useAuth`, `salesGet`, date range, render a table). Keep it thin — a date-range header + a platform/campaign table + a blended-ROAS line (marketing spend vs sales gross from `getSales`):
```javascript
'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, istToday, istDaysAgo } from '../../../lib/api.js';

export default function MarketingPage() {
  const { session } = useAuth();
  const [from, setFrom] = useState(istDaysAgo(30));
  const [to, setTo] = useState(istToday());
  const [rows, setRows] = useState(null);
  const [salesGross, setSalesGross] = useState(0);

  useEffect(() => {
    if (!session) return;
    setRows(null);
    Promise.all([
      salesGet('getMarketing', { from, to, group: 'platform' }, session),
      salesGet('getSales', { from, to, group: 'variant' }, session),
    ]).then(([m, s]) => {
      setRows(m?.rows || []);
      setSalesGross((s?.rows || []).reduce((a, r) => a + Number(r.gross_value || r.gross || 0), 0));
    });
  }, [session, from, to]);

  const spend = (rows || []).reduce((a, r) => a + Number(r.spend || 0), 0);
  const roas = spend > 0 ? (salesGross / spend) : 0;
  const inr = n => '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN');

  return (
    <div style={{ padding: 24 }}>
      <h1>Marketing</h1>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} />
      </div>
      {!rows ? <Spinner /> : (
        <>
          <div style={{ display: 'flex', gap: 24, margin: '12px 0' }}>
            <div><div>Ad spend</div><b>{inr(spend)}</b></div>
            <div><div>Sales gross</div><b>{inr(salesGross)}</b></div>
            <div><div>Blended ROAS</div><b>{roas.toFixed(2)}×</b></div>
          </div>
          <table className="so-table"><thead><tr>
            <th>Platform</th><th className="so-num">Spend</th><th className="so-num">Impressions</th>
            <th className="so-num">Clicks</th><th className="so-num">Conv.</th><th className="so-num">Conv. value</th>
          </tr></thead><tbody>
            {rows.map((r, i) => (<tr key={i}>
              <td>{r.grp}</td><td className="so-num">{inr(r.spend)}</td>
              <td className="so-num">{Number(r.impressions).toLocaleString('en-IN')}</td>
              <td className="so-num">{Number(r.clicks).toLocaleString('en-IN')}</td>
              <td className="so-num">{Number(r.conversions).toLocaleString('en-IN')}</td>
              <td className="so-num">{inr(r.conv_value)}</td>
            </tr>))}
          </tbody></table>
        </>
      )}
    </div>
  );
}
```
(Match the actual `getSales` row shape — the dashboard sums `gross_value`; reuse the same field name it uses. Reuse existing `.so-table`/`.so-num` classes from the dashboard's CSS.)

- [ ] **Step 2: Build + verify the app compiles.**
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npm run build --workspace=apps/odo 2>&1 | tail -20
```
Expected: build succeeds (the monorepo CI only runs `next build`). Commit after Task 9 (nav + funnel together).

---

## Task 8: App — Funnel page

**Files:** Create `05_Throttle/apps/odo/src/app/(auth)/funnel/page.js`.

- [ ] **Step 1: Create the page** (same pattern, calls `getTraffic`):
```javascript
'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { salesGet, istToday, istDaysAgo } from '../../../lib/api.js';

export default function FunnelPage() {
  const { session } = useAuth();
  const [from, setFrom] = useState(istDaysAgo(30));
  const [to, setTo] = useState(istToday());
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (!session) return;
    setRows(null);
    salesGet('getTraffic', { from, to }, session).then(t => setRows(t?.rows || []));
  }, [session, from, to]);

  const sum = k => (rows || []).reduce((a, r) => a + Number(r[k] || 0), 0);
  const sessions = sum('sessions'), purchases = sum('purchases');
  const cr = sessions > 0 ? (purchases / sessions * 100) : 0;

  return (
    <div style={{ padding: 24 }}>
      <h1>Funnel</h1>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} />
      </div>
      {!rows ? <Spinner /> : (
        <>
          <div style={{ display: 'flex', gap: 24, margin: '12px 0' }}>
            <div><div>Sessions</div><b>{sessions.toLocaleString('en-IN')}</b></div>
            <div><div>Add to cart</div><b>{sum('add_to_carts').toLocaleString('en-IN')}</b></div>
            <div><div>Checkouts</div><b>{sum('checkouts').toLocaleString('en-IN')}</b></div>
            <div><div>Purchases</div><b>{purchases.toLocaleString('en-IN')}</b></div>
            <div><div>Conv. rate</div><b>{cr.toFixed(2)}%</b></div>
          </div>
          <table className="so-table"><thead><tr>
            <th>Source</th><th className="so-num">Sessions</th><th className="so-num">ATC</th>
            <th className="so-num">Checkouts</th><th className="so-num">Purchases</th>
          </tr></thead><tbody>
            {rows.map((r, i) => (<tr key={i}>
              <td>{r.src_group}</td><td className="so-num">{Number(r.sessions).toLocaleString('en-IN')}</td>
              <td className="so-num">{Number(r.add_to_carts).toLocaleString('en-IN')}</td>
              <td className="so-num">{Number(r.checkouts).toLocaleString('en-IN')}</td>
              <td className="so-num">{Number(r.purchases).toLocaleString('en-IN')}</td>
            </tr>))}
          </tbody></table>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build check** (deferred to Task 9 combined build).

---

## Task 9: App — nav entries + build + deploy

**Files:** Modify `05_Throttle/apps/odo/src/app/(auth)/layout.js` (NAV array ~lines 6–10).

- [ ] **Step 1: Add two NAV entries.** Import icons (e.g. `Megaphone`, `Filter` from lucide-react — match the existing import style) and insert after Dashboard:
```javascript
  { route: '/marketing', label: 'Marketing', icon: Megaphone, perm: 'sales_view' },
  { route: '/funnel',    label: 'Funnel',    icon: Filter,    perm: 'sales_view' },
```
(v1 gates both on `sales_view` — everyone with Odo read access sees them. The `marketing_view`/`cost_view` split is a later phase per the spec's open question.)

- [ ] **Step 2: Build the whole app.**
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npm run build --workspace=apps/odo 2>&1 | tail -20
```
Expected: compiles clean (routes `/marketing`, `/funnel` listed in the build output).

- [ ] **Step 3: Commit + push (CI deploys the app via `deploy-odo.yml`).**
```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/odo
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "odo app: Marketing + Funnel pages + nav (Phase 1 thin views)"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
```

- [ ] **Step 4: Verify live in the browser** (after gh-pages deploy ~2-3 min). Use the preview/verification tooling or ask: open odo.legendoftoys.com → Marketing shows spend + blended ROAS; Funnel shows sessions/conversion. Confirm numbers match the SQL from Tasks 4/5.

---

## Task 10: Knowledge files + close-out

**Files:** `systems/odo.md`, `BACKLOG.md` (workspace root repo).

- [ ] **Step 1: Update `systems/odo.md`** — add the multi-domain architecture (mkt_fact/traffic_fact + recompute_mkt/recompute_traffic), the Meta + GA4 connectors (accounts, GA4 property 473412351, platform channel uuids), the `googleToken(scope)` generalization, and the Marketing/Funnel pages. Bump the header note (Session 156/157).

- [ ] **Step 2: Update `BACKLOG.md`** — mark Phase-1 marketing/traffic connectors done; note remaining Phase-1 follow-ups (channel↔ad-account attribution map for per-channel ROAS; Amazon Ads connector; per-product ad attribution) and that Google Ads/Flipkart remain externally blocked.

- [ ] **Step 3: Commit knowledge files** (root repo):
```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add systems/odo.md BACKLOG.md
git commit -m "session: Odo Phase 1 — Meta Ads + GA4 connectors live (marketing + traffic domains)"
git push
```

- [ ] **Step 4: Confirm clean state** — `git status` on root + `05_Throttle` clean and pushed. Report the new width to the user: Meta spend, GA4 traffic, and the first blended-ROAS number.

---

## Notes / deferred (per the vision spec, NOT in this plan)
- **Per-channel ROAS attribution** (channel↔ad-account map) — v1 shows blended (total spend vs total sales) + platform/campaign breakdown only.
- **Amazon Ads** connector (reuse LWA app + Advertising scope) — next connector, same `mkt_fact` domain.
- **Google Ads / Flipkart** — parked on external approvals.
- **Channel pages, products page, reports, alerts, net settlement, margin, actions** — later phases, own specs.
- If Meta token rotates/expires, re-store `META_SYSTEM_USER_TOKEN`; adapter surfaces the Graph API error verbatim.
