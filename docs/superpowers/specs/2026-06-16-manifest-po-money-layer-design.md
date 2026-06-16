# Manifest — PO Money Layer (design)

> Spec date: 2026-06-16 (Session 145). Builds on the invoice-billing money model + order
> lifecycle engine. Adds per-PO money: draw-down → pool → allocate to a PO → multiple
> payments per PO → balance-due on the PO → stage-linked "due now" → container reassignment.
> The pooled LOT↔SF running account stays the cash truth; per-PO is a sub-ledger lens.

## 1. Goal
The logistics engine + cost capture is built; per-PO money is not. Money is only pool-level
(the LOT↔SF net). Add the per-PO layer so each PO shows **how much has been paid against it and
the balance still owed**, with a light advance/balance schedule tied to the journey stages, and
the ability to move a PO between containers.

## 2. Data model — two new sub-ledger tables (both additive, RLS, service_role)

### `manifest.po_allocations` — applies pool money to a PO
```sql
CREATE TABLE manifest.po_allocations (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      bigint NOT NULL REFERENCES manifest.orders(id) ON DELETE CASCADE,
  amount_inr    numeric NOT NULL,
  payment_id    bigint REFERENCES manifest.payments(id) ON DELETE SET NULL,  -- optional wire link
  allocated_date date NOT NULL DEFAULT current_date,
  note          text,
  created_by    uuid, created_by_name text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```
PO **paid = Σ amount_inr**; one PO has many; one wire (`payment_id`) can be split across POs.
A standalone allocation (no `payment_id`) earmarks pool money without a specific wire.

### `manifest.po_payment_schedule` — the light per-PO milestone plan (typically 2 rows)
```sql
CREATE TABLE manifest.po_payment_schedule (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES manifest.orders(id) ON DELETE CASCADE,
  seq         int NOT NULL DEFAULT 1,
  label       text NOT NULL,                 -- 'Advance' / 'Balance' / …
  pct         numeric,                        -- one of pct / amount_inr
  amount_inr  numeric,
  due_stage   text NOT NULL,                  -- pipeline stage key: placed / picked_up / docked / received …
  created_at  timestamptz NOT NULL DEFAULT now()
);
```
A `pct` milestone's due amount = `round(pct/100 × order.total_inr)` (recomputes as costs are entered).

## 3. Computed fields (worker)
On `getOrder` (and lighter on `getBootstrap`):
- `allocated` = Σ `po_allocations.amount_inr`
- **`balanceDue` = `total_inr` − allocated** (headline "balance still owed on this PO")
- `scheduledDueNow` = Σ schedule milestones whose `due_stage` is **reached** − allocated, clamped ≥ 0.
  "Reached" = `PIPELINE.indexOf(order.effectiveStage) ≥ PIPELINE.indexOf(due_stage)` (the 10-step
  pipeline from the lifecycle engine).
- `schedule[]` + `allocations[]` for the detail panel.

## 4. Pool relationship — NO double-count
Allocations are a **pure slice**: they attribute pool money to POs for the per-PO view and **do not
touch `running_account`** (net stays `+payments − orders.recognized_cost − sf_invoices.commission −
non-goods charges + ledger`). Pool = aggregate LOT↔SF cash truth; per-PO balance-due = per-order
settlement lens. Their sums needn't match (the pool also carries commission/lien). The shipped money
model is untouched.

## 5. Worker actions (manifestops)
- `allocateToPo(order_id, amount_inr, payment_id?, allocated_date?, note?)` — LOT finance (`payment_record`).
- `deleteAllocation(id)` — `payment_record`.
- `setPoSchedule(order_id, milestones[])` — replace the PO's schedule (`order_manage`/`payment_record`).
- `moveOrderToShipment(order_id, to_shipment_id)` — **container reassignment**: re-point the PO's
  `shipment_lines` to `to_shipment_id`; then re-run the shipped/received rollup on both old + new
  shipments' orders (an order with no legs reverts toward its production stage is out of scope — moving
  keeps ≥1 leg; if `to_shipment_id` is null/none we detach → status back to `picked_up`).
- `getOrder` / `getBootstrap`: add `allocated` / `balanceDue` / `scheduledDueNow` (+ `schedule`/
  `allocations` on detail).
- Wire existing `createDrawdown` (anyone with access: `sf_drawdown_raise`/`drawdown_manage`) and
  `recordPayment` into the UI.

## 6. UI (apps/manifest)
- **Order Detail → new "Payments & balance" card:** landed total · schedule (Advance/Balance + due-stage
  chips) · **allocated** · **Balance due** (large) · a **"due now"** highlight when a milestone stage is
  reached · allocations list · **Allocate** action (amount + optional wire link + note) · **Set schedule**
  (advance %/amount @ stage + balance @ stage). Plus a **"Move to another container"** control on each
  shipment leg (pick a target shipment).
- **Draw-downs screen:** wire the **Raise Draw-down** form → `createDrawdown` (currently a stub); list already exists.
- **Payments screen:** a **Record wire** action (`recordPayment`) + show which PO(s) a wire is allocated to.
- **Orders list / Dashboard:** a **Balance-due** column / KPI so outstanding-per-PO is visible at a glance.

## 7. Migration (`manifest_po_money_layer_v1`)
Add the two tables (RLS on, `GRANT ALL TO service_role`, FK indexes on `order_id`). Additive — no
backfill (existing POs start with no schedule / no allocations → balance due = full landed). Reversible.

## 8. Out of scope (later)
- Allocation reconciliation vs the pool net (a report that ties Σ per-PO balances to the pool).
- Auto-creating a schedule on order create (v1 = set per PO).
- Per-line allocation; multi-currency allocation; payment approval workflow.

## 9. Build sequence
1. Migration (two tables).
2. Worker: allocate/deleteAllocation/setPoSchedule/moveOrderToShipment + getOrder/getBootstrap fields;
   confirm createDrawdown/recordPayment. Deploy.
3. UI: Order Detail money card + container-move; Draw-down form; Payments record-wire; balance-due column.
4. Build clean; live-smoke (set a schedule, allocate a payment, watch balance due + due-now; move a PO between containers).
