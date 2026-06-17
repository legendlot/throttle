# Manifest — SF-side order lifecycle — Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit + push (+ deploy worker) after each task.

**Goal:** Turn Manifest into one continuous, party-owned lifecycle — **LOT requests + funds the pool; SF owns everything after** (convert → place → PI → pay vendor → ship → clear customs → deliver → invoice). Flip the money model to **payment-driven** (every SF payment deducts the shared pool the moment it's recorded; the invoice becomes a close-out record). Decouple the Snorkel projection (POs are in vendor codes). Add per-line GST, a cancel-until-pickup rule, immutable original plan dates, and a full timestamped history on orders + shipments. Add **shipment modes (Air vs Sea — relabel only, Decision A)**, **editable per-mode timeline defaults** (`stage_defaults`, suggest-not-lock), and **logistics-partner + last-mile-vehicle capture** reusing `store.forwarders` with **no free-text entry** (spec §5a + §14).

**Spec:** `docs/superpowers/specs/2026-06-16-manifest-sf-order-lifecycle-design.md`
**Business-logic reference (manual source):** `apps/manifest/docs/order-lifecycle-business-logic.md`
**Rules:** amends RULE-MANIFEST-001 (running account → payment-driven), RULE-MANIFEST-003 (Snorkel projection parked pending a connector); RULE-MANIFEST-004/005 retained.

**Architecture:** `manifest` schema (Supabase `jkxcnjabmrkteanzoofj`), sole DB client = `manifestops` worker (`05_Throttle/manifestops-worker/src/index.js`, service_role, `sb`/`sbStore` PostgREST helpers). App = `apps/manifest` SPA ("Pit Wall", `src/mf/*`: `ManifestApp.js`, `Chrome.js`, `Drawer.js`, `screens.js`, `ui.js`, `data.js`, `nav.js`). Party-aware perms via `manifest_roles` (`party` LOT|SF) + `stripCost`.

**What already exists (confirmed against live DB 2026-06-17) — do NOT rebuild:**
- `stage_events` is already `entity('order'|'shipment') + order_id + shipment_id + stage + from_stage + note + actor + actor_name + party + occurred_at` → the history table for point 7. Just log more event kinds.
- `order_lines.gst_percent` + `hsn_code` exist. `orders.vendor_code`/`vendor_name` (= the supplier) exist.
- `charges` has `scope`/`order_id`/`shipment_id`/`category`/`amount_inr`/`incurred_date`; category enum already = `goods|sf_commission|intl_freight|customs_duty|clearing|insurance|local_freight|other`; **non-goods charges already feed `running_account`**.
- `vendor_payments` has `order_id`/`amount_inr_debited`/`actual_bank_rate`/`payment_date` (but is NOT currently in `running_account` — S144 demoted it).
- `po_allocations` + `po_payment_schedule` (S145).
- **`shipments.mode`** already exists (CHECK `{sea,air,land}`, nullable) — sea-flavored status pipeline `planned→loaded→sailing→docked→cleared→local_transport→received`; **zero shipments today** (clean slate). `shipments.forwarder_code`/`forwarder_name`, `bl_awb_no`, `container_type`, and the 9 milestone date cols (`etd`/`eta`/`loading_date`/`unloading_date`/`port_arrival_date`/`customs_entry_date`/`clearance_date`/`local_dispatch_date`/`warehouse_delivery_date`) all exist.
- **Masters are rich + reusable (verified 2026-06-17):** `store.vendors` (vendor_code/name/category/source_country/country_iso/currency/gstin/payment_terms/lead_time_days — covers china/intl/domestic) + `store.forwarders` (forwarder_code/company_name/country/**modes_supported[]**/**sea_days**/**air_days**/land_days/**iata_code**/**scac_code**/tracking_url). Manifest already READS both. **NO new master tables** — extend forwarders via inline-create only.
- Worker actions already present: `convertToPo`? **NO.** Present: `getBootstrap/getOrders/getOrder/createOrder/updateOrder/setOrderStatus/saveOrderLines/advanceOrderStage/invoiceOrder/allocateToPo/setPoSchedule/moveOrderToShipment/createShipment/updateShipment/setShipmentLines/advanceShipmentStage/createCharge/recordPayment/recordVendorPayment/createDrawdown/createSfInvoice/recordDocument/projectToSnorkel/...`.

**Charge-category mapping (no new enum needed):** shipping→`intl_freight`, customs→`customs_duty`, other port fees→`clearing`/`insurance`/`other`, last-mile→`local_freight`.

**Testing reality:** no unit-test harness. Verify per task = `apply_migration`/`execute_sql` checks, `npx turbo build --filter=manifest` (zero errors), `cd 05_Throttle/manifestops-worker && npx wrangler deploy` + a `?action=ping` curl, and a live browser smoke at the end.

**Conventions (do not violate):**
- PostgREST returns numerics as strings → `Number()` before arithmetic; integer inserts `Math.round()`.
- Never loop `await` per row — batch with `in.(...)` / array inserts (50-subrequest limit).
- Every new/changed `manifest` table: RLS stays enabled + `GRANT ALL ... TO service_role`; no anon grants (RULE-RLS-001).
- Cross-repo git: `git -C 05_Throttle ...`. Wrangler: `cd 05_Throttle/manifestops-worker && npx wrangler deploy`.
- Worker: edit → commit → push → deploy. Migrations via Supabase MCP `apply_migration` (name in each task).
- `execute_sql` multi-statement returns only the LAST statement's rows — diagnostics one statement per call.
- DESTRUCTIVE SQL (`DROP`/`DELETE`/`TRUNCATE`) prompts via sql-gate; constraint swaps below use `DROP CONSTRAINT` → will prompt, that's expected.
- **Money safety:** the live running account = **−₹34,81,246**. After the Phase 4 view rewrite it MUST still read −₹34,81,246 (legacy fallback preserves it). Re-verify after every money task.

---

## Phase 1 — States, convert, cancel, permissions

### Task 1: Migration — new states + line columns

**Apply via** Supabase MCP `apply_migration`, name `manifest_sf_lifecycle_states_v1`, project `jkxcnjabmrkteanzoofj`.

- [ ] **Step 1: Apply**
```sql
-- Manifest SF-side lifecycle — Phase 1: states + line columns. Spec 2026-06-16-manifest-sf-order-lifecycle-design.
-- orders.status: add 'requested' (new initial state before draft)
alter table manifest.orders drop constraint orders_status_check;
alter table manifest.orders add constraint orders_status_check
  check (status = any (array['requested','draft','placed','confirmed','produced','picked_up','shipped','received','cancelled']));

-- orders.cost_state: add 'partially_invoiced' (between delivered and invoiced)
alter table manifest.orders drop constraint orders_cost_state_chk;
alter table manifest.orders add constraint orders_cost_state_chk
  check (cost_state = any (array['in_flight','delivered','partially_invoiced','invoiced','cancelled']));

-- order_lines: per-line invoice stamp + vendor item code + future LOT-product mapping
alter table manifest.order_lines add column if not exists invoice_no       text;
alter table manifest.order_lines add column if not exists vendor_item_code text;  -- vendor's product code (e.g. 820D)
alter table manifest.order_lines add column if not exists lot_product_code text;  -- nullable; filled later by the Snorkel connector
-- gst_percent already exists on order_lines.
```

- [ ] **Step 2: Verify** — `execute_sql` `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('orders_status_check','orders_cost_state_chk');` shows the new values; `order_lines` has the 3 new columns.

### Task 2: Worker — `convertToPo` + `cancelOrder` + party gates

**File:** `05_Throttle/manifestops-worker/src/index.js`

- [ ] **Step 1: Permission keys.** In the SF key list add `sf_po_manage` + `sf_invoice_create`. Grant both to the seeded `sf_owner` role (data: `UPDATE manifest.manifest_roles SET permissions = permissions || '{"sf_po_manage":true,"sf_invoice_create":true}' WHERE role_id='sf_owner';` — verify schema/shape of the permissions column first). Add a `canSf(perm)` helper mirroring the existing LOT `can(perm)`.
- [ ] **Step 2: `createOrder` default state.** A LOT-created request starts `status='requested'` (today it likely starts `draft`). Add an explicit `requested`-creating path for LOT (reuse `createOrder`; set status `requested` when created by a LOT party / no PO detail yet).
- [ ] **Step 3: `convertToPo`** (new POST case). Guard `canSf('sf_po_manage')`. Body `{ order_id }`. Require current `status='requested'`; set `status='draft'`; stamp ownership (`placed_via='SF'`). Log a `stage_events` row (`entity='order'`, `stage='draft'`, `from_stage='requested'`, party SF). Return updated order.
- [ ] **Step 4: `cancelOrder`** (new POST case). Guard `canSf('sf_po_manage')` (and LOT admin). Body `{ order_id, reason }` (reason required → 400 if missing). **Guard: only if `status ∈ {requested,draft,placed,confirmed,produced}`** else 409 `"cannot cancel after pickup"`. Set `status='cancelled'`, `cost_state='cancelled'`. Log `stage_events` (`stage='cancelled'`, note=reason). Do NOT auto-reverse any existing payments (loose; §13 of spec).
- [ ] **Step 5: Build/deploy/verify** — `npx turbo build --filter=manifest` is a no-op for worker; deploy worker, `curl '.../?action=ping'`. Functional check: `execute_sql` a temp `requested` order, call `convertToPo`, confirm `draft` + a stage_event; call `cancelOrder` on a `picked_up` order → 409.

### Task 3: App — Request → Convert → Cancel controls

**Files:** `apps/manifest/src/mf/screens.js`, `ManifestApp.js`, `Drawer.js`, `data.js` (worker action wrappers).

- [ ] **Step 1:** LOT users get a **"New request"** affordance that creates a `requested` order (minimal: title + intended items). SF users see `requested` orders with a **"Convert to PO"** button → `convertToPo` → opens the PO editor (existing order edit) in `draft`.
- [ ] **Step 2:** Add a **Cancel** action on the order drawer, visible only while `status ∈ {requested..produced}`, requires a reason, calls `cancelOrder`. Hide it once `picked_up`+.
- [ ] **Step 3:** Surface the new states in the status chips/labels (`requested`, `partially_invoiced`).
- [ ] **Step 4: Build** `npx turbo build --filter=manifest` (zero errors); commit + push (auto-deploys via `deploy-manifest.yml`).

---

## Phase 2 — Vendor codes + PO PDF + PI milestone (Snorkel parked)

### Task 4: Park the Snorkel projection

- [ ] **Step 1:** In the worker, disable/guard `projectToSnorkel` so it is NOT auto-fired on any stage transition (search `advanceOrderStage`/`setOrderStatus` for any auto-call). Leave the action callable but behind a feature flag / explicit-only, returning a clear "connector not yet built — vendor codes need LOT-product mapping" message if invoked. Add a code comment pointing to spec §2.
- [ ] **Step 2:** Note in `systems/manifest.md` that projection is parked pending the connector (done at session end).

### Task 5: App — vendor item codes on PO lines

**Files:** `apps/manifest/src/mf/screens.js` (order/PO line editor), `data.js`.

- [ ] **Step 1:** In the PO line editor, add a **Vendor item code** field (writes `order_lines.vendor_item_code`) and keep the existing description. `lot_product_code` is left blank (future connector). Show vendor codes on the order detail.
- [ ] **Step 2:** `saveOrderLines` worker case — accept + persist `vendor_item_code` (and pass through `lot_product_code` if present). Build/commit/push.

### Task 6: Worker — `getPoDocData` + App — PO PDF print route

**Files:** worker `src/index.js`; app new route `apps/manifest/src/app/doc/page.js` (static print route, mirrors Snorkel `apps/snorkel/src/app/(auth)/sales/orders/invoice/page.js`).

- [ ] **Step 1: `getPoDocData(order_id)`** (GET) — returns the order header (order_no, vendor_name, incoterms, currency, dates) + lines (vendor_item_code, description, qty, unit_price_rmb, line totals) + ¥ totals. No cost-stripping needed (vendor-facing ¥ doc).
- [ ] **Step 2: Print route** `/doc?type=po&id=<order_id>` — a standalone page (outside the SPA auth shell) that fetches `getPoDocData`, renders a clean B/W vendor-facing PO (header, vendor, order no, line items with ¥ pricing, terms, totals), and auto-`window.print()`s. Reuse the Snorkel invoice page's print CSS pattern.
- [ ] **Step 3:** On the order drawer, when `status='placed'`+, show **Download PO PDF** → opens `/doc?type=po&id=…`. Build/commit/push.
- [ ] **Note:** placeholder format; swap SF's real layout when provided. This route is reused later for the Reports tab (separate spec).

### Task 7: Worker — PI milestone on doc record

**File:** worker `src/index.js` (`recordDocument` case).

- [ ] **Step 1:** Add `const DOC_TYPE_MILESTONE = { pi: 'pi_attached' };` (module scope). In `recordDocument`, after persisting a doc whose `doc_type` is in the map, insert a `stage_events` row (`entity='order'`, `order_id`, `stage = DOC_TYPE_MILESTONE[doc_type]`, `occurred_at = now()`, party = caller). v1 wires `pi` only.
- [ ] **Step 2:** App order timeline renders `pi_attached` as a milestone (Phase 3 timeline work will format it). Deploy/verify: record a `pi` doc → a `pi_attached` stage_event appears.

---

## Phase 3 — History/timeline + immutable original plan

### Task 8: Worker — log all lifecycle events to `stage_events`

**File:** worker `src/index.js`. `stage_events` already supports order + shipment.

- [ ] **Step 1:** Ensure EVERY state-moving action writes a `stage_events` row (entity, id, stage, from_stage, note, actor, party, occurred_at): `advanceOrderStage`, `advanceShipmentStage` (already?), `convertToPo`, `cancelOrder`, `invoiceOrder` (`partially_invoiced`/`invoiced`), `recordVendorPayment` (`stage='payment'`, note=type+amount), shipment cost charges, `setShipmentLines`/allocate/move, `recordDocument` (PI). Audit each case; add the insert where missing. Batch-safe (one insert per action, not per row).
- [ ] **Step 2: Date planning events.** When a shipment's expected milestone dates are first set (`createShipment`/`updateShipment` with any of the 9 date cols), write a `stage='dates_planned'` event with the dates snapshot in `note`/a jsonb if available. On a later change to those dates, write `stage='dates_revised'` with old→new. **The first `dates_planned` event is the immutable original plan** (append-only table; never updated). No new columns needed.
- [ ] **Step 3:** `getActivity`/`getOrder`/`getShipment` return the full ordered event list per entity. Deploy/verify.

### Task 9: App — order + shipment timelines (planned vs actual + original)

**Files:** `apps/manifest/src/mf/screens.js`, `Drawer.js`, `ui.js`.

- [ ] **Step 1:** Order drawer + shipment drawer each render a **timeline**: each pipeline step shows its **expected date** (current plan, faint) and the **actual stamp** (from the matching `stage_advanced`/milestone event). Thread payments, PI, invoicing, cancel into the order timeline; milestones + logistics payments into the shipment timeline. Shipment-timeline step labels are **mode-aware** (spec §5a — "In Flight"/"Landed" for air vs "Sailing"/"Docked" for sea); if Phase 5's `MODE_PROFILE` isn't built yet, fall back to the raw status key and relabel when it lands.
- [ ] **Step 2:** Show **original plan vs current plan** where dates were revised (from the first `dates_planned` event vs the latest). Build/commit/push.

---

## Phase 4 — Payment-driven money (the core flip) ⚠️ money-safety phase

### Task 10: Migration — payment typing + shipment notes

**Apply via** `apply_migration`, name `manifest_payment_model_v1`.

- [ ] **Step 1: Apply**
```sql
-- Manifest payment-driven money — Phase 4. Spec §6. Amends RULE-MANIFEST-001.
alter table manifest.vendor_payments add column if not exists payment_type text;  -- advance | pickup_balance | other
alter table manifest.vendor_payments add constraint vendor_payments_payment_type_chk
  check (payment_type is null or payment_type = any (array['advance','pickup_balance','other']));
alter table manifest.shipments add column if not exists cost_notes text;
alter table manifest.charges add column if not exists due_stage text;             -- optional: stage the logistics cost falls due
```
- [ ] **Step 2: Verify** columns + constraint present.

### Task 11: Migration — `running_account` view rewrite (payment-driven, legacy-safe)

**Apply via** `apply_migration`, name `manifest_running_account_payment_driven_v1`.

- [ ] **Step 1: Apply** — goods debit = actual `vendor_payments` if the order has any, else fall back to stored `recognized_cost_inr` (keeps the FY26-27 seed reading −₹34,81,246 until Phase 7 reworks it). Logistics charges (category≠goods) + commission + ledger + LOT payments unchanged.
```sql
create or replace view manifest.running_account as
with goods as (
  select o.id as order_id, o.order_no, o.title, o.cost_state, o.created_at, o.invoice_date,
    case when exists (select 1 from manifest.vendor_payments vp where vp.order_id = o.id)
         then (select coalesce(sum(vp.amount_inr_debited),0) from manifest.vendor_payments vp where vp.order_id = o.id)
         else coalesce(o.recognized_cost_inr, 0)
    end as goods_inr
  from manifest.orders o
  where o.cost_state <> 'cancelled'
),
entries as (
  select p.paid_date as entry_date, 'payment'::text as kind, p.payment_no as ref_no,
         coalesce(nullif(p.note,''), 'LOT -> SF payment (' || coalesce(p.subentity_code,'') || ')') as description,
         p.amount_inr as signed_inr, p.created_at
    from manifest.payments p
  union all
  select coalesce(g.invoice_date, g.created_at::date), 'goods', g.order_no,
         (coalesce(g.title,'Order') || ' [' || g.cost_state || ']'), - g.goods_inr, g.created_at
    from goods g where g.goods_inr <> 0
  union all
  select i.invoice_date, 'commission', i.invoice_no,
         ('SF commission ' || coalesce(i.commission_rate::text,'') || '% on ' || i.invoice_no), - i.commission_inr, i.created_at
    from manifest.sf_invoices i where i.commission_inr <> 0
  union all
  select c.incurred_date, 'charge', c.charge_no,
         coalesce(nullif(c.description,''), c.category), - c.amount_inr, c.created_at
    from manifest.charges c where c.is_estimate = false and c.category <> 'goods' and c.amount_inr is not null
  union all
  select le.entry_date, coalesce(le.type,'manual'), null::text,
         coalesce(nullif(le.description,''), le.subtype, le.type), le.amount_inr, le.created_at
    from manifest.ledger_entries le
)
select entry_date, kind, ref_no, description, signed_inr,
       sum(signed_inr) over (order by coalesce(entry_date, created_at::date), created_at
                             rows between unbounded preceding and current row) as running_balance,
       created_at
  from entries;
```
- [ ] **Step 2: MONEY-SAFETY VERIFY** — `execute_sql` `SELECT round(sum(signed_inr)) FROM manifest.running_account;` → **must be `-3481246`**. If not, STOP and reconcile before proceeding (likely a seeded order already has stray vendor_payments).

### Task 12: Worker — typed payment recorders + pool-sufficiency

**File:** worker `src/index.js`.

- [ ] **Step 1: `recordVendorPayment`** — extend to accept `payment_type` (`advance`|`pickup_balance`) + `order_id`; persist; log a `stage_events` payment row; this now hits the pool via the view (Task 11). Guard `canSf('sf_po_manage')`.
- [ ] **Step 2: `recordShipmentCost`** (new, or extend `createCharge`) — body `{ shipment_id, charge_type, amount_inr, due_stage?, notes? }`. Map `charge_type`→category (shipping→intl_freight, customs→customs_duty, other_fees→clearing/other, last_mile→local_freight), `scope='shipment'`, `is_estimate=false`. Log a stage_event on the shipment. Guard `canSf('sf_po_manage')`.
- [ ] **Step 3: Pool-sufficiency** — a `getPoolAvailable()` helper = current `running_account` net. `recordVendorPayment`/`recordShipmentCost` return `{ ok, pool_after, shortfall }` (shortfall>0 when the debit pushes net below 0 / a chosen threshold). **Not a gate** — payment still records.
- [ ] **Step 4:** Deploy/verify — record a test advance + a test shipment cost on a throwaway order; confirm both appear in `running_account` as debits and the net moved; then delete the test rows and re-verify net = −3481246.

### Task 13: App — payments across stages + draw-down nudge

**Files:** `apps/manifest/src/mf/screens.js` (order + shipment drawers, money screen), `data.js`.

- [ ] **Step 1:** Order drawer: **Record vendor payment** (advance after PI; pickup balance at pickup) with type + amount + bank rate + date. Shipment drawer: **Record shipment cost** (shipping / customs / other fees / last-mile) at the relevant stage. The shipment-cost line **suggestions are mode-aware** (spec §5a: air → freight (chargeable weight) + customs + airport handling; sea → freight + customs + port/CFS/THC) — all still map to the existing `charges` categories; the freight-basis hint goes in `cost_notes`.
- [ ] **Step 2:** After recording, if `shortfall>0`, surface a **Raise Draw-down** prompt (calls existing `createDrawdown`). Funding nudge, not a blocker.
- [ ] **Step 3:** Show the per-order + per-shipment payment ledger (type, amount, date) on the drawers. Build/commit/push.

### Task 14: Fold the S145 PO allocation layer

- [ ] **Step 1:** Decide (confirm with Afshaan — spec §13): retire `po_allocations` (the actual payments are now the truth) or keep it as a thin display. **Default: keep `po_payment_schedule` as the optional "what's due when" planner (moves no money); stop using `po_allocations` as the paid marker.** No `running_account` impact either way (allocations were never in it). Add a code comment + leave tables in place (no destructive drop) unless Afshaan says drop.

---

## Phase 5 — Shipments: modes + config + masters + item allocation / move / departure-lock

> Decision A (relabel the shared pipeline; **no status-enum change**) + the 2026-06-17 config
> items: editable per-mode timeline defaults, vendor/forwarder master reuse, logistics-partner
> + last-mile-vehicle capture. Tasks 15a–15c (config + masters + modes) are independent of the
> rest of the phase and **may be built first**. See spec §5a + §14.

### Task 15a: Migration — mode required + shipment defaults config + last-mile columns

**Apply via** Supabase MCP `apply_migration`, name `manifest_shipment_modes_config_v1`.

- [ ] **Step 1: Apply**
```sql
-- Manifest shipment modes + config + last-mile partner. Spec §5a + §14.
-- mode required (zero rows today → safe to enforce NOT NULL); keep the {sea,air,land} CHECK.
alter table manifest.shipments alter column mode set not null;

-- last-mile partner + vehicle (captured at local_transport; partner = a store.forwarders code)
alter table manifest.shipments add column if not exists last_mile_forwarder_code text;
alter table manifest.shipments add column if not exists last_mile_forwarder_name text;
alter table manifest.shipments add column if not exists last_mile_vehicle_no     text;
-- cost_notes is added in Phase 4 Task 10; add here too (idempotent) in case Phase 5 lands first:
alter table manifest.shipments add column if not exists cost_notes text;

-- editable per-mode timeline defaults (suggest, not lock; no audit)
create table if not exists manifest.stage_defaults (
  mode        text not null check (mode = any (array['sea','air','land'])),
  stage       text not null check (stage = any (array['loaded','sailing','docked','cleared','local_transport','received'])),
  offset_days integer not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (mode, stage)
);
alter table manifest.stage_defaults enable row level security;
grant all on manifest.stage_defaults to service_role;

-- seed sensible defaults (offset_days = days after the previous milestone)
insert into manifest.stage_defaults (mode, stage, offset_days) values
  ('sea','loaded',3),('sea','sailing',5),('sea','docked',25),('sea','cleared',3),('sea','local_transport',3),('sea','received',2),
  ('air','loaded',1),('air','sailing',1),('air','docked',2),('air','cleared',2),('air','local_transport',1),('air','received',1)
on conflict (mode, stage) do nothing;
```

- [ ] **Step 2: Verify** — `execute_sql`: `shipments.mode` is NOT NULL; `stage_defaults` has 12 seeded rows; the 3 last-mile columns + `cost_notes` exist.

### Task 15b: Worker — stage defaults + forwarder inline-create + create-time date pre-fill

**File:** `05_Throttle/manifestops-worker/src/index.js`

- [ ] **Step 1: `getStageDefaults()` / `setStageDefaults(rows)`** — read + upsert `manifest.stage_defaults`. Guard `manifest_admin` (LOT) or `sf_po_manage` (SF). Plain upsert, **no stage_event / no audit**.
- [ ] **Step 2: `createForwarder(payload)`** — cross-schema write into `store.forwarders` via `sbStore` (**Manifest's first non-projection cross-schema write** — record it in CORE/spoke). Require the master NOT-NULL fields: `forwarder_code` (mint if not given), `company_name`, `country`, `country_iso`, `modes_supported[]`; optional `iata_code`/`scac_code`/`tracking_url`/contact. Return the created row. **No free-text fallback anywhere — this is the only way a new partner enters.**
- [ ] **Step 3: `createShipment` pre-fill.** Require `mode` (400 if missing). After insert, walk `stage_defaults` for that mode (ordered loaded→received) from a planning anchor (today or a passed `anchor_date`) to set `loading_date`/`etd`/`eta`/`port_arrival_date`/`clearance_date`/`local_dispatch_date`/`warehouse_delivery_date` as **suggested** values; all overridable via `updateShipment`. Log the first-set as the `dates_planned` event (Phase 3 Task 8 Step 2).
- [ ] **Step 4:** Accept `last_mile_forwarder_code`/`_name`/`last_mile_vehicle_no` on `updateShipment` (set at the `local_transport` step). `getShipment`/`getBootstrap` return `mode`, the resolved per-mode labels, the last-mile fields, and the mode-filtered carrier list.
- [ ] **Step 5:** Deploy/verify — `getStageDefaults` returns the 12 seeds; `createForwarder` adds a `store.forwarders` row; a new shipment pre-fills dates per mode.

### Task 15c: App — mode selector, relabeling, admin defaults, partner pickers, last-mile

**Files:** `apps/manifest/src/mf/screens.js`, `Drawer.js`, `ui.js`, `data.js`; new admin screen.

- [ ] **Step 1: `MODE_PROFILE` constant** (shared shape, app + worker) — per-mode stage labels (`sailing`→"In Flight"/"Sailing", `docked`→"Landed"/"Docked"), BL/AWB label, container_type label, and the suggested cost-line list. Shipment views + timelines render labels via `MODE_PROFILE[shipment.mode]`.
- [ ] **Step 2:** `createShipment` UI requires a **mode** (Sea / Air) selector — editable while `planned`, locked once `loaded`. BL/AWB + container_type fields relabel by mode.
- [ ] **Step 3: Admin → Shipment defaults** screen — a per-mode editable grid of `offset_days` → `setStageDefaults`. Gated `manifest_admin` / `sf_po_manage`.
- [ ] **Step 4: Carrier picker** filtered to `modes_supported ⊇ mode`; **last-mile partner picker** (forwarders, typically land) at the `local_transport` step + a **vehicle number** field. Both pickers offer **"+ Add new partner"** → small form → `createForwarder` → returns with it selected. **No free-text partner entry.**
- [ ] **Step 5: Build** `npx turbo build --filter=manifest` (zero errors); commit + push.

### Task 15d: Worker — item-level allocate/move with departure-lock

**File:** worker `src/index.js` (extends `setShipmentLines`/`moveOrderToShipment`).

- [ ] **Step 1: `allocateItemsToShipment`** — body `{ shipment_id, items:[{order_line_id, qty}] }`. Insert `shipment_lines`. Guard: target shipment `status ∈ {planned,loaded}` else 409 (departure-lock — `status='sailing'`, labeled "In Flight" for air).
- [ ] **Step 2: `moveItemsBetweenShipments`** — `{ from_shipment_id, to_shipment_id, items:[...] }`. Guard BOTH source and target are `status ∈ {planned,loaded}` else 409. Log stage_events on both shipments.
- [ ] **Step 3:** Deploy/verify — allocate to a `planned` shipment OK; flip to `sailing`; attempt move → 409.

### Task 15e: App — shipment composition UI (mode-aware)

**Files:** `apps/manifest/src/mf/screens.js` (shipment screen/drawer).

- [ ] **Step 1:** Shipment view shows allocated lines (grouped by PO) with the mode badge (Sea/Air) + per-mode stage labels; **Add items** / **Move items** controls disabled once `status='sailing'`+ (hint "manifest locked — departed" / "sailed" / "in flight" per mode). Build/commit/push.

---

## Phase 6 — Partial invoicing (close-out) + per-line GST

### Task 17: Worker — `invoiceOrder` rewrite (partial + per-line GST)

**File:** worker `src/index.js` (`invoiceOrder` case).

- [ ] **Step 1:** New body: `{ order_id, line_ids:[...], gst_by_line:{line_id:pct}, include_commission:bool }`. Default each line's gst to its existing `order_lines.gst_percent` (or 18 if null), editable per line via `gst_by_line`.
- [ ] **Step 2:** On submit:
  1. Mint the invoice no via the existing `nextInvoiceNo()` (`VWINV-<FY>00<N>`); never typed.
  2. Stamp each selected `order_lines.invoice_no` + `gst_percent` used (only lines with `invoice_no IS NULL` — a line bills once; 409/skip already-billed).
  3. Create/extend the `sf_invoices` row: `total_inr = Σ ticked goods value + Σ per-line GST + (commission if ticked)`, `commission_rate=2.5`/`commission_inr` if included.
  4. `cost_state`: if any goods line still has `invoice_no IS NULL` → `partially_invoiced`; if ALL billed → `invoiced`.
  5. Log a `stage_events` (`stage='partially_invoiced'`/`'invoiced'`).
  6. Pool impact = **commission only** (goods/logistics already debited via payments). GST stays a document figure (confirm-at-build, spec §13 — do NOT add GST to the pool without sign-off).
  7. Support multiple invoices per order (the old whole-order call = "all lines ticked").
- [ ] **Step 3:** Guard `canSf('sf_invoice_create')` (+ LOT finance). Deploy/verify — partial invoice → `partially_invoiced` + lines stamped; invoice the rest → `invoiced`; net moved only by commission; full-order net still reconciles.

### Task 18: App — invoice form (line selection + per-line GST + commission)

**Files:** `apps/manifest/src/mf/screens.js`, `data.js`.

- [ ] **Step 1:** **Invoice** opens a form listing goods lines (un-billed checked by default), an **editable GST% per row** (default 18 / line's gst), a **commission 2.5% toggle**, a live total. Submit → `invoiceOrder`. Show billed lines (with their invoice no) read-only.
- [ ] **Step 2:** Reflect `partially_invoiced`/`invoiced` on the order. Build/commit/push.

---

## Phase 7 — Seed rework (point 8) — LAST, after 1–6 verified

### Task 19: Re-derive the FY26-27 seed onto the payment-driven model

- [ ] **Step 1:** Snapshot first: `create table manifest.safety_seed_prelifecycle_2026_06 as select * from manifest.orders;` (+ vendor_payments, charges, sf_invoices, payments). Take the current `running_account` net as the baseline.
- [ ] **Step 2:** With Afshaan, decide how to re-express each seeded order's goods cost as real `vendor_payments` (advance + pickup) rows so the legacy `recognized_cost` fallback (Task 11) is no longer needed for them. Logistics already on `charges`. Re-derive carefully, order by order.
- [ ] **Step 3:** Re-verify the running-account net (it may legitimately CHANGE from −₹34,81,246 once on the new model — Afshaan to confirm the new correct figure; the old number is no longer a hard constraint per spec §9/point 8).
- [ ] **Step 4:** Once the seed is fully on vendor_payments, optionally simplify the Task 11 view to drop the `recognized_cost` fallback (separate migration, only after confirming no order relies on it). Confirm GST-on-invoice-vs-pool here too (spec §13).

---

## Closeout (session-end)
- [ ] Update `systems/manifest.md` (lifecycle + payment-driven money + parked Snorkel projection), `BUSINESS_RULES.md` (RULE-MANIFEST-001 amendment + RULE-MANIFEST-003 parked note), `CORE.md` running_account bullet, `BACKLOG.md` (close the SF-lifecycle P1 item; add the Snorkel-connector as a new item), `archive/SESSIONS.md`.
- [ ] Fold `apps/manifest/docs/order-lifecycle-business-logic.md` into the Manifest in-app manual when the manual is authored.
- [ ] Note the **new cross-schema write** (`createForwarder` → `store.forwarders`) in `systems/manifest.md` + `CORE.md` (Manifest previously had ONLY the Snorkel projection as a cross-schema write). Record `manifest.stage_defaults` + the `shipments` mode/last-mile columns in the spoke's data-model. Add BACKLOG items for **land-mode shipments** + optional **vendor inline-create**.

## Open items to confirm at build time (spec §13)
- GST-on-invoice → pool, or document-only? (default document-only; decide in Phase 7).
- Retire `po_allocations` or keep as a thin view? (default keep, stop relying on it).
- Snorkel connector (vendor_code→LOT product_code mapping + projection) = **separate future spec**.
- PO PDF real format (placeholder until SF provides).
- Reports tab / running-account statement = **separate spec** (PO print route built reusable).
- Forwarder inline-create minimum field set (code / name / country / country_iso / modes at least); `forwarder_code` mint strategy.
- Land-mode shipments out of scope (fall back to sea labels); vendor inline-create is an optional parallel to forwarder inline-create.
