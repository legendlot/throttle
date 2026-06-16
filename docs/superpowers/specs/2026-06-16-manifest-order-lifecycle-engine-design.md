# Manifest — Order Lifecycle Engine (design)

> Spec date: 2026-06-16. System: Manifest (LOT ↔ Solve Factory China imports).
> Builds on the invoice-billing money model (running account, `cost_state`) and the
> Pit Wall UI. Lets users create/edit orders and track each through a logistics
> timeline (placed → received at warehouse), composed with shipment journeys.

## 1. Problem & goals

Orders today are inert: 50 seeded rows sit at `status='intent'`, editable only via raw SQL,
with no journey tracking. We need to:
1. **Create** new orders (draft → place into the pipeline).
2. **Edit** existing "half-information" orders (the in-flight O11/moulds) until they are invoiced.
3. **Track** each order through a timeline: `placed → confirmed → produced → picked up →
   loaded → sailing → docked → cleared → local transport → received at warehouse`.
4. **Invoice** an order (lock it + accrue commission into the running account).

Without distorting the PO↔invoice mapping that the running-account model depends on.

## 2. Core model — two orthogonal axes + an event log

An order carries **two independent coordinates**; a third entity owns the physical journey.

### 2.1 Order — logistics axis (`orders.status`)
The **production half** of the journey lives on the order:
`draft → placed → confirmed → produced → picked_up`, plus `shipped` (has ≥1 shipment leg,
not all received), `received` (all legs landed), `cancelled`. Production stages are advanced
manually; **`shipped` and `received` are worker-maintained** (set when a leg is attached / when
all legs land — never advanced by hand), so the coarse `orders.status` always reflects whether
the order is still in production, in shipping, or done.

### 2.2 Order — billing axis (`orders.cost_state`, unchanged)
`in_flight → delivered → invoiced` (+ `cancelled`). Drives the running account's recognized
cost (purchase-only while `in_flight`; full landed once `delivered`/`invoiced`) and the edit-lock.

### 2.3 Shipment — shipping axis (`shipments.status`)
The **shipping half** lives on the shipment (a physical container/AWB):
`planned → loaded → sailing → docked → cleared → local_transport → received`, `cancelled`.
The shipment's existing milestone-date columns + BL/AWB/container/forwarder are the
structured per-stage data captured as it advances.

### 2.4 `shipment_lines` (exists) — the qty link
Which order(s) and how much ride a shipment. Consolidation (many orders → one shipment) and
split (one order → many shipments) both fall out of this junction. No quantity-reconciliation
enforcement in v1 (flexibility over rigidity); v2 may warn when legs ≠ order qty.

### 2.5 `manifest.stage_events` (new) — timeline source of truth
Append-only log; every stage advance writes one row.

```sql
CREATE TABLE manifest.stage_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity       text NOT NULL CHECK (entity IN ('order','shipment')),
  order_id     bigint REFERENCES manifest.orders(id) ON DELETE CASCADE,
  shipment_id  bigint REFERENCES manifest.shipments(id) ON DELETE CASCADE,
  stage        text NOT NULL,
  from_stage   text,
  note         text,
  actor        uuid,
  actor_name   text,
  party        text,                 -- LOT | SF
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- RLS on; GRANT ALL TO service_role; indexes on (order_id), (shipment_id).
```

## 3. The composed timeline + rollup

An order's displayed timeline = **production steps (order events) + its shipment leg(s)'
shipping steps (shipment events)**.

- **Single shipment** → one continuous 10-step stepper (`placed…received`).
- **Split** → production steps, then per-leg mini-timelines; the order is `received` only
  when **all** legs reach `received`.
- **Consolidation** → advancing one shipment moves every order linked to it.

**Effective stage** (computed in the worker for display + counts):
- No shipment legs → `orders.status` (the production stage).
- Has legs, not all received → the **least-advanced** leg's shipping stage.
- All legs received → `received`.

**Auto-coupling (decided):** when `advanceShipmentStage` sets a shipment to `received`, the
worker checks every order linked to that shipment; for any order whose legs are now **all**
`received`, it sets `orders.status='received'` **and** `cost_state='delivered'` (recognize
full landed cost). Idempotent.

## 4. Edit-lock + invoicing

| Order state | Editable? |
|---|---|
| `draft` / `cost_state` in (`in_flight`,`delivered`) | header, line items, cost fields — **all editable** |
| `cost_state='invoiced'` | cost + lines **locked**; stage advance, notes, docs still allowed |
| `cancelled` | read-only |

`getOrder` returns an **`editable`** flag (`cost_state !== 'invoiced' && status !== 'cancelled'`);
the worker also guards `updateOrder`/`saveOrderLines` server-side (reject when not editable).

**`invoiceOrder(order_id, invoice_no, invoice_date?)`** (LOT finance only):
1. Sets `orders.invoice_no`, `invoice_date`, `cost_state='invoiced'`.
2. Upserts a `manifest.sf_invoices` row (`total_inr = order.total_inr`, `commission_rate=2.5`,
   `commission_inr = round(total_inr * 0.025, 2)`, `status='received'`, `billing_subentity`).
3. Commission + invoice cost flow into the running account via the existing view
   (`order_cost` once the order's `total_inr` is set; `commission` from `sf_invoices`).
4. Locks cost/line edits.

> Note: the running-account view already sums `orders.recognized_cost_inr` and
> `sf_invoices.commission_inr`; invoicing an order makes its full `total_inr` recognized
> (via `cost_state` → `recognized_cost`) and adds its commission. No view change needed.

## 5. Worker actions (manifestops)

New:
- `placeOrder(order_id)` — `draft → placed`; logs event. (Validates it has ≥1 line.)
- `advanceOrderStage(order_id, stage, note?, occurred_at?)` — production stages
  (`placed/confirmed/produced/picked_up`) + `cancelled`; validates forward/explicit transition;
  sets `orders.status`; logs event.
- `advanceShipmentStage(shipment_id, stage, note?, dates?{})` — shipping stages; sets
  `shipments.status` + the matching milestone date column; logs event; on `received`, runs
  the order rollup + cost-coupling.
- `invoiceOrder(...)` — §4.

Changed:
- `createOrder` — default `status='draft'`.
- `updateOrder` / `saveOrderLines` — add edit-lock guard.
- `getOrder` — add `timeline` (production events + per-leg shipping events), `effectiveStage`,
  `legs` (shipments with their lines + status), `editable`.
- `getBootstrap` — orders carry `effectiveStage`; `summary.counts` keyed by effective stage.

Reused as-is: `createShipment`, `setShipmentLines` (attach orders+qty), `getShipments`.
Permissions unchanged: LOT (`order_manage`/`shipment_manage`) + SF (`sf_order_update`) advance
stages; `invoiceOrder` = LOT (`charge_manage`/`payment_record`).

## 6. UI (apps/manifest)

- **Orders list** — **+ New Order** opens the real draft form.
- **New Order form** — create draft: title, category, vendor, currency, expected-ready;
  editable line rows (product/qty/unit ¥) → `createOrder` + `saveOrderLines`. Lands as `draft`.
- **Order Detail** — gains:
  - **Timeline stepper** (composed production + shipment legs; current stage highlighted,
    completed steps show timestamp, click a step → its event note).
  - **Advance stage** control (next-stage button / pick stage + note).
  - Action buttons: **Place order** (draft), **Attach / new shipment leg**, **Mark invoiced**.
  - **Inline-editable** line items + cost fields when `editable`; read-only + lock chip when invoiced.
- **Shipments** — create a shipment, attach order line(s) + qty, **advance shipping stage**
  with milestone-date/BL capture; shipment detail shows its own timeline + the orders it carries.

## 7. Migration + backfill (`manifest_order_lifecycle_v1`)

1. Add `manifest.stage_events` (§2.5) — RLS, service_role grant, indexes.
2. Remap `orders.status` CHECK → `{draft, placed, confirmed, produced, picked_up, shipped,
   received, cancelled}`. Remap `shipments.status` CHECK → `{planned, loaded, sailing, docked,
   cleared, local_transport, received, cancelled}`.
3. Backfill the 50 seeded orders' `status` from `cost_state` (snapshot first):
   `invoiced`/`delivered` → `received`; `in_flight` → `produced`; `cancelled` → `cancelled`.
   Seed a synthetic `placed`+current stage_event per order for history continuity (optional).
4. Reversible: snapshot `manifest.safety_order_status_backfill_<date>` before the UPDATE.

## 8. Out of scope (v2)

- Strict quantity-balance validation across legs; per-line (not per-order) leg allocation.
- Auto-advancing stages from dates; SLA/aging alerts on stuck stages.
- Document auto-attach per stage (PI on confirmed, BL on loaded, BOE on cleared).
- Realtime; SF-invoice ↔ charge reconciliation.

## 9. Build sequence

1. Migration (stage_events + enum remap + backfill).
2. Worker: stage/place/invoice actions + getOrder/getBootstrap updates + edit guards. Deploy.
3. UI: New Order form, Order Detail timeline + edit + actions, Shipments create/advance.
4. Build clean; live-smoke with a real login (advance an order end-to-end; invoice one; verify
   the running account moves correctly).
