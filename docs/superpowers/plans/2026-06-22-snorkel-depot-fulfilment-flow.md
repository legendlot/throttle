# Snorkel ↔ Depot Sales-Order Fulfilment Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Snorkel's one-shot "confirm → one shipment" with a multi-channel fulfilment workflow — confirm raises a fulfilment **request** the Depot team **accepts (full/split) or rejects**, shipments carry **tracking**, and fulfilment/tracking/collection state flows back to the sales order.

**Architecture:** Approach A. `snorkelops` owns `store.sales_*` (one-time request insert on confirm + read-time derived status + reject→cancel reconcile). `lotopsproxy`/Depot owns `public.dispatch_*` (request accept/reject, full/split shipment creation, cancel, tracking). New parent `public.dispatch_fulfilment_requests` (+ lines); shipments become its children. No retro-migration — only new confirms use the flow.

**Tech Stack:** Supabase Postgres (migrations via MCP `apply_migration`), Cloudflare Workers (`snorkelops`, `lotopsproxy`) plain-JS handlers, Next.js static-export apps (`apps/snorkel`, `apps/depot`) on the shared `@throttle/*` kits. No automated test harness — verification = `information_schema` schema checks, SQL data-path smoke via `execute_sql`, `npx turbo build` green, and authenticated browser passes. Project id `jkxcnjabmrkteanzoofj`.

**Spec:** `docs/superpowers/specs/2026-06-22-snorkel-depot-fulfilment-flow-design.md`.

**Permissions:** Snorkel keeps its perm layer (`sales_order_confirm`, `sales_order_manage`, `sales_partner_manage`, `sales_view`). Depot fulfilment actions gate on the existing `canManageFloor` (lotopsproxy). No new keys.

**Conventions (must follow):** PostgREST returns numerics as strings → wrap `Number()`; integer inserts → `Math.round()`. 50-subrequest limit → batch inserts, never per-row awaits. Cross-repo git = `git -C <path>`. Deploy = edit → commit → push → `cd <dir> && npx wrangler deploy`. **`lotopsproxy` deploy = 3-system blast radius — verify the `canManageFloor` predicate before deploy.** Destructive SQL prompts (none expected here — all additive).

---

## Phase A — Database migrations (additive, RLS-on)

### Task A1: Channel master v2 columns

**Files:** migration `snorkel_channel_master_v2` (MCP `apply_migration`).

- [ ] **Step 1: Verify current columns**

Run via `execute_sql`:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='store' AND table_name='sales_channels' ORDER BY ordinal_position;
```
Expected: `id, channel_key, label, dispatch_channel_id, is_active, sort_order, created_at, updated_at` (no channel_type/collection_*).

- [ ] **Step 2: Apply migration**

```sql
ALTER TABLE store.sales_channels
  ADD COLUMN IF NOT EXISTS channel_type           text,
  ADD COLUMN IF NOT EXISTS collection_type         text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS collection_period_days  integer,
  ADD COLUMN IF NOT EXISTS feeds_odo_sellout       boolean NOT NULL DEFAULT false;

ALTER TABLE store.sales_channels
  ADD CONSTRAINT sales_channels_collection_type_chk
  CHECK (collection_type IN ('auto','manual')) NOT VALID;

COMMENT ON COLUMN store.sales_channels.feeds_odo_sellout IS
  'true only for channels whose Snorkel order IS our sell-out signal (GT/MT). Bulk/QC = false (primary/sell-in only) → excluded from Odo.';
```

- [ ] **Step 3: Verify** — re-run Step 1 query; confirm the four columns exist.

- [ ] **Step 4: Commit** — migrations are applied directly; record in the migration note. No repo file.

### Task A2: Sales-order fulfilment column

**Files:** migration `snorkel_sales_order_fulfilment_v1`.

- [ ] **Step 1: Apply**

```sql
ALTER TABLE store.sales_orders
  ADD COLUMN IF NOT EXISTS destination_warehouse text;
COMMENT ON COLUMN store.sales_orders.destination_warehouse IS
  'Free-text QC fulfilment-centre identifier; shown on request + shipment title.';
```

- [ ] **Step 2: Verify**
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='store' AND table_name='sales_orders' AND column_name='destination_warehouse';
```
Expected: one row.

### Task A3: Fulfilment-request tables + sequence

**Files:** migration `depot_fulfilment_requests_v1`.

- [ ] **Step 1: Apply** (sequence, two tables, RLS, grants, shipment FK column)

```sql
-- FR-NNNN sequence (mirrors dso_seq pattern)
CREATE SEQUENCE IF NOT EXISTS public.fr_seq START 1;

CREATE TABLE IF NOT EXISTS public.dispatch_fulfilment_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no            text NOT NULL UNIQUE DEFAULT ('FR-' || lpad(nextval('public.fr_seq')::text, 4, '0')),
  sales_order_id        uuid NOT NULL,
  sales_order_no        text NOT NULL,
  channel_id            uuid REFERENCES public.dispatch_channels(id),
  destination_warehouse text,
  partner_po_ref        text,
  partner_name          text,
  title                 text NOT NULL,
  requested_units       integer NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','accepted','rejected','cancelled')),
  fulfilment_mode       text CHECK (fulfilment_mode IN ('full','split')),
  accepted_by uuid, accepted_at timestamptz,
  rejected_by uuid, rejected_at timestamptz, reject_reason text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dfr_sales_order_idx ON public.dispatch_fulfilment_requests(sales_order_id);
CREATE INDEX IF NOT EXISTS dfr_status_idx       ON public.dispatch_fulfilment_requests(status);

CREATE TABLE IF NOT EXISTS public.dispatch_fulfilment_request_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES public.dispatch_fulfilment_requests(id) ON DELETE CASCADE,
  product     text NOT NULL,
  model       text, color text, sku text,
  qty         integer NOT NULL DEFAULT 0,
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS dfrl_request_idx ON public.dispatch_fulfilment_request_lines(request_id);

ALTER TABLE public.dispatch_shipments
  ADD COLUMN IF NOT EXISTS fulfilment_request_id uuid REFERENCES public.dispatch_fulfilment_requests(id);
CREATE INDEX IF NOT EXISTS ds_fulfilment_request_idx ON public.dispatch_shipments(fulfilment_request_id);

-- RLS-on, service_role-only (RULE-RLS-001)
ALTER TABLE public.dispatch_fulfilment_requests       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_fulfilment_request_lines  ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.dispatch_fulfilment_requests      TO service_role;
GRANT ALL ON public.dispatch_fulfilment_request_lines TO service_role;
```

- [ ] **Step 2: Verify advisor + tables**

`get_advisors` (security) → expect **no new** `rls_disabled_in_public`. Then:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name LIKE 'dispatch_fulfilment%';
```
Expected: both tables.

- [ ] **Step 3: Mint-test the sequence**
```sql
SELECT ('FR-' || lpad(nextval('public.fr_seq')::text,4,'0')) AS sample; -- then setval back
SELECT setval('public.fr_seq', 1, false);
```
Expected: `FR-0001`.

### Task A4: Shipment tracking columns

**Files:** migration `dispatch_shipment_tracking_v1`.

- [ ] **Step 1: Apply**
```sql
ALTER TABLE public.dispatch_shipments
  ADD COLUMN IF NOT EXISTS expected_delivery_date date,
  ADD COLUMN IF NOT EXISTS courier_partner        text,
  ADD COLUMN IF NOT EXISTS tracking_number        text,
  ADD COLUMN IF NOT EXISTS tracking_link          text;
```
(`shipped_at` = dispatch date, `delivery_date` = actual delivery already exist.)

- [ ] **Step 2: Verify**
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='dispatch_shipments'
  AND column_name IN ('expected_delivery_date','courier_partner','tracking_number','tracking_link');
```
Expected: four rows.

---

## Phase B — Channel master + seeding + Odo guard

### Task B1: snorkelops channel handlers accept new fields

**Files:** Modify `05_Throttle/snorkelops-worker/src/index.js` — `createSalesChannel` (~1836) and `updateSalesChannel` (~1849).

- [ ] **Step 1: Extend `createSalesChannel` insert** — add to the inserted object:

```js
channel_type:          d.channel_type || null,
collection_type:       (d.collection_type === 'manual' ? 'manual' : 'auto'),
collection_period_days: d.collection_period_days != null ? Math.round(Number(d.collection_period_days)) : null,
feeds_odo_sellout:     !!d.feeds_odo_sellout,
```

- [ ] **Step 2: Extend `updateSalesChannel`** — add to the `updates` builder:

```js
if (d.channel_type !== undefined)           updates.channel_type = d.channel_type || null;
if (d.collection_type !== undefined)        updates.collection_type = (d.collection_type === 'manual' ? 'manual' : 'auto');
if (d.collection_period_days !== undefined) updates.collection_period_days = d.collection_period_days === null ? null : Math.round(Number(d.collection_period_days));
if (d.feeds_odo_sellout !== undefined)      updates.feeds_odo_sellout = !!d.feeds_odo_sellout;
```

- [ ] **Step 3: Commit** (deploy happens in Phase H with the rest of snorkelops):
```bash
git -C 05_Throttle add snorkelops-worker/src/index.js
git -C 05_Throttle commit -m "snorkel: channel master accepts type/collection/odo-sellout fields"
```

### Task B2: Seed sales_channels rows (mapping to existing dispatch_channels)

**Files:** `execute_sql` (data seed — confirm exact channel set + periods with Afshaan first).

- [ ] **Step 1: Update GT/MT config**
```sql
UPDATE store.sales_channels SET channel_type='general_trade', collection_type='manual', feeds_odo_sellout=true WHERE channel_key='GT';
UPDATE store.sales_channels SET channel_type='modern_trade',  collection_type='manual', feeds_odo_sellout=true WHERE channel_key='MT';
```
*(MT collection_type to be confirmed — default manual.)*

- [ ] **Step 2: Insert bulk channels** (ids verified 2026-06-22; confirm the set + `collection_period_days` per platform with Afshaan):
```sql
INSERT INTO store.sales_channels (channel_key,label,dispatch_channel_id,channel_type,collection_type,collection_period_days,feeds_odo_sellout,is_active,sort_order)
VALUES
 ('BLINKIT','Blinkit','1f21c292-b596-4120-9f16-5a57cf7fd539','quick_commerce','auto',30,false,true,10),
 ('ZEPTO','Zepto','c722d174-d4da-4155-84bd-aed1fc4306fd','quick_commerce','auto',30,false,true,11),
 ('INSTAMART','Instamart','a083042a-dbb5-4f92-81ee-1497d3e41794','quick_commerce','auto',30,false,true,12),
 ('FIRSTCRY','Firstcry','b6975c7c-a656-46a4-bf26-37f86a28bfe7','quick_commerce','auto',30,false,true,13),
 ('CRED','Cred','09da9d5b-a817-456a-8310-eb06d8bd8e07','quick_commerce','auto',30,false,true,14),
 ('PEEKO','Peeko','cd3614b6-89eb-4a95-b0e4-7f009c288b7a','quick_commerce','auto',30,false,true,15),
 ('FLIPKART_MGD','Flipkart Managed','b157d0f6-b090-402c-bad7-5dfe8e1bba43','marketplace','auto',30,false,true,20),
 ('AMAZON_FBA','Amazon - FBA','855de0ca-9498-4d5a-90f3-3a370a228762','marketplace','auto',30,false,true,21)
ON CONFLICT (channel_key) DO NOTHING;
```

- [ ] **Step 2b: HOLD for Afshaan** — confirm the exact bulk-channel set, per-channel `collection_period_days` (15–40), and MT collection_type before running Step 1/2. Adjust the VALUES accordingly. (Do not invent periods.)

- [ ] **Step 3: Verify**
```sql
SELECT channel_key, channel_type, collection_type, collection_period_days, feeds_odo_sellout, dispatch_channel_id
FROM store.sales_channels ORDER BY sort_order;
```
Expected: GT/MT `feeds_odo_sellout=true`; all bulk channels `false` with their period set + correct dispatch_channel_id.

### Task B3: Odo sell-out guard

**Files:** Modify `05_Throttle/odoops-worker/src/index.js` — the snorkel adapter that reads `store.sales_orders`.

- [ ] **Step 1: Locate the snorkel read** — `grep -n "sales_orders\|snorkel" 05_Throttle/odoops-worker/src/index.js`. Find where confirmed GT/MT orders are staged.

- [ ] **Step 2: Filter to sell-out channels** — before staging, load the sell-out channel keys and restrict:
```js
// only channels flagged feeds_odo_sellout=true are sell-out (GT/MT); QC/marketplace are sell-in
const chR = await query('sales_channels', '?feeds_odo_sellout=eq.true&select=channel_key');
const sellOutKeys = new Set((chR.ok ? chR.data : []).map(c => c.channel_key));
// ...then filter staged orders: orders.filter(o => sellOutKeys.has(o.channel_key))
```
(Match the existing adapter's query helper names; if it already hardcodes GT/MT, replace that with this flag-driven set.)

- [ ] **Step 3: Verify (data-path)** — after deploy (Phase H), create + confirm a test QC order, run the odoops snorkel sync, and confirm via `execute_sql` that `sales.stg_snorkel` / `sales_fact` did **not** gain a row for the QC channel; a GT order still does.

- [ ] **Step 4: Commit**
```bash
git -C 05_Throttle add odoops-worker/src/index.js
git -C 05_Throttle commit -m "odo: sell-out staging filters to feeds_odo_sellout channels (exclude QC sell-in)"
```

---

## Phase C — snorkelops: confirm → request, derived status, reject reconcile

### Task C1: Add fulfilment helpers (derive + reconcile)

**Files:** Modify `05_Throttle/snorkelops-worker/src/index.js` — add near `decorateSalesOrder`/`fetchShipmentMap` (top helpers region).

- [ ] **Step 1: Add `deriveFulfilment(request, shipments)`**

```js
// Derived, read-only fulfilment status for a sales order (RULE-SNORKEL-004 #4 extended).
// request: the dispatch_fulfilment_requests row (or null); shipments: its child dispatch_shipments[]
function deriveFulfilment(request, shipments) {
  if (!request) return { fulfilment_status: 'not_submitted', shipped_units: 0 };
  if (request.status === 'rejected')  return { fulfilment_status: 'rejected', shipped_units: 0 };
  if (request.status === 'cancelled') return { fulfilment_status: 'cancelled', shipped_units: 0 };
  if (request.status === 'pending')   return { fulfilment_status: 'awaiting_acceptance', shipped_units: 0 };
  // accepted: sum shipped target_qty across non-cancelled children
  const live = (shipments || []).filter(s => s.status !== 'cancelled');
  const open = live.filter(s => s.status !== 'shipped');
  const shipped_units = live.filter(s => s.status === 'shipped')
    .reduce((sum, s) => sum + (s._shipped_units || 0), 0);
  if (open.length) return { fulfilment_status: 'in_fulfilment', shipped_units };
  const req = Math.round(Number(request.requested_units)) || 0;
  if (shipped_units === 0) return { fulfilment_status: 'not_fulfilled', shipped_units };
  return { fulfilment_status: shipped_units >= req ? 'fully_fulfilled' : 'partially_fulfilled', shipped_units };
}
```

- [ ] **Step 2: Add `loadFulfilment(orderIds[])`** — batched (IN-filter, no per-row awaits):

```js
// Returns { [sales_order_id]: { request, shipments:[{...,_shipped_units}] } }
async function loadFulfilment(orderIds) {
  if (!orderIds.length) return {};
  const inList = orderIds.map(encodeURIComponent).join(',');
  const reqR = await queryPublic('dispatch_fulfilment_requests',
    `?sales_order_id=in.(${inList})&select=*`);
  const requests = reqR.ok ? reqR.data : [];
  const reqIds = requests.map(r => r.id);
  let shipments = [];
  if (reqIds.length) {
    const shR = await queryPublic('dispatch_shipments',
      `?fulfilment_request_id=in.(${reqIds.map(encodeURIComponent).join(',')})&select=id,shipment_no,status,shipped_at,delivery_date,expected_delivery_date,courier_partner,tracking_number,tracking_link,fulfilment_request_id`);
    shipments = shR.ok ? shR.data : [];
    // attach shipped units per shipment from its lines (batched)
    const shIds = shipments.map(s => s.id);
    if (shIds.length) {
      const lnR = await queryPublic('dispatch_shipment_lines',
        `?shipment_id=in.(${shIds.map(encodeURIComponent).join(',')})&select=shipment_id,target_qty`);
      const byShip = {};
      (lnR.ok ? lnR.data : []).forEach(l => { byShip[l.shipment_id] = (byShip[l.shipment_id]||0) + (Math.round(Number(l.target_qty))||0); });
      shipments.forEach(s => { s._shipped_units = byShip[s.id] || 0; });
    }
  }
  const out = {};
  requests.forEach(r => { out[r.sales_order_id] = { request: r,
    shipments: shipments.filter(s => s.fulfilment_request_id === r.id) }; });
  return out;
}
```

- [ ] **Step 3: Commit**
```bash
git -C 05_Throttle add snorkelops-worker/src/index.js
git -C 05_Throttle commit -m "snorkel: fulfilment derive + batched loader helpers"
```

### Task C2: Rewrite `confirmOrder` to raise a request (not a shipment)

**Files:** Modify `05_Throttle/snorkelops-worker/src/index.js` — `confirmOrder` (~1948).

- [ ] **Step 1: Replace the shipment-creation block** (lines ~1963–1989) with a request + request-lines insert + credit-days resolution:

```js
// resolve dispatch channel + channel config
const chR = await query('sales_channels',
  `?channel_key=eq.${encodeURIComponent(o.channel_key || '')}&select=dispatch_channel_id,collection_type,collection_period_days&limit=1`);
const ch = chR.ok ? chR.data?.[0] : null;
const dispatchChannelId = ch?.dispatch_channel_id || null;
if (!dispatchChannelId) return err('No dispatch channel mapped for this sales channel — set it in Sales → Settings', 422);
const partnerName = o.sales_partners?.name || '';
const requested_units = lines.reduce((s, l) => s + (Math.round(Number(l.qty)) || 0), 0);
const title = [partnerName, o.destination_warehouse, o.order_no].filter(Boolean).join(' · ');

// one-time request insert into public (Depot owns lifecycle thereafter)
const frRes = await sbPublic('/rest/v1/dispatch_fulfilment_requests', {
  method: 'POST', prefer: 'return=representation',
  body: JSON.stringify({
    sales_order_id: o.id, sales_order_no: o.order_no, channel_id: dispatchChannelId,
    destination_warehouse: o.destination_warehouse || null, partner_po_ref: o.partner_po_ref || null,
    partner_name: partnerName, title, requested_units, status: 'pending',
  }),
});
if (!frRes.ok || !frRes.data?.[0]) return err('Fulfilment request create failed: ' + JSON.stringify(frRes.data), 502);
const requestId = frRes.data[0].id;
const frLines = lines.map((l, i) => ({
  request_id: requestId, product: l.product, model: l.model || null, color: l.color || null,
  sku: l.sku || null, qty: Math.round(Number(l.qty)) || 0, sort_order: l.sort_order ?? i,
}));
const frlRes = await sbPublic('/rest/v1/dispatch_fulfilment_request_lines', {
  method: 'POST', body: JSON.stringify(frLines), headers: { Prefer: 'return=minimal' },
});
if (!frlRes.ok) return err('Request lines failed: ' + JSON.stringify(frlRes.data), 502);

// credit_days: channel auto-period wins, else keep the order's existing credit_days (partner default)
const updates = { status: 'confirmed', confirmed_by: userId, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() };
if (ch?.collection_type === 'auto' && ch.collection_period_days != null)
  updates.credit_days = Math.round(Number(ch.collection_period_days));
await update('sales_orders', updates, `id=eq.${encodeURIComponent(d.id)}`);
return ok({ confirmed: d.id, request_no: frRes.data[0].request_no });
```

- [ ] **Step 2: Note** — `dispatch_shipment_id` is no longer stamped on confirm (legacy column left null on new orders). Leave the column in place.

- [ ] **Step 3: Verify (deferred to Phase H smoke)** — create+confirm a draft order → expect a `dispatch_fulfilment_requests` row `pending` + request lines, and **no** `dispatch_shipments` row yet.

- [ ] **Step 4: Commit**
```bash
git -C 05_Throttle add snorkelops-worker/src/index.js
git -C 05_Throttle commit -m "snorkel: confirmOrder raises a fulfilment request (was: auto-create shipment)"
```

### Task C3: Reads return derived fulfilment + reconcile reject→cancel

**Files:** Modify `05_Throttle/snorkelops-worker/src/index.js` — `getSalesOrders` (~910), `getSalesOrder` (~931), `getSalesCollections` (~955).

- [ ] **Step 1: `getSalesOrders`** — after loading `orders`, batch-load fulfilment and reconcile + decorate:

```js
const ful = await loadFulfilment(orders.map(o => o.id));
const toCancel = [];
const rows = orders.map(o => {
  const f = ful[o.id]; const der = deriveFulfilment(f?.request, f?.shipments);
  if (der.fulfilment_status === 'rejected' && o.status !== 'cancelled') toCancel.push({ o, reason: f.request.reject_reason });
  const dec = decorateSalesOrder(o, null); // shipment-based due now uses fulfilment (Step 4 helper)
  return { ...dec, ...der, partner_name: o.sales_partners?.name || null,
           partner_state: o.sales_partners?.state || null, sales_partners: undefined };
});
await reconcileRejections(toCancel);   // Step 3 helper
return ok(rows);
```

- [ ] **Step 2: `getSalesOrder`** — replace the single-shipment fetch (lines ~944–951) with the request + children:

```js
const f = (await loadFulfilment([id]))[id];
const der = deriveFulfilment(f?.request, f?.shipments);
if (der.fulfilment_status === 'rejected' && o.status !== 'cancelled')
  await reconcileRejections([{ o, reason: f.request.reject_reason }]);
const dec = decorateSalesOrder({ ...o, sales_partners: undefined }, null);
return ok({ ...dec, ...der, partner, request: f?.request || null, shipments: f?.shipments || [],
  lines: linesR.ok ? linesR.data : [], payments: paysR.ok ? paysR.data : [] });
```

- [ ] **Step 3: Add `reconcileRejections(list)` helper** (batched cancel write, snorkelops-owned):

```js
async function reconcileRejections(list) {
  for (const { o, reason } of list) {   // small N (rejected orders on a page); each a single PATCH
    const now = new Date().toISOString();
    await update('sales_orders',
      { status: 'cancelled', cancelled_at: now, cancel_reason: 'Fulfilment rejected: ' + (reason || ''), updated_at: now },
      `id=eq.${encodeURIComponent(o.id)}`);
  }
}
```

- [ ] **Step 4: Update `decorateSalesOrder` due-date source** — it currently takes a single shipment; change its due anchor to use the **latest shipped child's delivery_date, else dispatch date (shipped_at)**. Add a `fulfilmentAnchorDate(shipments)` helper and pass `ful[o.id]?.shipments` in; `due_date = anchor + credit_days`. Keep `balance`/`overdue` math unchanged.

```js
function fulfilmentAnchorDate(shipments) {
  const shipped = (shipments || []).filter(s => s.status === 'shipped');
  if (!shipped.length) return null;
  const dates = shipped.map(s => s.delivery_date || (s.shipped_at ? String(s.shipped_at).slice(0,10) : null)).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;   // latest
}
```
Wire `decorateSalesOrder(o, anchorDate)` to take the anchor date directly (refactor its current `shipment` param). Update all three call sites to pass `fulfilmentAnchorDate(ful[o.id]?.shipments)`.

- [ ] **Step 5: `getSalesCollections`** — same pattern: `loadFulfilment` for the confirmed+invoiced orders, decorate with the anchor, reconcile rejects, keep the `balance>0` filter + overdue sort.

- [ ] **Step 6: Commit**
```bash
git -C 05_Throttle add snorkelops-worker/src/index.js
git -C 05_Throttle commit -m "snorkel: sales reads return derived fulfilment + tracking; due-date anchored to latest shipped child; reject→cancel reconcile"
```

---

## Phase D — lotopsproxy (Depot): request reads + fulfilment actions

### Task D1: Register new actions + GET reads

**Files:** Modify `01_worker/worker.js` — the GET action block (near `getDispatchShipments` ~4124) and the POST action allow-list (~5340).

- [ ] **Step 1: Add to the POST action allow-list** (the array near line 5340-5344): `'getFulfilmentRequests','getFulfilmentRequest','acceptFulfilmentFull','acceptFulfilmentSplit','rejectFulfilment','cancelShipments','updateShipmentSchedule','updateShipmentTracking'`. (`markShipmentShipped` already exists.)

- [ ] **Step 2: Add GET `getFulfilmentRequests`** (queue + history). Mirror the `getDispatchShipments` GET shape:

```js
case 'getFulfilmentRequests': {
  const status = url.searchParams.get('status'); // 'pending' for the queue
  let q = '?select=*&order=created_at.desc';
  if (status) q += `&status=eq.${encodeURIComponent(status)}`;
  const r = await queryPublic('dispatch_fulfilment_requests', q);
  if (!r.ok) return jsonErr(r.data);
  return jsonOk(r.data);
}
```

- [ ] **Step 3: Add GET `getFulfilmentRequest`** (detail = request + lines + child shipments):

```js
case 'getFulfilmentRequest': {
  const id = url.searchParams.get('id');
  if (!id) return jsonErr('id required');
  const [rq, ln, sh] = await Promise.all([
    queryPublic('dispatch_fulfilment_requests', `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`),
    queryPublic('dispatch_fulfilment_request_lines', `?request_id=eq.${encodeURIComponent(id)}&order=sort_order.asc`),
    queryPublic('dispatch_shipments', `?fulfilment_request_id=eq.${encodeURIComponent(id)}&select=*&order=scheduled_date.asc,created_at.asc`),
  ]);
  if (!rq.ok || !rq.data?.[0]) return jsonErr('Request not found', 404);
  return jsonOk({ request: rq.data[0], lines: ln.ok ? ln.data : [], shipments: sh.ok ? sh.data : [] });
}
```
*(Use the worker's actual GET-response helpers — confirm whether reads gate on a permission or are open like other dispatch reads; match the surrounding `getDispatchShipments` handler.)*

- [ ] **Step 4: Commit** (deploy in Phase H).
```bash
git -C 01_worker add worker.js
git -C 01_worker commit -m "lotopsproxy: fulfilment request reads (queue + detail)"
```

### Task D2: Accept-Full

**Files:** `01_worker/worker.js` — POST switch (alongside the other dispatch POSTs, e.g. near `updateShipment` ~7183).

- [ ] **Step 1: Implement** — `canManageFloor` guard first (RULE-011); create one shipment for the full requested qty:

```js
if (body.action === 'acceptFulfilmentFull') {
  if (!canManageFloor(P)) return jsonErr('No permission', 403);
  const { request_id } = body;
  const rq = await queryPublic('dispatch_fulfilment_requests', `?id=eq.${encodeURIComponent(request_id)}&select=*&limit=1`);
  const R = rq.ok ? rq.data?.[0] : null;
  if (!R) return jsonErr('Request not found', 404);
  if (R.status !== 'pending') return jsonErr('Request is not pending', 422);
  const lnR = await queryPublic('dispatch_fulfilment_request_lines', `?request_id=eq.${encodeURIComponent(request_id)}&order=sort_order.asc`);
  const reqLines = lnR.ok ? lnR.data : [];
  const shRes = await sbPublic('/rest/v1/dispatch_shipments', { method:'POST', prefer:'return=representation',
    body: JSON.stringify({ channel_id: R.channel_id, fulfilment_request_id: R.id,
      sales_order_id: R.sales_order_id, sales_order_no: R.sales_order_no,
      destination_warehouse: R.destination_warehouse,
      title: `${R.title} · FULL`, scheduled_date: todayISO(),
      expected_units: R.requested_units, created_by: userId }) });
  if (!shRes.ok || !shRes.data?.[0]) return jsonErr('Shipment create failed: '+JSON.stringify(shRes.data), 502);
  const sid = shRes.data[0].id;
  const sl = reqLines.map(l => ({ shipment_id: sid, product: l.product, model: l.model, color: l.color, target_qty: Math.round(Number(l.qty))||0, packed_qty: 0 }));
  await sbPublic('/rest/v1/dispatch_shipment_lines', { method:'POST', body: JSON.stringify(sl), headers:{ Prefer:'return=minimal' } });
  await sbPublic(`/rest/v1/dispatch_fulfilment_requests?id=eq.${encodeURIComponent(R.id)}`,
    { method:'PATCH', headers:{ Prefer:'return=minimal' },
      body: JSON.stringify({ status:'accepted', fulfilment_mode:'full', accepted_by:userId, accepted_at:new Date().toISOString() }) });
  return jsonOk({ shipment_id: sid, shipment_no: shRes.data[0].shipment_no });
}
```

- [ ] **Step 2: Commit** — `"lotopsproxy: acceptFulfilmentFull → one full shipment"`.

### Task D3: Accept-Split

**Files:** `01_worker/worker.js` — POST switch.

- [ ] **Step 1: Implement** — body `splits: [{ scheduled_date, lines:[{product,model,color,qty}] }]`; create N shipments (batched line inserts per shipment):

```js
if (body.action === 'acceptFulfilmentSplit') {
  if (!canManageFloor(P)) return jsonErr('No permission', 403);
  const { request_id, splits } = body;
  if (!Array.isArray(splits) || !splits.length) return jsonErr('splits required');
  const rq = await queryPublic('dispatch_fulfilment_requests', `?id=eq.${encodeURIComponent(request_id)}&select=*&limit=1`);
  const R = rq.ok ? rq.data?.[0] : null;
  if (!R) return jsonErr('Request not found', 404);
  if (R.status !== 'pending') return jsonErr('Request is not pending', 422);
  const created = [];
  for (let i = 0; i < splits.length; i++) {                 // N small (operator-defined); each = 1 shipment insert + 1 batched lines insert
    const s = splits[i];
    const units = (s.lines||[]).reduce((sum,l)=>sum+(Math.round(Number(l.qty))||0),0);
    const shRes = await sbPublic('/rest/v1/dispatch_shipments', { method:'POST', prefer:'return=representation',
      body: JSON.stringify({ channel_id:R.channel_id, fulfilment_request_id:R.id, sales_order_id:R.sales_order_id,
        sales_order_no:R.sales_order_no, destination_warehouse:R.destination_warehouse,
        title:`${R.title} · ${i+1}/${splits.length}`, scheduled_date: s.scheduled_date || todayISO(),
        expected_units: units, created_by:userId }) });
    if (!shRes.ok || !shRes.data?.[0]) return jsonErr('Split shipment failed: '+JSON.stringify(shRes.data), 502);
    const sid = shRes.data[0].id;
    const sl = (s.lines||[]).map(l => ({ shipment_id:sid, product:l.product, model:l.model||null, color:l.color||null, target_qty:Math.round(Number(l.qty))||0, packed_qty:0 }));
    if (sl.length) await sbPublic('/rest/v1/dispatch_shipment_lines', { method:'POST', body:JSON.stringify(sl), headers:{ Prefer:'return=minimal' } });
    created.push({ shipment_id: sid, shipment_no: shRes.data[0].shipment_no });
  }
  await sbPublic(`/rest/v1/dispatch_fulfilment_requests?id=eq.${encodeURIComponent(R.id)}`,
    { method:'PATCH', headers:{ Prefer:'return=minimal' },
      body: JSON.stringify({ status:'accepted', fulfilment_mode:'split', accepted_by:userId, accepted_at:new Date().toISOString() }) });
  return jsonOk({ shipments: created });
}
```
*(Cap: if `splits.length` could be large, document that >40 splits would risk the 50-subreq limit; realistic split counts are small. Note in code comment.)*

- [ ] **Step 2: Commit** — `"lotopsproxy: acceptFulfilmentSplit → N child shipments"`.

### Task D4: Reject, cancel shipments, schedule/qty override, tracking

**Files:** `01_worker/worker.js` — POST switch.

- [ ] **Step 1: `rejectFulfilment`** (`canManageFloor`; reason required):
```js
if (body.action === 'rejectFulfilment') {
  if (!canManageFloor(P)) return jsonErr('No permission', 403);
  const { request_id, reason } = body;
  if (!reason) return jsonErr('reason required');
  const rq = await queryPublic('dispatch_fulfilment_requests', `?id=eq.${encodeURIComponent(request_id)}&select=status&limit=1`);
  if (!rq.ok || !rq.data?.[0]) return jsonErr('Request not found', 404);
  if (rq.data[0].status !== 'pending') return jsonErr('Only pending requests can be rejected', 422);
  await sbPublic(`/rest/v1/dispatch_fulfilment_requests?id=eq.${encodeURIComponent(request_id)}`,
    { method:'PATCH', headers:{ Prefer:'return=minimal' },
      body: JSON.stringify({ status:'rejected', rejected_by:userId, rejected_at:new Date().toISOString(), reject_reason:reason }) });
  return jsonOk({ rejected: request_id }); // Snorkel reconciles the SO → cancelled on read
}
```

- [ ] **Step 2: `cancelShipments`** (ids[]; only non-shipped):
```js
if (body.action === 'cancelShipments') {
  if (!canManageFloor(P)) return jsonErr('No permission', 403);
  const ids = (body.shipment_ids || []).filter(Boolean);
  if (!ids.length) return jsonErr('shipment_ids required');
  const inList = ids.map(encodeURIComponent).join(',');
  const cur = await queryPublic('dispatch_shipments', `?id=in.(${inList})&select=id,status`);
  const shippable = (cur.ok ? cur.data : []).filter(s => s.status !== 'shipped').map(s => s.id);
  if (!shippable.length) return jsonErr('No cancellable shipments (already shipped?)', 422);
  await sbPublic(`/rest/v1/dispatch_shipments?id=in.(${shippable.map(encodeURIComponent).join(',')})`,
    { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify({ status:'cancelled' }) });
  return jsonOk({ cancelled: shippable });
}
```

- [ ] **Step 3: `updateShipmentSchedule`** (overwrite scheduled units on a full shipment + scheduled_date). Replace the shipment's lines `target_qty` from a `lines:[{id|product/model/color, qty}]` payload (atomic delete+reinsert mirroring existing `updateShipmentLines` at ~7689), plus optional `scheduled_date`. Reuse the existing `updateShipmentLines` handler if its shape fits; otherwise add a thin handler that PATCHes `scheduled_date` and updates line `target_qty` by id.

- [ ] **Step 4: `updateShipmentTracking`** (courier/number/link/expected_delivery; also allows actual `delivery_date`):
```js
if (body.action === 'updateShipmentTracking') {
  if (!canManageFloor(P)) return jsonErr('No permission', 403);
  const { shipment_id } = body;
  if (!shipment_id) return jsonErr('shipment_id required');
  const u = {};
  ['courier_partner','tracking_number','tracking_link'].forEach(f => { if (body[f] !== undefined) u[f] = body[f] || null; });
  if (body.expected_delivery_date !== undefined) u.expected_delivery_date = body.expected_delivery_date || null;
  if (body.delivery_date !== undefined)          u.delivery_date = body.delivery_date || null;
  if (!Object.keys(u).length) return jsonErr('nothing to update');
  await sbPublic(`/rest/v1/dispatch_shipments?id=eq.${encodeURIComponent(shipment_id)}`,
    { method:'PATCH', headers:{ Prefer:'return=minimal' }, body: JSON.stringify(u) });
  return jsonOk({ updated: shipment_id });
}
```

- [ ] **Step 5: Verify `markShipmentShipped`** already stamps `shipped_at` (= dispatch date). Confirm via grep; reuse as-is.

- [ ] **Step 6: Commit** — `"lotopsproxy: reject / cancel-shipments / schedule-override / tracking actions"`.

---

## Phase E — Depot UI (`apps/depot`)

> Follow the Depot kit (`src/components` Panel/Kpi/ToneBadge/Icon; `@throttle/db` `garageFetch`/`workerFetch`; `@throttle/auth` `useAuth`). Build green: `npx turbo build --filter=@throttle/depot`.

### Task E1: Overview tile for open requests

**Files:** Modify `apps/depot/src/app/(auth)/dashboard/page.js`; nav `apps/depot/src/lib/nav.js`.

- [ ] **Step 1:** Add a hero/top stat tile **"Open fulfilment requests"** = `garageFetch('getFulfilmentRequests', { status:'pending' })`.length, placed in the dashboard's top stat row (next to the existing pipeline stat cards). Make the whole tile a link/onClick → `router.push('/fulfilment-requests')`. Use the same `Kpi`/stat-card component the other hero tiles use; give it an attention tone when count > 0.
- [ ] **Step 2:** Auto-refresh with the existing 30s live-count interval on the dashboard.
- [ ] **Step 3: Build** `npx turbo build --filter=@throttle/depot` → green. **Commit.**

### Task E2: Fulfilment Requests screen

**Files:** Create `apps/depot/src/app/(auth)/fulfilment-requests/page.js` (+ a `detail` view — either `/fulfilment-requests/[id]` or an inline drawer, matching Depot's existing pattern). Add nav entry under **Outbound** in `nav.js` (id `fulfilment-requests`, label "Fulfilment Requests", icon `ClipboardList`, route `/fulfilment-requests`).

- [ ] **Step 1: List** — `getFulfilmentRequests` (default all; tab/filter Pending vs History). Columns: request_no, SO no, channel, warehouse, partner PO ref, requested units, status badge, created. Pending rows open the detail/accept UI.
- [ ] **Step 2: Detail** — `getFulfilmentRequest` → show request + lines + child shipments. Actions for a `pending` request:
  - **Accept — Full** (single click) → `workerFetch('acceptFulfilmentFull', { request_id })` → toast + go to Shipments.
  - **Accept — Split** → a split builder: rows of `{ scheduled_date, per-line qty }` (default: prefill one row with full qty; "+ Add shipment" adds a row; per-row line-qty inputs). Submit → `workerFetch('acceptFulfilmentSplit', { request_id, splits })`.
  - **Reject** → reason modal → `workerFetch('rejectFulfilment', { request_id, reason })`.
- [ ] **Step 3:** For an `accepted` request show its child shipments (status + qty) read-only with a link to the Shipments screen.
- [ ] **Step 4: Build green. Commit.**

### Task E3: Shipments screen — tracking, cancel, qty override

**Files:** Modify `apps/depot/src/app/(auth)/dispatch-shipments/page.js`.

- [ ] **Step 1:** Show the new tracking fields per shipment (courier, tracking #, link, expected delivery, actual delivery, dispatch date) and the `fulfilment_request_id`/SO link + title (which already carries channel · warehouse · SO).
- [ ] **Step 2:** Add an **edit-tracking** control → `workerFetch('updateShipmentTracking', { shipment_id, courier_partner, tracking_number, tracking_link, expected_delivery_date, delivery_date })`.
- [ ] **Step 3:** Add **Cancel shipment(s)** (single + multi-select for split groups) → `workerFetch('cancelShipments', { shipment_ids })` (blocked server-side once shipped).
- [ ] **Step 4:** On a **full** shipment, add **edit scheduled units** → `workerFetch('updateShipmentSchedule', { shipment_id, lines, scheduled_date })`.
- [ ] **Step 5:** Keep the existing **Mark Shipped** path (`markShipmentShipped`) — stamps dispatch date.
- [ ] **Step 6: Build green. Commit.**

---

## Phase F — Snorkel UI (`apps/snorkel`)

> Kit: `apps/snorkel/src/components` (Kpi/Panel/Badge/Btn); `src/lib/sales.js`. Build: `npx turbo build --filter=@throttle/snorkel`.

### Task F1: Order form — warehouse field

**Files:** Modify `apps/snorkel/src/app/(auth)/sales/orders/.../OrderForm.js` (shared new+edit); `src/lib/sales.js` (createSalesOrder/updateSalesOrder payloads).

- [ ] **Step 1:** Add a **Destination warehouse** free-text input (shown/relevant for QC channels; always editable). Wire it into the `createSalesOrder`/`updateSalesOrder` `data` payload as `destination_warehouse`.
- [ ] **Step 2:** Extend snorkelops `createSalesOrder`/`updateSalesOrder` to accept `destination_warehouse` (add to insert/updates — mirror the existing field handling at ~1876 and ~1904). Commit the worker change with Phase C.
- [ ] **Step 3: Build green. Commit.**

### Task F2: Channel settings — collection + sell-out config

**Files:** Modify `apps/snorkel/src/app/(auth)/sales/settings/page.js`.

- [ ] **Step 1:** Add per-channel editable fields: `channel_type` (select), `collection_type` (auto/manual), `collection_period_days` (number, shown when auto), `feeds_odo_sellout` (toggle, with helptext "counts as sell-out in Odo — on for GT/MT only"). Wire to `updateSalesChannel`/`createSalesChannel`.
- [ ] **Step 2: Build green. Commit.**

### Task F3: SO detail + list — fulfilment status & tracking panel

**Files:** Modify the Snorkel sales order detail page + list (`apps/snorkel/src/app/(auth)/sales/orders/detail/...` + `orders/page.js`).

- [ ] **Step 1: List** — show the derived `fulfilment_status` badge (from `getSalesOrders`) alongside payment status.
- [ ] **Step 2: Detail** — render a read-only **Shipments / tracking panel** from `getSalesOrder`'s new `shipments[]`: per shipment show shipment_no, status, dispatch date (`shipped_at`), expected + actual delivery, courier, tracking number + **clickable tracking link**. Show the overall fulfilment status + requested vs shipped units.
- [ ] **Step 3:** When `fulfilment_status==='rejected'`/order cancelled-by-rejection, surface the reject reason.
- [ ] **Step 4: Build green. Commit.**

### Task F4: Collections — channel-driven due

**Files:** `apps/snorkel/src/app/(auth)/sales/collections/page.js` (mostly already correct — `getSalesCollections` now returns the channel-anchored due/overdue).

- [ ] **Step 1:** Confirm the page renders `due_date`/`overdue`/`balance` from the updated read; add the channel + collection-type column so auto-collection orders are visible. **Build green. Commit.**

---

## Phase G — Manual (human-flow narrative)

### Task G1: Snorkel + Depot manual chapters

**Files:** `apps/snorkel/docs/manual/` (sales-order side) and `apps/depot/docs/manual/` (fulfilment side) — add/extend a chapter each; rebuild per CORE.md "In-app System Manuals".

- [ ] **Step 1:** Author the **simplified workflow narrative** (spec §15 text) into a Snorkel chapter "Selling & fulfilment — how a sales order flows" and a Depot chapter "Fulfilling sales orders (accept / full / split / track)". Use the existing semantic classes (`.lead/.steps/.callout`).
- [ ] **Step 2:** Rebuild both: `python3 apps/snorkel/docs/manual/build.py` + `python3 apps/depot/docs/manual/build.py` (PDFs) and `python3 scripts/build-manual-web.py snorkel depot` (in-app data). Bump each manual version.
- [ ] **Step 3:** Commit the generated `src/data/manual.json` + `public/manual/*.pdf` (CI only runs `next build`). **Build green. Commit.**

---

## Phase H — Deploy, smoke, knowledge files

### Task H1: Deploy sequence

- [ ] **Step 1:** Confirm migrations A1–A4 applied + advisor clean (`get_advisors` security).
- [ ] **Step 2:** Seed channels (Task B2) **after** Afshaan confirms the set/periods.
- [ ] **Step 3:** Deploy `snorkelops`: `git -C 05_Throttle push` then `cd 05_Throttle/snorkelops-worker && npx wrangler deploy`.
- [ ] **Step 4:** Deploy `lotopsproxy` (⚠ 3-system blast radius — re-verify `canManageFloor` is unchanged for existing dispatch handlers): `git -C 01_worker push` then `cd 01_worker && npx wrangler deploy`.
- [ ] **Step 5:** Deploy `odoops`: `cd 05_Throttle/odoops-worker && npx wrangler deploy` (after `feeds_odo_sellout` is seeded, so GT/MT never drop).
- [ ] **Step 6:** Apps auto-deploy on push to `main` (snorkel + depot gh-pages).

### Task H2: End-to-end data-path smoke (via `execute_sql` + authenticated browser)

- [ ] **Step 1 (request):** Create + confirm a QC draft order → assert one `dispatch_fulfilment_requests` row `pending` + request lines, **no** shipment.
- [ ] **Step 2 (reject→cancel):** Reject it in Depot → request `rejected`; open the order in Snorkel → SO `cancelled` with "Fulfilment rejected: …".
- [ ] **Step 3 (full):** New order → Accept-Full → one shipment `target_qty`=requested; shorten units; Mark Shipped → SO shows `partially_fulfilled` (shipped < requested) or `fully_fulfilled` (equal).
- [ ] **Step 4 (split):** New order → Accept-Split into 2 shipments w/ different `scheduled_date`; cancel one; ship the other → SO `partially_fulfilled`; cumulative≥requested → `fully_fulfilled`.
- [ ] **Step 5 (tracking + collection):** Add courier/tracking on a shipment → visible on the Snorkel SO; due_date = latest delivery/dispatch + channel period; appears in Collections.
- [ ] **Step 6 (Odo guard):** Run odoops snorkel sync → QC order NOT in `sales_fact`; a GT order is.
- [ ] **Step 7 (regression):** Confirm an **existing** already-confirmed GT order is untouched (legacy shipment intact).

### Task H3: Knowledge-file updates (workspace root repo)

- [ ] **Step 1:** `systems/snorkel.md` — rewrite the Offline Sales section for the request→accept→split flow + channel master v2 + derived fulfilment + collections; amend **RULE-SNORKEL-004** (#3 superseded). 
- [ ] **Step 2:** `systems/depot.md` — add the Fulfilment Requests screen + overview tile + shipment tracking/cancel/split; add **RULE-DEPOT-FULFIL-001** (or place in BUSINESS_RULES).
- [ ] **Step 3:** `BUSINESS_RULES.md` — amend **RULE-SALES-001** (primary vs secondary sale + `feeds_odo_sellout`); add the new fulfilment rule.
- [ ] **Step 4:** `CORE.md` — note new `public.dispatch_fulfilment_requests*` tables + `sales_channels` v2 cols + shipment tracking cols.
- [ ] **Step 5:** `BACKLOG.md` — close the "partial-dispatch/multi-invoice" sub-item; add the V2 central-courier item (Phase I).
- [ ] **Step 6:** Commit + push the root repo (`git add -A && git commit && git push`).

---

## Phase I — V2: central courier-tracking service (SEPARATE plan, gated)

> Not built in this plan. Gated on the §9a research brief (Delhivery + Shiprocket — auth, track-by-AWB, webhooks vs polling, rate limits, reverse tracking, sandbox). When the brief lands, write its own spec + plan covering: the normalized `track(courier, awb)` interface, its home (shared courier worker / edge-fn vs lotopsproxy module consumed by Depot + csops), secrets (`DELHIVERY_TOKEN`, Shiprocket creds), the poll-vs-webhook decision, and the Pitstop/returns consumer. V1 of THIS plan ships manual tracking entry only.

- [ ] **Step 1:** Receive the research brief; review with Afshaan; decide home + poll/webhook.
- [ ] **Step 2:** Write `docs/superpowers/specs/<date>-courier-tracking-service-design.md` and its plan.

---

## Self-review notes (coverage vs spec)
- §4.A channel cols → A1/B1/B2/F2 ✓ · §4.B SO warehouse + derived → A2/C2/C3/F1/F3 ✓ · §4.C request tables → A3/C2/D1 ✓ · §4.D tracking cols → A4/D4/E3/F3 ✓
- §5 flow/state machine → C2/D2/D3/D4 ✓ · §6 derived status → C1/C3 ✓ · §7 worker actions → B/C/D ✓
- §8 UI (incl. overview tile) → E1/E2/E3/F1–F4 ✓ · §9/§9a courier service → Phase I (deferred) ✓ · §10 Odo guard → B3 ✓
- §11 no-retro rollout → C2 (legacy column left)/H2 Step 7 ✓ · §12 rule changes → H3 ✓ · §15 manual → G1 ✓
- Open inputs (channel set/periods, MT collection, Delhivery contract) gated in B2 Step 2b / Phase I.
