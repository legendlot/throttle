# Snorkel Offline Sales Orders — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. Build phase-by-phase; each phase ends green (build clean / data-path smoke passes) before the next. This codebase has no unit-test harness — verification = live schema checks, `npx turbo build --filter=<app>`, and worker/SQL data-path smoke (the established Snorkel pattern).

**Goal:** A SALES module inside Snorkel for the offline channels (GT/MT) — partner master, sales-order capture with a Draft→Confirmed gate, GST tax invoicing, partial-payment collections, and a confirm-time hand-off that auto-creates a dispatch shipment in Redline (read-only fulfilment status back).

**Architecture:** All `sales_*` data in `store` (RLS-on, service_role-only); dispatch tables + product_master are in `public`. snorkelops owns sales reads/writes and inserts the dispatch shipment directly on confirm; it reads the linked `public.dispatch_shipments` row to derive fulfilment status/dates. lotopsproxy gains only `delivery_date` support on `updateShipment`; apps/redline shows the linked order + a delivery-date input.

**Tech Stack:** Cloudflare Workers (snorkelops, lotopsproxy), Next.js static-export (apps/snorkel, apps/redline), Supabase Postgres (PostgREST), `store.next_seq` sequences.

**Spec:** `docs/superpowers/specs/2026-06-03-snorkel-offline-sales-design.md`

**Live-schema facts (verified 2026-06-03):**
- Dispatch + product tables are in `public`. `public.dispatch_shipments` auto-defaults `shipment_no`(`DSO-NNNN`), `status`(`draft`), `packed_count`(0). `created_by` is uuid.
- GT channel id `95aa6676-e008-458f-b3bc-6e70d78edb1a`; MT `6deae6c3-d64b-4967-8500-ff5f74e04040` (both `public.dispatch_channels`, retail/bulk).
- `store.next_seq(seq_name)` UPDATE-only (no auto-create) over `store.sequences(name, current_val)`. Pad in JS.
- Seller/GSTIN = `store.company_addresses` `is_registered_office=true` row. `product_master(public)`: ean, sku, product, model, color, component_type, is_active — **no HSN, no price** (HSN manual per line).
- snorkelops helpers: `sb`(store)/`sbPublic`(public)/`query`/`queryPublic`/`insert`/`update`/`rpc`/`nextSeq`/`todayISO`/`ok`/`err`; gates `p=>!!p.key`; `verifyJWT`→`P=permissions`; `getMe` returns `permissions`.

---

## Phase 1 — Migration (`store` tables + `public.dispatch_shipments` cols + seqs + RLS + perms seed)

### Task 1.1: Apply migration `snorkel_offline_sales_v1`

**Files:** Supabase migration (via `apply_migration` — requires confirmation).

- [ ] **Step 1:** Apply this migration (name `snorkel_offline_sales_v1`):

```sql
-- 1. sales_channels
create table store.sales_channels (
  id uuid primary key default gen_random_uuid(),
  channel_key text unique not null,
  label text not null,
  dispatch_channel_id uuid,            -- → public.dispatch_channels.id (soft ref, cross-schema)
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. sales_partners
create table store.sales_partners (
  id uuid primary key default gen_random_uuid(),
  partner_code text unique not null,
  name text not null,
  channel_key text,
  partner_type text,
  gstin text,
  state text,
  city text,
  pincode text,
  billing_address text,
  shipping_address text,
  contact_person text,
  phone text,
  email text,
  default_credit_days int not null default 45,
  is_active boolean not null default true,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 3. sales_orders
create table store.sales_orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique not null,
  partner_id uuid not null references store.sales_partners(id),
  channel_key text,
  order_date date not null default current_date,
  status text not null default 'draft' check (status in ('draft','confirmed','cancelled')),
  credit_days int not null default 45,
  partner_po_ref text,
  expected_dispatch_date date,
  notes text,
  subtotal numeric(14,2) not null default 0,
  tax_total numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null default 0,
  dispatch_shipment_id uuid,           -- → public.dispatch_shipments.id (soft ref)
  invoice_no text,
  invoice_date date,
  invoice_generated boolean not null default false,
  place_of_supply text,
  amount_received numeric(14,2) not null default 0,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid')),
  created_by uuid,
  created_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  updated_at timestamptz not null default now()
);
create index on store.sales_orders (partner_id);
create index on store.sales_orders (status);

-- 4. sales_order_lines
create table store.sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references store.sales_orders(id) on delete cascade,
  product text,
  model text,
  color text,
  sku text,
  hsn_code text,
  description text,
  qty int not null default 0,
  rate numeric(12,2) not null default 0,
  discount_pct numeric(5,2) not null default 0,
  gst_pct numeric(5,2) not null default 0,
  taxable_value numeric(14,2) not null default 0,
  gst_amount numeric(14,2) not null default 0,
  line_total numeric(14,2) not null default 0,
  sort_order int not null default 0
);
create index on store.sales_order_lines (order_id);

-- 5. sales_payments
create table store.sales_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references store.sales_orders(id) on delete cascade,
  amount numeric(14,2) not null,
  received_date date not null default current_date,
  mode text not null default 'bank' check (mode in ('bank','upi','cheque','cash','other')),
  reference text,
  note text,
  recorded_by uuid,
  recorded_by_name text,
  created_at timestamptz not null default now()
);
create index on store.sales_payments (order_id);

-- 6. dispatch_shipments — 3 additive nullable columns (public)
alter table public.dispatch_shipments add column if not exists sales_order_id uuid;
alter table public.dispatch_shipments add column if not exists sales_order_no text;
alter table public.dispatch_shipments add column if not exists delivery_date date;

-- 7. RLS on + service_role grants (every new store table)
alter table store.sales_channels   enable row level security;
alter table store.sales_partners   enable row level security;
alter table store.sales_orders     enable row level security;
alter table store.sales_order_lines enable row level security;
alter table store.sales_payments   enable row level security;
grant all on store.sales_channels, store.sales_partners, store.sales_orders,
              store.sales_order_lines, store.sales_payments to service_role;

-- 8. Sequences (next_seq is UPDATE-only → seed rows)
insert into store.sequences(name, current_val) values ('sales_partner',0),('sales_order',0)
  on conflict (name) do nothing;

-- 9. Seed sales channels → existing public dispatch channels
insert into store.sales_channels(channel_key,label,dispatch_channel_id,sort_order) values
  ('GT','General Trade','95aa6676-e008-458f-b3bc-6e70d78edb1a',1),
  ('MT','Modern Trade','6deae6c3-d64b-4967-8500-ff5f74e04040',2)
  on conflict (channel_key) do nothing;

-- 10. New Snorkel permission keys: seed roles + grant admin
update store.snorkel_roles
  set permissions = permissions
    || '{"sales_view":true,"sales_order_manage":true,"sales_order_confirm":true,"sales_payment_manage":true,"sales_partner_manage":true}'::jsonb,
    updated_at = now()
  where role_key = 'admin';
insert into store.snorkel_roles(role_key,label,description,permissions,is_system) values
  ('sales_rep','Sales Rep','Capture and manage offline sales orders',
    '{"sales_view":true,"sales_order_manage":true}'::jsonb, false),
  ('sales_manager','Sales Manager','Full offline-sales authority incl. confirm + collections',
    '{"sales_view":true,"sales_order_manage":true,"sales_order_confirm":true,"sales_payment_manage":true,"sales_partner_manage":true}'::jsonb, false)
  on conflict (role_key) do nothing;
```

- [ ] **Step 2:** Verify — run, expect 5 `sales_*` tables, 3 new shipment cols, 2 seq rows, 2 channels, admin has sales keys:

```sql
select table_name from information_schema.tables where table_schema='store' and table_name like 'sales_%' order by 1;
select column_name from information_schema.columns where table_schema='public' and table_name='dispatch_shipments' and column_name like 'sales_%' or (table_schema='public' and table_name='dispatch_shipments' and column_name='delivery_date');
select name,current_val from store.sequences where name in ('sales_partner','sales_order');
select channel_key,dispatch_channel_id from store.sales_channels order by sort_order;
select role_key, permissions->'sales_view' from store.snorkel_roles where role_key in ('admin','sales_rep','sales_manager');
```

- [ ] **Step 3:** Advisor check — `get_advisors(type=security)` shows 0 new `rls_disabled` on the 5 tables.

---

## Phase 2 — snorkelops worker actions

All actions live in `05_Throttle/snorkelops-worker/src/index.js`. Add gates near the existing `canViewAssets` block; add GET cases in the GET switch; add POST cases in the POST switch. Mirror the asset handlers (reads ~line 680-760, writes ~line 1500-1580) for structure.

### Task 2.1: Permission gates + sales constants/helpers

**Files:** Modify `snorkelops-worker/src/index.js` (gates near line 48; helpers near `nextSeq`).

- [ ] **Step 1:** Add gates:

```js
const canSalesView    = p => !!p.sales_view || !!p.sales_order_manage || !!p.sales_order_confirm || !!p.sales_payment_manage || !!p.sales_partner_manage;
const canSalesManage  = p => !!p.sales_order_manage;   // create/edit/cancel draft + generate invoice
const canSalesConfirm = p => !!p.sales_order_confirm;  // confirm → auto-shipment
const canSalesPayment = p => !!p.sales_payment_manage; // record/edit receipts
const canSalesPartner = p => !!p.sales_partner_manage; // partner master + channels
```

- [ ] **Step 2:** Add helpers (after `nextSeq`):

```js
// Pad-4 code minter (SP-/SO-). next_seq is UPDATE-only; rows seeded in migration.
async function nextSeq4(name, prefix) {
  const r = await rpc('next_seq', { seq_name: name });
  if (!r.ok || r.data == null) throw new Error('Sequence error: ' + JSON.stringify(r.data));
  return prefix + String(r.data).padStart(4, '0');
}
// Indian FY label for invoice numbering: 2026-04..2027-03 → "26-27".
function fyLabel(dateISO) {
  const d = new Date(dateISO + 'T00:00:00Z');
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return String(start % 100).padStart(2,'0') + '-' + String((start+1) % 100).padStart(2,'0');
}
// Mint GST-continuous invoice no per FY: LOT/SL/<fy>/NNNN. Lazily creates the seq row.
async function nextInvoiceNo(dateISO) {
  const fy = fyLabel(dateISO);
  const key = 'sales_invoice_' + fy;
  await insert('sequences', [{ name: key, current_val: 0 }], false); // ON CONFLICT? PostgREST: use merge
  // sequences has no unique-violation tolerance via insert; guard with merge-duplicates:
  const r = await rpc('next_seq', { seq_name: key });
  if (!r.ok || r.data == null) throw new Error('Invoice seq error: ' + JSON.stringify(r.data));
  return `LOT/SL/${fy}/${String(r.data).padStart(4,'0')}`;
}
// Line math (PostgREST returns numerics as strings → Number()).
function computeLine(l) {
  const qty = Math.round(Number(l.qty) || 0);
  const rate = Number(l.rate) || 0;
  const disc = Number(l.discount_pct) || 0;
  const gst = Number(l.gst_pct) || 0;
  const taxable = +(qty * rate * (1 - disc/100)).toFixed(2);
  const gstAmt = +(taxable * gst/100).toFixed(2);
  return { qty, rate, taxable_value: taxable, gst_amount: gstAmt, line_total: +(taxable+gstAmt).toFixed(2) };
}
// Map shipment.status → sales-facing fulfilment label.
function fulfilmentFromShipment(sh) {
  if (!sh) return 'not_dispatched';
  if (sh.status === 'shipped') return 'fulfilled';
  if (sh.status === 'cancelled') return 'cancelled';
  if (sh.status === 'packing' || sh.status === 'ready') return 'in_progress';
  return 'pending'; // draft
}
function addDays(dateISO, days) {
  if (!dateISO) return null;
  const d = new Date(dateISO + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (days||0));
  return d.toISOString().split('T')[0];
}
```

> **Note on the seq-row lazy create:** `store.sequences` may not accept a bare duplicate INSERT. Implement `nextInvoiceNo` as: `insert('sequences', {name:key,current_val:0}, true)` (merge-duplicates via the `single=true` `resolution=merge-duplicates` prefer header already in `insert()`), then `rpc('next_seq')`. Verify the merge path inserts-or-ignores in Step smoke; if PostgREST rejects, fall back to a tiny `rpc` upsert. Confirm during build (Task 2.7 smoke).

- [ ] **Step 3:** Build sanity: `cd 05_Throttle && node -e "require('./snorkelops-worker/src/index.js')" ` is not valid (ESM/Worker) — instead deploy-dry: `cd 05_Throttle/snorkelops-worker && npx wrangler deploy --dry-run` → expect "Total Upload" with no syntax error.

- [ ] **Step 4:** Commit: `git -C 05_Throttle add snorkelops-worker/src/index.js && git -C 05_Throttle commit -m "snorkel(sales): perm gates + sales helpers"`

### Task 2.2: Read actions — channels, partners

**Files:** Modify `snorkelops-worker/src/index.js` (GET switch).

- [ ] **Step 1:** Add GET cases (gate `canSalesView`):
  - `getSalesChannels` → `query('sales_channels','?order=sort_order.asc&select=*')`.
  - `getSalesPartners` → `query('sales_partners','?order=name.asc&select=*')` (optional `?active=` filter).
  - `getSalesPartner` → by `id` query param, `select=*`.
- [ ] **Step 2:** Dry-run deploy clean. Commit.

### Task 2.3: Write actions — partners + channels

**Files:** Modify `snorkelops-worker/src/index.js` (POST switch).

- [ ] **Step 1:** Add POST cases:
  - `createSalesPartner` (gate `canSalesPartner`): mint `partner_code = await nextSeq4('sales_partner','SP-')`; insert writable fields (`name` required); `created_by: userId`. Coerce '' → null on date/uuid/numeric. Return row.
  - `updateSalesPartner` (gate `canSalesPartner`): patch by `id`, `updated_at=now()`. `partner_code` immutable (strip).
  - `createSalesChannel` / `updateSalesChannel` (gate `canSalesPartner`): manage label/dispatch_channel_id/is_active/sort_order. `channel_key` immutable on update.
- [ ] **Step 2:** Dry-run clean. Commit.

### Task 2.4: Sales order reads (with fulfilment join + payment rollup)

**Files:** Modify `snorkelops-worker/src/index.js` (GET switch).

- [ ] **Step 1:** `getSalesOrders` (gate `canSalesView`): query `sales_orders` with `?order=created_at.desc&select=*,sales_partners(name,state,channel_key)`; support filters `status`, `channel_key`, `partner_id`. Then **batch-join shipments**: collect non-null `dispatch_shipment_id`s, one `queryPublic('dispatch_shipments', '?id=in.(…)&select=id,status,shipped_at,delivery_date')` (single subrequest — never loop), map by id. For each order attach: `fulfilment_status` (`fulfilmentFromShipment`), `dispatch_date` (shipped_at), `delivery_date`, `due_date = addDays(delivery_date||shipped_at, credit_days)`, `balance = Number(invoice_generated?grand_total:grand_total) - Number(amount_received)` (use grand_total as owed; invoice_value == grand_total in v1), `overdue = balance>0 && due_date && due_date < todayISO()`.
- [ ] **Step 2:** `getSalesOrder` (gate `canSalesView`): one order by `id` + its lines (`sales_order_lines?order_id=eq.&order=sort_order`) + payments (`sales_payments?order_id=eq.&order=received_date.desc`) + the shipment join (single fetch). Same derived fields.
- [ ] **Step 3:** `getSalesCollections` (gate `canSalesView`): `sales_orders?status=eq.confirmed&invoice_generated=eq.true&select=*,sales_partners(name)`; compute balance/due/overdue in JS; return only `balance>0`, sorted overdue-first then due_date asc.
- [ ] **Step 4:** Dry-run clean. Commit.

### Task 2.5: Sales order writes — create / update / cancel

**Files:** Modify `snorkelops-worker/src/index.js` (POST switch).

- [ ] **Step 1:** `createSalesOrder` (gate `canSalesManage`): body `{ partner_id, channel_key, order_date, credit_days, partner_po_ref, expected_dispatch_date, notes, lines:[…] }`. Mint `order_no = nextSeq4('sales_order','SO-')`. Compute each line via `computeLine`; `subtotal=Σtaxable`, `tax_total=Σgst`, `grand_total=subtotal+tax_total`. Insert order (status `draft`, `created_by`), then bulk-insert lines (one array insert — never loop). Default `credit_days` from partner if absent (`getSalesPartner`). Return the created order via `getSalesOrder` shape.
- [ ] **Step 2:** `updateSalesOrder` (gate `canSalesManage`): only when `status='draft'` AND `invoice_generated=false` (else 422 "locked"). Replace lines (delete-then-insert by `order_id`), recompute totals, patch header fields, `updated_at=now()`.
- [ ] **Step 3:** `cancelOrder` (gate `canSalesManage`, `reason` required): allowed from `draft`/`confirmed`. If `dispatch_shipment_id` set, fetch that shipment; if its `status in ('draft','packing')` → `update public dispatch_shipments status='cancelled'`; if `shipped` → return 422 "Goods already dispatched — handle as a return". Set order `status='cancelled'`, `cancelled_by/at`, `cancel_reason`.
- [ ] **Step 4:** Dry-run clean. Commit.

### Task 2.6: Confirm (auto-shipment) + Generate Invoice

**Files:** Modify `snorkelops-worker/src/index.js` (POST switch).

- [ ] **Step 1:** `confirmOrder` (gate `canSalesConfirm`): require `status='draft'` + ≥1 line. Resolve the channel's `dispatch_channel_id` from `sales_channels` (by order.channel_key). Insert into **public.dispatch_shipments** (omit shipment_no/status → defaults):

```js
const shRes = await sbPublic('/rest/v1/dispatch_shipments', { method:'POST',
  prefer:'return=representation',
  body: JSON.stringify({
    channel_id: dispatchChannelId,
    title: `${order.order_no} · ${partnerName}`,
    scheduled_date: order.expected_dispatch_date || todayISO(),
    created_by: userId,
    expected_units: lines.reduce((s,l)=>s+(Math.round(Number(l.qty))||0),0),
    sales_order_id: order.id,
    sales_order_no: order.order_no,
  }) });
const shipmentId = shRes.data[0].id;
// shipment lines from order lines (variant-level manifest)
const shipLines = lines.map(l => ({ shipment_id: shipmentId, product: l.product,
  model: l.model||null, color: l.color||null, target_qty: Math.round(Number(l.qty))||0, packed_qty: 0 }));
await sbPublic('/rest/v1/dispatch_shipment_lines', { method:'POST',
  headers:{Prefer:'return=minimal'}, body: JSON.stringify(shipLines) });
```
  Then patch order `status='confirmed'`, `confirmed_by/at`, `dispatch_shipment_id=shipmentId`.
- [ ] **Step 2:** `generateInvoice` (gate `canSalesManage`): require `status='confirmed'`, `invoice_generated=false`, and **every line has `hsn_code`** (else 422 listing missing). `invoice_no = await nextInvoiceNo(todayISO())`; patch `invoice_no`, `invoice_date=today`, `invoice_generated=true`, `place_of_supply = partner.state`. Lines now frozen (updateSalesOrder already blocks when generated).
- [ ] **Step 3:** `getSalesInvoiceData` (gate `canSalesView`): returns print payload — order + lines + partner + seller (`company_addresses?is_registered_office=eq.true`) + computed tax split: `intra = (sellerState===place_of_supply)`; per line `intra` → `cgst=gst/2, sgst=gst/2` amounts (each `gst_amount/2`), else `igst=gst_amount`; plus totals + amount-in-words (helper).
- [ ] **Step 4:** Dry-run clean. Commit.

### Task 2.7: Payments + smoke

**Files:** Modify `snorkelops-worker/src/index.js` (POST switch).

- [ ] **Step 1:** `recordSalesPayment` (gate `canSalesPayment`): insert `sales_payments` (amount>0, received_date, mode, reference, note, recorded_by/name). Then recompute: `amount_received = Σ payments` for the order; `payment_status = received>=grand_total ? 'paid' : received>0 ? 'partial' : 'unpaid'`; patch order.
- [ ] **Step 2:** `deleteSalesPayment` (gate `canSalesPayment`): delete by id, recompute rollup as above.
- [ ] **Step 3:** Deploy: `cd 05_Throttle/snorkelops-worker && npx wrangler deploy`. Then **data-path smoke** (SQL, then clean up): create a partner + order + line via direct SQL or worker, confirm a shipment row appears in `public.dispatch_shipments` with `sales_order_no` set and a `DSO-` number, generate an invoice (number `LOT/SL/26-27/0001`), record a partial payment (status→`partial`), then delete the test rows. Verify the `nextInvoiceNo` lazy-seed path actually mints (the merge-duplicates concern in Task 2.1 Step 2).
- [ ] **Step 4:** Commit + push 05_Throttle.

---

## Phase 3 — lotopsproxy `delivery_date` on updateShipment

**Files:** Modify `01_worker/worker.js` (`updateShipment` ~line 5931).

- [ ] **Step 1:** In `updateShipment`, add `delivery_date` to the destructured fields and the patch: `if (delivery_date !== undefined) patch.delivery_date = delivery_date || null;`. (The new `sales_order_*` columns already flow through `getDispatchShipments` `select=*`.)
- [ ] **Step 2:** `cd 01_worker && npx wrangler deploy --dry-run` clean.
- [ ] **Step 3:** Commit (root `01_worker`) + push. Then `cd 01_worker && npx wrangler deploy` (after commit, per worker sequence).

---

## Phase 4 — apps/snorkel SALES module

Mirror the asset module (`apps/snorkel/src/app/(auth)/assets/*`, `src/lib/assets.js`, `src/lib/snorkelui.js`, `src/hooks/useProducts.js`) for structure, styling, fetch (`garageFetch`/`workerFetch` from `@throttle/db`), and permission gating (`useAuth().hasPermission`).

### Task 4.1: lib + nav

**Files:** Create `apps/snorkel/src/lib/sales.js`; Modify `apps/snorkel/src/lib/nav.js`.

- [ ] **Step 1:** `src/lib/sales.js`: export `ORDER_STATUSES`, `PAYMENT_MODES`, `FULFILMENT_LABELS` ({not_dispatched:'Not dispatched',pending:'Pending',in_progress:'In progress',fulfilled:'Fulfilled',cancelled:'Cancelled'}) + colour map, `fyLabel`, `amountInWords(n)` (INR), and a `gstSplit(line, intra)` helper mirroring the worker.
- [ ] **Step 2:** `nav.js`: add a `SALES` group gated by `sales_view`: Orders (`/sales/orders`), Collections (`/sales/collections`), Partners (`/sales/partners`), Settings (`/sales/settings`, gate `sales_partner_manage`). Match existing nav-group shape.
- [ ] **Step 3:** Build: `cd 05_Throttle && npx turbo build --filter=snorkel` → 0 errors. Commit.

### Task 4.2: Partners pages

**Files:** Create `apps/snorkel/src/app/(auth)/sales/partners/page.js`, `.../partners/new/page.js`, `.../partners/detail/page.js`.

- [ ] **Step 1:** List (search, channel filter, active toggle, CSV) → `getSalesPartners`. New + detail forms (all partner fields, `default_credit_days`) → `createSalesPartner`/`updateSalesPartner`. Gate edit on `sales_partner_manage`.
- [ ] **Step 2:** Build snorkel clean. Commit.

### Task 4.3: Orders list + new

**Files:** Create `.../sales/orders/page.js`, `.../sales/orders/new/page.js`.

- [ ] **Step 1:** List: KPI tiles (open orders, value-to-dispatch, overdue ₹, this-FY sales), filters (status/channel/partner/fulfilment/overdue), search, CSV → `getSalesOrders`. Rows show order_no, partner, channel, grand_total, fulfilment badge, payment badge, due/overdue.
- [ ] **Step 2:** New: partner picker (auto-fills channel + credit_days + state), order meta, line editor (product picker from `useProducts` → product/model/color/sku; manual hsn/description/qty/rate/disc%/gst%; live taxable/gst/total + order totals) → `createSalesOrder`. Gate on `sales_order_manage`.
- [ ] **Step 3:** Build snorkel clean. Commit.

### Task 4.4: Order detail (confirm, invoice, payments)

**Files:** Create `.../sales/orders/detail/page.js`.

- [ ] **Step 1:** Header + lines (inline edit while `draft` & not invoiced → `updateSalesOrder`). Actions: **Confirm** (`confirmOrder`, gate `sales_order_confirm`), **Generate Invoice** (`generateInvoice`, gate `sales_order_manage`, blocks if any line missing HSN), **Cancel** (reason). Fulfilment panel: badge + dispatch_date + delivery_date + due_date (read-only, from getSalesOrder). **Payments tab**: list receipts + running balance + overdue badge; record receipt (`recordSalesPayment`, gate `sales_payment_manage`); delete receipt. Invoice "Print" link once generated.
- [ ] **Step 2:** Build snorkel clean. Commit.

### Task 4.5: Invoice print + collections + settings

**Files:** Create `.../sales/orders/invoice/page.js`, `.../sales/collections/page.js`, `.../sales/settings/page.js`.

- [ ] **Step 1:** Invoice print: reads `getSalesInvoiceData`; renders GST tax invoice (seller block + GSTIN, invoice no/date, Bill-To/Ship-To + GSTIN, place of supply, line table with CGST/SGST or IGST columns per intra/inter, totals, amount in words, signature), auto-print on load. Reuse the PO print page CSS pattern in apps/snorkel.
- [ ] **Step 2:** Collections: `getSalesCollections` table (partner, invoice, total, received, balance, due, days overdue) + inline record-payment. Gate `sales_view`; payment action `sales_payment_manage`.
- [ ] **Step 3:** Settings: manage sales channels (label / dispatch-channel mapping / active / sort) → `getSalesChannels` + `createSalesChannel`/`updateSalesChannel`. Gate `sales_partner_manage`.
- [ ] **Step 4:** Build snorkel clean. Commit + push 05_Throttle.

### Task 4.6: Admin roles matrix — add sales keys

**Files:** Modify the Snorkel admin roles UI (`apps/snorkel/src/app/(auth)/admin/roles/page.js`) + any perm-key catalogue in `src/lib/`.

- [ ] **Step 1:** Add the 5 sales keys (with labels + a "Sales" group) to the permission matrix so admins can compose roles. Mirror how asset keys were added.
- [ ] **Step 2:** Build snorkel clean. Commit + push.

---

## Phase 5 — apps/redline shipment UI (delivery date + order link)

**Files:** Modify `apps/redline/src/app/(auth)/dispatch-shipments/page.js`.

- [ ] **Step 1:** Where a shipment renders, if `sales_order_no` is present show a badge "Order <SO-…>". On the shipment detail/row (when `status` is `shipped`), add a **Delivery date** date input that calls `workerFetch('updateShipment', { shipment_id, delivery_date })`. Keep it unobtrusive — only for shipments carrying a `sales_order_no` (the offline-sales ones) so existing ecom dispatch is visually unchanged.
- [ ] **Step 2:** Build: `cd 05_Throttle && npx turbo build --filter=redline` → 0 errors.
- [ ] **Step 3:** Commit + push 05_Throttle (this is the only redline diff).

---

## Phase 6 — Verify, knowledge files, wrap

- [ ] **Step 1:** Full build: `cd 05_Throttle && npx turbo build --filter=snorkel --filter=redline` → 0 errors. Confirm snorkelops + lotopsproxy deployed.
- [ ] **Step 2:** End-to-end data-path smoke (then clean test rows): partner → order(draft) → confirm (shipment in Redline `public.dispatch_shipments` with `sales_order_no`, appears in `getDispatchShipments`) → generate invoice → record partial + full payment (status→paid) → simulate Redline setting `shipped_at` + `delivery_date` via `updateShipment` → `getSalesOrder` shows `fulfilled` + correct `due_date = delivery_date + credit_days`.
- [ ] **Step 3:** Knowledge files: update `systems/snorkel.md` (new SALES module section + RULE-SNORKEL-00X for the offline-sales/dispatch-handoff invariants), `CORE.md` (store tables list + snorkelops perm keys), `BUSINESS_RULES.md` (new RULE), `BACKLOG.md` (close the feature, log deferred items: returns/credit notes, e-invoice IRN, e-way bill, price lists, partial-dispatch/multi-invoice, credit-limit, notifications). Bump `Last updated`.
- [ ] **Step 4:** Commit + push root + 05_Throttle + 01_worker; `git status` clean on all three.

---

## Self-review (spec coverage)
- Partner master → 2.2/2.3/4.2 ✓ · Channels (GT/MT + others) → migration §9, 2.2/2.3, 4.5 ✓
- Order capture + Draft→Confirmed gate → 2.5/2.6, 4.3/4.4 ✓ · Auto-shipment to Redline → 2.6 + Phase 5 ✓
- Fulfilment status read-only → 2.4 (`fulfilmentFromShipment`, due_date) ✓
- GST invoicing (intra/inter split, FY numbering, print) → 2.6, 4.5 ✓
- Partial payments + collections + overdue → 2.7, 2.4, 4.4/4.5 ✓
- Permissions (5 keys + roles) → migration §10, 2.1, 4.6 ✓ · Redline delivery_date → Phase 3 + 5 ✓
- Out-of-scope items logged → Phase 6 Step 3 ✓
