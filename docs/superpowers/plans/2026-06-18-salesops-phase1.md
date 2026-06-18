# Salesops Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Verification convention (this codebase):** the Throttle monorepo has no unit-test harness. Per `05_Throttle/CLAUDE.md`, verification = (a) `npx turbo build --filter=@throttle/<app>` green, (b) Supabase schema/data checks via SQL, (c) `get_advisors` clean, (d) worker `curl` smoke. Each task's verification uses these, not failing unit tests.

**Goal:** Ship a live consolidated cross-channel sales dashboard (variant×day×channel, units + gross ₹) covering Website (Shopify, live), Quick Commerce (report upload), and GT/MT (from Snorkel), with hourly auto-refresh, manual refresh, mapping/unmapped admin, and CSV/XLSX export.

**Architecture:** New standalone system `apps/sales` + `salesops-worker` + new `sales` Postgres schema + `store.salesops_roles/_user_roles` permission layer. Connector framework: per-channel adapters (`fetch`/`stage`) feed a shared `mapAndUpsert` tail into `sales.sales_fact`. Cloudflare cron drives hourly pulls; QC uses the same tail via file upload. Cloned from the Manifest worker/app scaffold + csops Shopify integration.

**Tech Stack:** Cloudflare Workers (JS), Supabase Postgres + PostgREST (service_role), Next.js 14 (App Router, static export), `@throttle/{auth,db,ui,domain}`, GH-Pages deploy.

**Reference spec:** `docs/superpowers/specs/2026-06-18-salesops-consolidated-sales-design.md`

---

## File structure

**Worker** (`05_Throttle/salesops-worker/`)
- `wrangler.toml` — worker config, `[triggers] crons = ["0 * * * *"]`, secret names.
- `package.json` — wrangler dep.
- `src/index.js` — CORS, verifyJWT, sb helpers, action router (GET+POST), `scheduled()` cron, all actions.
- `src/pipeline.js` — `mapAndUpsert` tail (resolveSkus + recomputeFacts) + run-log helpers.
- `src/adapters/shopify.js` — Shopify orders adapter (fetch+stage).
- `src/adapters/snorkel.js` — GT/MT DB-read adapter.
- `src/adapters/qc.js` — QC report parser (`parseUpload`+stage).
- `migrations/*.sql` — DDL kept for reference (applied via Supabase MCP `apply_migration`).

**App** (`05_Throttle/apps/sales/`) — mirror `apps/manifest` structure
- `package.json`, `next.config.js`, `jsconfig.json`
- `src/app/layout.js`, `src/app/page.js`, `src/app/login/page.js`
- `src/app/(auth)/layout.js` (shell + nav + AppLauncher), `/(auth)/page.js` (Dashboard)
- `src/app/(auth)/mapping/page.js`, `/connectors/page.js`, `/uploads/page.js`, `/admin/page.js`
- `src/lib/api.js` (salesFetch/salesPost wrappers over `@throttle/db`), `src/lib/format.js`
- `src/components/*` (SalesGrid, KpiCards, ChannelFilter, ExportButton, UnmappedQueue, …)

**Deploy** — `.github/workflows/deploy-sales.yml`; new gh-pages repo `legendlot/sales`; `packages/ui/AppLauncher.js` gains a Sales tile.

---

## Task 1: `sales` schema + permission tables + grants + seed

**Files:** Create `salesops-worker/migrations/0001_sales_schema_v1.sql` (reference copy); apply via Supabase MCP `apply_migration` name `sales_schema_v1`.

- [ ] **Step 1: Apply the schema migration** (Supabase MCP `apply_migration`, project `jkxcnjabmrkteanzoofj`, name `sales_schema_v1`):

```sql
CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE sales.sales_fact (
  id bigserial PRIMARY KEY,
  sale_date date NOT NULL,
  channel_id uuid NOT NULL,
  product_code text NOT NULL,
  units integer NOT NULL DEFAULT 0,
  gross_value numeric(14,2) NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'INR',
  source_kind text NOT NULL,
  last_run_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_date, channel_id, product_code)
);
CREATE INDEX ON sales.sales_fact (channel_id, sale_date);
CREATE INDEX ON sales.sales_fact (product_code, sale_date);

CREATE TABLE sales.connector_config (
  channel_id uuid PRIMARY KEY,
  adapter_kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  cursor text,
  schedule_note text,
  last_ok_at timestamptz,
  last_error text
);

CREATE TABLE sales.connector_runs (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  adapter_kind text NOT NULL,
  trigger text NOT NULL,
  window_from timestamptz, window_to timestamptz,
  cursor_before text, cursor_after text,
  status text NOT NULL DEFAULT 'running',
  rows_fetched int DEFAULT 0, rows_mapped int DEFAULT 0, rows_unmapped int DEFAULT 0,
  facts_upserted int DEFAULT 0, subrequests_used int,
  error text,
  started_at timestamptz DEFAULT now(), finished_at timestamptz, started_by uuid
);
CREATE INDEX ON sales.connector_runs (channel_id, started_at DESC);

CREATE TABLE sales.sku_map (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  channel_sku text NOT NULL,
  product_code text NOT NULL,
  match_on text,
  created_by uuid, created_at timestamptz DEFAULT now(),
  UNIQUE (channel_id, channel_sku)
);

CREATE TABLE sales.unmapped_sku (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  channel_sku text NOT NULL,
  sample_title text,
  first_seen timestamptz DEFAULT now(), last_seen timestamptz,
  occurrences integer DEFAULT 1,
  pending_units integer DEFAULT 0, pending_gross numeric(14,2) DEFAULT 0,
  status text DEFAULT 'open',
  resolved_product_code text, resolved_by uuid, resolved_at timestamptz,
  UNIQUE (channel_id, channel_sku)
);

CREATE TABLE sales.upload_batch (
  id bigserial PRIMARY KEY,
  channel_id uuid NOT NULL,
  storage_path text NOT NULL,
  file_name text, mime_type text,
  report_period_from date, report_period_to date,
  status text DEFAULT 'uploaded',
  rows_total int, rows_mapped int, rows_unmapped int,
  uploaded_by uuid, uploaded_at timestamptz DEFAULT now(), parsed_at timestamptz, error text
);

CREATE TABLE sales.stg_shopify (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  source_order_id text, order_name text, source_line_id text NOT NULL,
  occurred_at timestamptz, sale_date date,
  channel_sku text, variant_title text, title text,
  qty integer, gross_value numeric(14,2),
  order_status text, is_cancelled boolean DEFAULT false,
  raw jsonb, ingested_at timestamptz DEFAULT now(),
  UNIQUE (source_line_id)
);

CREATE TABLE sales.stg_snorkel (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  source_order_id text, source_line_id text NOT NULL,
  sale_date date, channel_sku text, title text,
  qty integer, gross_value numeric(14,2),
  order_status text, is_cancelled boolean DEFAULT false,
  raw jsonb, ingested_at timestamptz DEFAULT now(),
  UNIQUE (source_line_id)
);

CREATE TABLE sales.stg_qc (
  id bigserial PRIMARY KEY, run_id bigint, channel_id uuid NOT NULL,
  upload_batch_id bigint NOT NULL, row_no int NOT NULL,
  sale_date date, channel_sku text, title text,
  qty integer, gross_value numeric(14,2),
  is_cancelled boolean DEFAULT false,
  raw jsonb, ingested_at timestamptz DEFAULT now(),
  UNIQUE (upload_batch_id, row_no)
);

-- enable RLS (service_role bypasses; no anon policies = locked)
ALTER TABLE sales.sales_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.connector_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.connector_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.sku_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.unmapped_sku ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.upload_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.stg_shopify ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.stg_snorkel ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales.stg_qc ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA sales TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA sales TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA sales TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA sales GRANT ALL ON SEQUENCES TO service_role;
```

- [ ] **Step 2: Expose `sales` to PostgREST** (Supabase MCP `execute_sql`). First read the current setting, then append `sales`:

```sql
-- inspect current exposed schemas
SELECT rolname, rolconfig FROM pg_roles WHERE rolname='authenticator';
```
Then (append `sales` to the existing list — do NOT drop existing entries):
```sql
ALTER ROLE authenticator SET pgrst.db_schemas = 'public, graphql_public, store, brand, ignition, podium, docket, manifest, sales';
NOTIFY pgrst, 'reload config';
```

- [ ] **Step 3: Permission tables in `store`** (`apply_migration` name `salesops_roles_v1`):

```sql
CREATE TABLE store.salesops_roles (
  id bigserial PRIMARY KEY,
  role_key text UNIQUE NOT NULL,
  label text NOT NULL,
  description text,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_system boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE store.salesops_user_roles (
  user_id uuid PRIMARY KEY,
  role_key text NOT NULL REFERENCES store.salesops_roles(role_key),
  active boolean NOT NULL DEFAULT true,
  assigned_by uuid, assigned_at timestamptz DEFAULT now(),
  disabled_at timestamptz, disabled_by uuid
);
ALTER TABLE store.salesops_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE store.salesops_user_roles ENABLE ROW LEVEL SECURITY;
GRANT ALL ON store.salesops_roles TO service_role;
GRANT ALL ON store.salesops_user_roles TO service_role;
GRANT ALL ON SEQUENCE store.salesops_roles_id_seq TO service_role;

INSERT INTO store.salesops_roles (role_key, label, description, permissions, is_system) VALUES
('admin','Administrator','Full access incl. access control',
 '{"sales_view":true,"sales_refresh":true,"sales_upload":true,"sales_mapping_manage":true,"sales_connector_manage":true,"salesops_admin":true,"salesops_super_admin":true}'::jsonb, true),
('analyst','Analyst','View + export + refresh + mapping',
 '{"sales_view":true,"sales_refresh":true,"sales_upload":true,"sales_mapping_manage":true}'::jsonb, true),
('viewer','Viewer','Read-only dashboard + export',
 '{"sales_view":true}'::jsonb, true);
```

- [ ] **Step 4: Seed `connector_config`** from `dispatch_channels` (`execute_sql`):

```sql
INSERT INTO sales.connector_config (channel_id, adapter_kind, enabled, schedule_note)
SELECT id,
  CASE name
    WHEN 'Website' THEN 'shopify'
    WHEN 'GT' THEN 'snorkel_internal'
    WHEN 'MT' THEN 'snorkel_internal'
    WHEN 'Blinkit' THEN 'qc_upload'
    WHEN 'Zepto' THEN 'qc_upload'
    WHEN 'Instamart' THEN 'qc_upload'
    ELSE 'qc_upload' END,
  CASE WHEN name IN ('Website','GT','MT') THEN true ELSE false END,
  NULL
FROM public.dispatch_channels
WHERE is_sale = true
ON CONFLICT (channel_id) DO NOTHING;
```

- [ ] **Step 5: Verify** (`execute_sql`):

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='sales' ORDER BY 1;
SELECT cc.adapter_kind, dc.name, cc.enabled FROM sales.connector_config cc JOIN public.dispatch_channels dc ON dc.id=cc.channel_id ORDER BY 1,2;
SELECT role_key, is_system FROM store.salesops_roles;
```
Expected: 9 `sales.*` tables; connector_config has Website/GT/MT enabled; 3 roles. Then run Supabase MCP `get_advisors` (type `security` + `performance`) — expect no new ERROR-level findings on `sales.*` (RLS-enabled, no anon policy = expected/acceptable for a service-role-only schema, same as manifest).

- [ ] **Step 6: Commit reference SQL**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
git add salesops-worker/migrations/0001_sales_schema_v1.sql
git commit -m "salesops: sales schema + salesops perm tables + connector_config seed"
```

---

## Task 2: Aggregate RPCs (recompute facts + dashboard rollup)

**Files:** `apply_migration` name `salesops_rpcs_v1`.

- [ ] **Step 1: `sales.recompute_facts(p_channel uuid, p_dates date[])`** — delete+reinsert facts for the affected (channel, dates) from the channel's staging table, joined through `sku_map`. One function dispatches by adapter_kind to the right `stg_*` table via dynamic SQL over a UNION view. Apply:

```sql
-- unified staging view (only mapped, non-cancelled rows surface here)
CREATE OR REPLACE VIEW sales.v_staged AS
  SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'shopify'::text src FROM sales.stg_shopify
  UNION ALL SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'snorkel' FROM sales.stg_snorkel
  UNION ALL SELECT channel_id, sale_date, channel_sku, qty, gross_value, is_cancelled, 'qc' FROM sales.stg_qc;

CREATE OR REPLACE FUNCTION sales.recompute_facts(p_channel uuid, p_dates date[], p_run_id bigint)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n integer;
BEGIN
  DELETE FROM sales.sales_fact WHERE channel_id=p_channel AND sale_date = ANY(p_dates);
  INSERT INTO sales.sales_fact (sale_date, channel_id, product_code, units, gross_value, source_kind, last_run_id)
  SELECT s.sale_date, s.channel_id, m.product_code,
         SUM(s.qty)::int, SUM(s.gross_value)::numeric(14,2), MAX(s.src), p_run_id
  FROM sales.v_staged s
  JOIN sales.sku_map m ON m.channel_id=s.channel_id AND m.channel_sku=s.channel_sku
  WHERE s.channel_id=p_channel AND s.sale_date = ANY(p_dates) AND s.is_cancelled = false
  GROUP BY s.sale_date, s.channel_id, m.product_code
  HAVING SUM(s.qty) <> 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION sales.recompute_facts(uuid, date[], bigint) TO service_role;
```

- [ ] **Step 2: `sales.f_sales_rollup(...)`** — the dashboard query. Returns rows grouped by the requested axis with a variant label:

```sql
CREATE OR REPLACE FUNCTION sales.f_sales_rollup(
  p_from date, p_to date, p_channels uuid[] DEFAULT NULL,
  p_product_code text DEFAULT NULL, p_group text DEFAULT 'variant')
RETURNS TABLE(grp_key text, grp_label text, sale_date date, channel_id uuid,
              product_code text, units bigint, gross_value numeric)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    CASE p_group WHEN 'date' THEN f.sale_date::text
                 WHEN 'channel' THEN f.channel_id::text
                 ELSE f.product_code END AS grp_key,
    CASE p_group WHEN 'channel' THEN dc.name
                 WHEN 'variant' THEN coalesce(pm.product,'')||' '||coalesce(pm.model,'')||' '||coalesce(pm.color,'')
                 ELSE '' END AS grp_label,
    f.sale_date, f.channel_id, f.product_code,
    SUM(f.units)::bigint, SUM(f.gross_value)::numeric
  FROM sales.sales_fact f
  LEFT JOIN public.dispatch_channels dc ON dc.id=f.channel_id
  LEFT JOIN public.product_master pm ON pm.product_code=f.product_code
  WHERE f.sale_date BETWEEN p_from AND p_to
    AND (p_channels IS NULL OR f.channel_id = ANY(p_channels))
    AND (p_product_code IS NULL OR f.product_code = p_product_code)
  GROUP BY grp_key, grp_label, f.sale_date, f.channel_id, f.product_code
$$;
GRANT EXECUTE ON FUNCTION sales.f_sales_rollup(date,date,uuid[],text,text) TO service_role;
```

- [ ] **Step 3: Verify** — `SELECT * FROM sales.f_sales_rollup(current_date-30, current_date);` returns 0 rows cleanly (no data yet, no error). `get_advisors` clean.

- [ ] **Step 4: Commit** the reference SQL (`0002_salesops_rpcs_v1.sql`).

---

## Task 3: Worker scaffold — CORS, verifyJWT, sb helpers, router, getMe/getBootstrap

**Files:** Create `salesops-worker/{package.json,wrangler.toml,src/index.js}`. Clone structure from `manifestops-worker/src/index.js`.

- [ ] **Step 1: `package.json`** (copy `manifestops-worker/package.json`, rename to `salesops-worker`).
- [ ] **Step 2: `wrangler.toml`**:

```toml
name = "salesops"
main = "src/index.js"
compatibility_date = "2024-09-23"

[triggers]
crons = ["0 * * * *"]
```
(Secrets set later via `wrangler secret put`, NOT in this file.)

- [ ] **Step 3: `src/index.js` head** — copy from `manifestops-worker/src/index.js`: `SUPABASE_URL`, publishable `SUPABASE_KEY`, `CORS`, `verifyJWT()`, `sbProfiled()`. Define `sbSales = (p,o)=>sbProfiled(p,'sales',o)`, `sbStore = (p,o)=>sbProfiled(p,'store',o)`, `sbPublic = (p,o)=>sbProfiled(p,null,o)`. Replace the manifest permission loader with:

```js
async function getSalesPerms(userId) {
  const r = await sbStore(`/rest/v1/salesops_user_roles?user_id=eq.${userId}&active=is.true&select=role_key`);
  const roleKey = r.data?.[0]?.role_key;
  if (!roleKey) return { roleKey: null, perms: {} };
  const rr = await sbStore(`/rest/v1/salesops_roles?role_key=eq.${roleKey}&select=permissions`);
  return { roleKey, perms: rr.data?.[0]?.permissions || {} };
}
```
`verifyJWT` returns `{ userId, email, fullName, roleKey, perms }`. Gate helpers: `const can = (P,k)=>!!P.perms[k];`.

- [ ] **Step 4: Action router** — `fetch(request, env, ctx)`: handle OPTIONS (CORS), set `SUPABASE_SERVICE_KEY=env.SUPABASE_SERVICE_KEY`, verifyJWT, then GET `?action=` switch + POST `body.action` switch (clone manifest's dispatch shape). Add `getMe` (returns identity + perms) and `ping`.

- [ ] **Step 5: `getBootstrap`** — gather in parallel (respect subrequest cap, ~5 calls): enabled+all `connector_config` joined to channel names, last run per channel (one `connector_runs?order=started_at.desc&limit=50`), `unmapped_sku?status=eq.open&select=count`, and if `salesops_admin` the roles + `salesops_user_roles`. Return one object.

- [ ] **Step 6: Deploy + smoke**:

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/salesops-worker
npx wrangler secret put SUPABASE_SERVICE_KEY   # paste sb_secret key
npx wrangler deploy
curl -s "https://salesops.<account>.workers.dev/?action=ping"   # expect 401 (no JWT) — proves it's up + gated
```
Expected: worker deploys; unauthenticated `getMe`/`ping` returns 401 with CORS headers (matches manifest behavior).

- [ ] **Step 7: Commit** (`salesops: worker scaffold — auth, router, getMe/getBootstrap`).

---

## Task 4: Pipeline tail — resolveSkus + mapAndUpsert + run helpers

**Files:** Create `salesops-worker/src/pipeline.js`; import into `index.js`.

- [ ] **Step 1: Run-log helpers** — `startRun(cfg, trigger, sbSales, userId)` inserts a `connector_runs` row (status running) and returns `{id}`; `finishRun(runId, {status, counts, cursorAfter, subreqs}, sbSales)`; `failRun(runId, err, sbSales)`.

- [ ] **Step 2: `resolveSkus(channelId, dates, sbSales, sbPublic)`** — for the distinct `channel_sku`s present in staging for those dates with no `sku_map` row: try `product_master` match by `sku` → `ean` → `product_code` (one `product_master` fetch of the candidate set, matched in-memory — NOT per-row). Auto-insert `sku_map` rows for hits (`match_on`); upsert the misses into `unmapped_sku` (increment occurrences, set pending_units/gross from staging aggregate) via `Prefer: resolution=merge-duplicates`. Returns `{mapped, unmapped}`.

```js
// signature
export async function resolveSkus(channelId, dates, sb, sbPublic) { /* batch match, no per-row await */ }
export async function mapAndUpsert(channelId, dates, runId, sb, sbPublic) {
  const r = await resolveSkus(channelId, dates, sb, sbPublic);
  const f = await sb(`/rest/v1/rpc/recompute_facts`, { method:'POST',
    body: JSON.stringify({ p_channel: channelId, p_dates: dates, p_run_id: runId }) });
  return { ...r, factsUpserted: f.data };
}
```

- [ ] **Step 3: Verify** (after Task 5 wires an adapter) — covered by Task 5 smoke. For now build-check the worker (`npx wrangler deploy --dry-run`).

- [ ] **Step 4: Commit** (`salesops: connector pipeline tail (resolveSkus + mapAndUpsert)`).

---

## Task 5: Shopify adapter (Website, live)

**Files:** Create `salesops-worker/src/adapters/shopify.js`; wire into `refreshNow` + cron in `index.js`.

- [ ] **Step 1: Copy Shopify auth** — lift `getShopifyToken()` (client-credentials mint + module-scope cache + 401-retry) and the GraphQL `POST /admin/api/${VER}/graphql.json` caller from `csops-worker/src/index.js` (~L93–188). Secrets: `SHOPIFY_CLIENT_ID/SECRET/STORE_DOMAIN/API_VERSION` (reuse the same values as csops/ignition).

- [ ] **Step 2: `fetch({env, channelId, cursor, windowTo, budget})`** — query `orders(query: "updated_at:>=<cursor>", first:100, after:<pageCursor>)` with `lineItems(first:50){ id quantity sku variantTitle title originalTotalSet{ shopMoney{ amount } } }`, `createdAt updatedAt displayFinancialStatus cancelledAt`. Paginate until `budget` low or no next page (`partial=true` if stopped early). Build `NormLine[]`: `sale_date = createdAt → IST date`; `is_cancelled = !!cancelledAt || financialStatus IN (REFUNDED, VOIDED)`; `gross_value = Number(line.originalTotalSet.shopMoney.amount)`; `channel_sku = sku || variantTitle`; `cursorAfter = max(updatedAt)`.

- [ ] **Step 3: `stage(rows, runId, sb)`** — bulk upsert into `sales.stg_shopify` with `Prefer: resolution=merge-duplicates` keyed on `source_line_id` (the line GID). Array insert (one call), never per-row.

- [ ] **Step 4: `refreshNow` action** (POST, perm `sales_refresh`) — `ctx.waitUntil(runChannel(cfg, 'manual', userId))`; return `{run_id}` immediately. `runChannel` = startRun → adapter.fetch → adapter.stage → mapAndUpsert → finishRun, advance cursor on success.

- [ ] **Step 5: Smoke (LIVE)**:

```bash
npx wrangler secret put SHOPIFY_CLIENT_ID   # + SECRET, STORE_DOMAIN, API_VERSION
npx wrangler deploy
# from the app (with a JWT) or curl with a valid bearer token:
curl -s -X POST "https://salesops.<acct>.workers.dev/" -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" -d '{"action":"refreshNow","data":{"channel_id":"<Website uuid>"}}'
```
Then verify in Supabase: `SELECT count(*) FROM sales.stg_shopify;` > 0; `SELECT * FROM sales.connector_runs ORDER BY id DESC LIMIT 1;` status `ok`; `SELECT * FROM sales.sales_fact WHERE source_kind='shopify' LIMIT 5;`. Run `refreshNow` again → fact totals unchanged (idempotent). Check `unmapped_sku` for any Shopify SKUs not in product_master.

- [ ] **Step 6: Commit** (`salesops: Shopify (Website) sell-out adapter — live`).

---

## Task 6: Snorkel GT/MT adapter

**Files:** Create `salesops-worker/src/adapters/snorkel.js`; wire into cron + refreshNow.

- [ ] **Step 1: `fetch({cursor})`** — `sbStore('/rest/v1/sales_orders?status=eq.confirmed&order_date=gte.<cursor date>&select=id,order_no,order_date,channel_key,confirmed_at,status,sales_order_lines(id,product,model,color,sku,qty,taxable_value)')` (PostgREST embedded resource). Map each line → `NormLine`: `sale_date = order_date` (already IST), `channel_sku = sku || product||' '||model||' '||color`, `qty`, `gross_value = Number(taxable_value)`, `source_line_id = line.id`, `is_cancelled = (status==='cancelled')`. Map `channel_key` ('GT'/'MT') → the matching `connector_config` row / `dispatch_channels.id`. `cursorAfter = max(confirmed_at||order_date)`.

- [ ] **Step 2: `stage`** → `sales.stg_snorkel` upsert on `source_line_id`.

- [ ] **Step 3: Note on mapping** — GT/MT `channel_sku` should resolve via `product_master` by `sku`; seed a few `sku_map` rows if Snorkel uses product+model+color strings without SKU (resolve via the unmapped queue on first run — acceptable).

- [ ] **Step 4: Smoke** — confirm a test Snorkel sales order (or pick an existing confirmed one), `refreshNow` the GT (or MT) channel, verify `stg_snorkel` + `sales_fact` rows appear on `order_date`. (Note: `sales_orders` is currently empty — the path is verified structurally + against the first real confirmed order.)

- [ ] **Step 5: Commit** (`salesops: GT/MT adapter (reads Snorkel confirmed sales orders)`).

---

## Task 7: QC report upload path

**Files:** Create `salesops-worker/src/adapters/qc.js`; add `uploadReport`/`getUploadBatches` actions; create private Storage bucket `salesops-uploads`.

- [ ] **Step 1: Bucket** — create private bucket `salesops-uploads` (Supabase Storage; mirror `manifest-docs` setup). Document the signed-upload-URL flow (frontend uploads file → gets path → POSTs path).

- [ ] **Step 2: `uploadReport` action** (POST, perm `sales_upload`) — input `{channel_id, storage_path, file_name, mime_type, report_period_from, report_period_to, column_map}`. Insert `upload_batch` (status uploaded). Then `parseUpload`.

- [ ] **Step 3: `parseUpload(batch, sb)`** — download file from Storage (service_role GET on the object), parse CSV (and XLSX via a lightweight parser — for Phase 1 accept CSV; XLSX export-to-CSV note if needed). Using `column_map` (which columns = SKU / product name / units / gross), build `NormLine[]` with `sale_date` from the report's date column (or the batch period if the report is a period total — then spread/assign to a single representative date per the portal's grain; document per-portal). **Supersede:** delete prior `stg_qc` rows for this `channel_id` whose `upload_batch_id` ∈ batches overlapping `report_period` before inserting. Then `stage` (stg_qc, upsert on `(upload_batch_id,row_no)`) → `mapAndUpsert` for the affected dates. Update batch status `mapped` + counts.

- [ ] **Step 4: Smoke** — upload a sample Blinkit CSV (a few rows; some SKUs unknown). Verify `upload_batch` parsed, `stg_qc` rows, unknown SKUs in `unmapped_sku` with pending units, mapped rows in `sales_fact`. Re-upload a corrected file for the same period → old rows superseded, no double-count (`SELECT SUM(units) FROM sales_fact WHERE channel_id=<Blinkit>` stable).

- [ ] **Step 5: Commit** (`salesops: QC report upload + parse + supersede path`).

---

## Task 8: Cron + remaining worker actions

**Files:** `salesops-worker/src/index.js`.

- [ ] **Step 1: `scheduled(event, env, ctx)`** — set service key; load `connector_config?enabled=is.true`; `let budget=45`; for each cfg: if `budget<8` break (defer to next hour); `runChannel(cfg,'cron')`, subtract `subreqs`. (Per the spec cron loop.)

- [ ] **Step 2: Dashboard + admin actions** — implement:
  - GET `getSales` → call `rpc/f_sales_rollup` with params; return rows.
  - GET `getSalesExport` → same, shaped flat for CSV.
  - GET `getConnectorStatus` → config + last run + `{ shopify: !!env.SHOPIFY_CLIENT_ID, amazon: !!env.AMAZON_LWA_CLIENT_ID, flipkart: !!env.FLIPKART_CLIENT_ID }`.
  - GET `getRuns`, `getSkuMap`, `getUnmapped`, `getUploadBatches`.
  - POST `createSkuMap`/`updateSkuMap`/`deleteSkuMap` (perm `sales_mapping_manage`).
  - POST `resolveUnmapped` (perm `sales_mapping_manage`) → insert `sku_map`, mark queue resolved, call `recompute_facts` for that channel over the staging dates carrying the channel_sku (query distinct dates first).
  - POST `setConnectorEnabled` (perm `sales_connector_manage`).
  - POST `backfill` (perm `sales_connector_manage`) → `ctx.waitUntil` a dated-window run, chunked.
  - POST access-control (`createSalesRole`/`deleteRole`/`setUserActive`/`grantAccess`) gated `salesops_super_admin`, with last-super-admin/self/system-role guards — clone verbatim from `manifestops-worker` access-control handlers.

- [ ] **Step 3: Deploy + smoke** — `npx wrangler deploy`; with a JWT: `getBootstrap`, `getSales`, `getConnectorStatus` return 200; `createSkuMap` then `getSkuMap` reflects it; trigger cron manually (`wrangler dev` + scheduled, or wait for the top of the hour) → a fresh `connector_runs` row appears for each enabled channel.

- [ ] **Step 4: Commit** (`salesops: hourly cron + dashboard/mapping/admin actions`).

---

## Task 9: App scaffold (`apps/sales`)

**Files:** Create `apps/sales/**` mirroring `apps/manifest`.

- [ ] **Step 1: Copy scaffold** — `package.json` (name `@throttle/sales`), `next.config.js`, `jsconfig.json`, `src/app/{layout.js,page.js,login/page.js}`, `(auth)/layout.js` from `apps/manifest`, swapping branding + worker URL env (`NEXT_PUBLIC_SALESOPS_URL`).
- [ ] **Step 2: `src/lib/api.js`** — `salesGet(action, params, session)` / `salesPost(action, data, session)` wrapping `@throttle/db` `workerFetch` against `NEXT_PUBLIC_SALESOPS_URL`.
- [ ] **Step 3: `(auth)/layout.js`** — Sidebar nav (Dashboard / Mapping / Connectors / Uploads / Admin), Topbar with `AppLauncher`, RequireAuth + `getMe` perm gating (no role → Unauthorized wall, mirror manifest).
- [ ] **Step 4: Build** — `npx turbo build --filter=@throttle/sales` green (with a placeholder Dashboard page). Commit.

---

## Task 10: Dashboard page + CSV/XLSX export

**Files:** `apps/sales/src/app/(auth)/page.js` + `src/components/{SalesGrid,KpiCards,ChannelFilter,DateRange,ExportButton,TrendChart}.js`.

- [ ] **Step 1: Filters + fetch** — date range (default last 30d, IST), channel multi-select (from bootstrap channels), optional product search. Call `getSales` with `group` toggle (Variant / Date / Channel).
- [ ] **Step 2: KPI cards** — total units, total gross ₹, per-channel split (compute from rollup rows).
- [ ] **Step 3: Primary grid** — variant × day matrix (rows = variant, columns = days, cells = units; channel breakdown on hover/expand), or variant × channel by toggle. Use `@throttle/ui` table styling.
- [ ] **Step 4: Trend chart** — daily gross/units line (reuse the charting approach used in another app, e.g. Ignition/Podium analytics; if none, a simple SVG/inline bars).
- [ ] **Step 5: Export** — `ExportButton` builds CSV client-side from the current rollup (respect filters); XLSX via the same rows (SheetJS if already a dep, else CSV only + note). File name `salesops_<group>_<from>_<to>.csv`.
- [ ] **Step 6: Build green + commit.**

---

## Task 11: Mapping, Connectors, Uploads, Admin pages

**Files:** `apps/sales/src/app/(auth)/{mapping,connectors,uploads,admin}/page.js` + components.

- [ ] **Step 1: Mapping** — `getSkuMap` table (search/filter by channel) + `getUnmapped` queue; resolve modal = pick a `product_master` variant (Combobox), calls `resolveUnmapped`; shows pending units/₹. CRUD via `create/update/deleteSkuMap`.
- [ ] **Step 2: Connectors** — per-channel cards (name, adapter_kind, enabled toggle → `setConnectorEnabled`, last run status/time, secret-presence badge), `Refresh now` button → `refreshNow`, `Backfill` (date range) → `backfill`, runs log table (`getRuns`).
- [ ] **Step 3: Uploads** — channel + period picker + file input → signed-URL upload to `salesops-uploads` → `uploadReport`; batch history (`getUploadBatches`) with status + counts.
- [ ] **Step 4: Admin** — 3-tab (Access Control / Roles builder / about), clone manifest admin components; gated `salesops_admin`/`salesops_super_admin`.
- [ ] **Step 5: Build green + commit.**

---

## Task 12: Deploy pipeline + AppLauncher + go-live

**Files:** `.github/workflows/deploy-sales.yml`; `packages/ui/AppLauncher.js`; new gh-pages repo `legendlot/sales`.

- [ ] **Step 1: Deploy workflow** — copy `deploy-manifest.yml` → `deploy-sales.yml`, swap filter `@throttle/sales`, env `NEXT_PUBLIC_SALESOPS_URL=https://salesops.<acct>.workers.dev`, external_repository `legendlot/sales`, cname `sales.legendoftoys.com`.
- [ ] **Step 2: gh-pages repo + DNS** — create `legendlot/sales` repo; add the `sales` CNAME (Cloudflare DNS → gh-pages). (Manual/infra step — document for Afshaan.)
- [ ] **Step 3: AppLauncher** — add a Sales tile to `packages/ui/AppLauncher.js` (per the S151 pattern; include `sales.legendoftoys.com`). Note: this touches the shared package → rebuild ALL apps.
- [ ] **Step 4: Full build** — `npx turbo build` (all apps) green.
- [ ] **Step 5: Commit + push + deploy** — commit all; push (CI deploys the app); `cd salesops-worker && npx wrangler deploy`.
- [ ] **Step 6: Live smoke** — log into `sales.legendoftoys.com`, confirm Dashboard loads, Website channel shows real Shopify sales, refresh-now works, upload a QC report, resolve an unmapped SKU, export a CSV.

---

## Self-review notes
- **Spec coverage:** sales_fact/staging/sku_map/unmapped/connector_runs/config/upload_batch (T1), rollup+recompute RPCs (T2), worker scaffold+perms (T3), pipeline tail (T4), Shopify (T5), GT/MT (T6), QC upload+supersede (T7), cron+actions+access-control (T8), app+dashboard+CSV/XLSX (T9–10), mapping/connectors/uploads/admin (T11), deploy+AppLauncher (T12). All spec §3–§9 items mapped.
- **Idempotency/IST/cancellations:** UNIQUE keys (T1), updatedAt watermark + recompute (T5), IST `sale_date` derivation (T5/T6), QC supersede (T7).
- **Out of scope (later phases):** Amazon SP-API (P2), Flipkart v3 (P3), QC mailbox automation — each a single new adapter file + stg table + cron-enable, no framework change.
- **Knowledge-file updates** (session end): CORE.md (new system/worker/schema row, exposed-schemas list now includes `sales`), BUSINESS_RULES (RULE-SALES-001 sell-out grain + idempotency), BACKLOG ([sales] open items: Amazon P2, Flipkart P3, QC mailbox), systems/sales.md (new spoke).
