# Snorkel — Offline Sales Orders module (GT / MT) — Design

> Status: APPROVED (brainstorm 2026-06-03, Session 98). Build with full autonomy per Afshaan.
> System: Snorkel (`snorkelops` + `apps/snorkel`). Cross-system touch: minimal, into Redline's `store.dispatch_shipments`.

## 1. Problem

LOT's Sales team runs an **Offline Sales** channel covering **General Trade (GT)** and **Modern
Trade (MT)** — a field team builds relationships with stores/distributors across states and books
orders from them. Today there is no system for this. They need a single module that is the
**system of record for the offline sale**, covering:

1. **Order capture & tracking** — book a partner's order, track its state.
2. **Fulfilment hand-off** — the order must reach the dispatch team so they can ship it, and the
   sales team must be able to see, at a glance, whether an order is *pending / in progress /
   fulfilled* — without touching dispatch internals.
3. **GST invoicing** — generate a compliant tax invoice (the amount the partner owes).
4. **Payments & collections** — partners pay on credit (typically **45 days from delivery**, but
   it varies per partner). Track part-payments, running balance, due dates, and surface overdue
   orders so someone can chase collection.

Scope: the **offline channels only** — GT, MT, and any other offline channel added later. Online
(D2C/Ecom) is out of scope.

## 2. Architecture & boundary

```
SNORKEL (snorkelops + apps/snorkel)            REDLINE (lotopsproxy + apps/redline)
─────────────────────────────────             ────────────────────────────────────
• Sales channel master (GT/MT/…)               • Existing Shipments tab
• Partner master                               • Works the auto-created shipment
• Sales Order capture (Draft)                    exactly as today (allocate, pack, ship)
• Confirm  ── inserts dispatch_shipments ──▶   • Records a DELIVERY DATE on the shipment
• GST invoice generation                       • (no knowledge of sales orders needed beyond
• Payments / collections                         showing the linked order_no)
• READS the linked shipment for status/dates ◀──── store.dispatch_shipments (status,
                                                          shipped_at, delivery_date)
        │                                                        │
        └──────────────────────  store schema  ─────────────────┘
           sales_channels · sales_partners · sales_orders
           sales_order_lines · sales_payments
           (+ 3 new columns on dispatch_shipments)
```

**Decisions (locked):**

- **All data lives in `store`** — no new schema (avoids the PostgREST "exposed schemas" step;
  matches Snorkel's locked "data stays in store, multiple workers operate on the same rows"
  decision). RLS-on / `service_role`-only on every new table.
- **Write-ownership is split, no shared-write race:**
  - Snorkel owns everything on `sales_*` tables, and performs the **one-time INSERT** of the
    dispatch shipment + its lines on Confirm.
  - Redline owns the shipment's lifecycle thereafter (allocate/pack/ship) and writes only the
    new `delivery_date`. It never touches the `sales_*` tables.
  - Snorkel **reads** the linked `dispatch_shipments` row to derive fulfilment status + dates.
- **No cross-worker calls.** snorkelops is `service_role`; it inserts into and reads from
  `store.dispatch_shipments` directly (same pattern as every other Snorkel read of `store`).
- **One record, evolving status** for the order (not a request→PO split). The Confirm gate is a
  status transition on the same row, not a second entity.

## 3. Data model (all in `store`, RLS-on / service_role-only)

### 3.1 `sales_channels` (managed picklist)
| col | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `channel_key` | text unique | e.g. `GT`, `MT` |
| `label` | text | "General Trade", "Modern Trade" |
| `dispatch_channel_id` | uuid null | → `store.dispatch_channels.id`; which dispatch channel the auto-shipment is created under |
| `is_active` | bool default true | |
| `sort_order` | int default 0 | |
| `created_at` / `updated_at` | timestamptz | |

Seed: `GT` / `MT` (active). `dispatch_channel_id` mapped at build to the existing **Offline**
dispatch channel (verify `store.dispatch_channels` live; if GT/MT need distinct dispatch channels,
map each — else both point at the one Offline channel).

### 3.2 `sales_partners` (partner master)
| col | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `partner_code` | text unique | `SP-NNNN` via `store.sequences` key `sales_partner`, padStart(4) |
| `name` | text not null | |
| `channel_key` | text | default channel (GT/MT), soft ref to `sales_channels` |
| `partner_type` | text null | optional free label (distributor/retailer/chain) |
| `gstin` | text null | drives nothing structurally; printed on invoice |
| `state` | text | Indian state — **drives intra/inter-state GST** (place of supply) |
| `city` | text null | |
| `pincode` | text null | |
| `billing_address` | text null | multi-line |
| `shipping_address` | text null | multi-line (falls back to billing if empty) |
| `contact_person` | text null | |
| `phone` | text null | |
| `email` | text null | |
| `default_credit_days` | int default 45 | auto-fills onto new orders, overridable |
| `is_active` | bool default true | |
| `notes` | text null | |
| `created_by` / `created_at` / `updated_at` | | |

### 3.3 `sales_orders`
| col | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `order_no` | text unique | `SO-NNNN` via `store.sequences` key `sales_order`, padStart(4) |
| `partner_id` | uuid | → `sales_partners` |
| `channel_key` | text | copied from partner, overridable |
| `order_date` | date default today | |
| `status` | text | CHECK `('draft','confirmed','cancelled')` |
| `credit_days` | int | defaults from partner, overridable |
| `partner_po_ref` | text null | partner's own PO number, optional |
| `expected_dispatch_date` | date null | requested by sales, informational |
| `notes` | text null | |
| `subtotal` | numeric(14,2) | Σ line taxable value — maintained by worker on line writes |
| `tax_total` | numeric(14,2) | Σ line GST — maintained by worker |
| `grand_total` | numeric(14,2) | subtotal + tax_total — maintained by worker |
| `dispatch_shipment_id` | uuid null | set on Confirm; the linked `store.dispatch_shipments.id` |
| `invoice_no` | text null | minted on Generate Invoice |
| `invoice_date` | date null | |
| `invoice_generated` | bool default false | once true → lines frozen |
| `place_of_supply` | text null | snapshot of partner state at invoice time |
| `amount_received` | numeric(14,2) default 0 | maintained by worker from `sales_payments` |
| `payment_status` | text default 'unpaid' | `('unpaid','partial','paid')` — maintained by worker |
| `created_by` / `created_at` | | |
| `confirmed_by` / `confirmed_at` | | |
| `cancelled_by` / `cancelled_at` / `cancel_reason` | | |
| `updated_at` | | |

**Not stored here (read live from the linked shipment):** fulfilment status, dispatch date,
delivery date, due date. See §5.

### 3.4 `sales_order_lines`
| col | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `order_id` | uuid | → `sales_orders` ON DELETE CASCADE |
| `product` | text | product code/name (from `product_master`) |
| `model` | text null | variant model — needed to seed the dispatch shipment line |
| `color` | text null | variant colour — seeds shipment line |
| `sku` | text null | EAN/SKU if known |
| `hsn_code` | text null | required before invoice for GST |
| `description` | text | line description (defaults from product) |
| `qty` | int | |
| `rate` | numeric(12,2) | per-unit, pre-tax |
| `discount_pct` | numeric(5,2) default 0 | optional |
| `gst_pct` | numeric(5,2) default 0 | e.g. 18 |
| `taxable_value` | numeric(14,2) | qty×rate×(1−disc%) — maintained by worker |
| `gst_amount` | numeric(14,2) | taxable×gst% — maintained by worker |
| `line_total` | numeric(14,2) | taxable + gst — maintained by worker |
| `sort_order` | int | |

CGST/SGST vs IGST split is computed at invoice/print time from `place_of_supply` vs seller state
(not stored per-line; `gst_amount` is the total tax for the line).

### 3.5 `sales_payments` (collections / receipts)
| col | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `order_id` | uuid | → `sales_orders` ON DELETE CASCADE |
| `amount` | numeric(14,2) | |
| `received_date` | date | |
| `mode` | text | `('bank','upi','cheque','cash','other')` |
| `reference` | text null | UTR / cheque no |
| `note` | text null | |
| `recorded_by` / `created_at` | | |

On insert/delete the worker recomputes `sales_orders.amount_received` + `payment_status`.

### 3.6 `dispatch_shipments` — 3 new columns (shared Redline table)
- `sales_order_id uuid null` — link back to the originating order.
- `sales_order_no text null` — denormalised for display in the dispatch UI (no join needed).
- `delivery_date date null` — recorded by the dispatch team after the goods arrive.

These are additive + nullable → zero impact on existing dispatch/ecom flows.

### 3.7 Sequences (`store.sequences`)
- `sales_partner` → `SP-NNNN`
- `sales_order` → `SO-NNNN`
- `sales_invoice_<FY>` → GST-continuous per Indian FY (Apr–Mar). Format: **`LOT/SL/<YY-YY>/NNNN`**
  (e.g. `LOT/SL/26-27/0001`). FY derived from `invoice_date` (≥ Apr → that year, else prior).

## 4. Order lifecycle

```
            ┌─────────── cancel (reason) ──────────┐
            ▼                                       │
        [ draft ] ── confirm ──▶ [ confirmed ] ─────┘
            │                        │
        (edit lines)          inserts dispatch_shipments(draft)
                                     │
                            Generate Invoice (any time after confirm)
                                     │  → mints invoice_no, freezes lines
                                     ▼
                          dispatch team works the shipment in Redline
                          → shipped_at set, delivery_date recorded
                                     │
                          collections (sales_payments) until paid
```

- **Confirm** (`confirmOrder`, perm `sales_order_confirm`): `draft → confirmed`. Validates ≥1 line.
  **Inserts** one `dispatch_shipments` row (status `draft`, `channel_id` = the channel's mapped
  dispatch channel, `title` = `<order_no> · <partner name>`, `scheduled_date` = expected dispatch
  date or today, `created_by`, `expected_units` = Σ qty, `sales_order_id`, `sales_order_no`) +
  one `dispatch_shipment_lines` row per order line (`product`, `model`, `color`, `target_qty`=qty,
  `packed_qty`=0). Stamps `sales_orders.dispatch_shipment_id`. The shipment now appears in Redline's
  Shipments tab.
- **Cancel** (`cancelOrder`, perm `sales_order_manage`, reason required): allowed from `draft` or
  `confirmed`. If a linked shipment exists and is still `draft`/`packing` (not yet shipped), cancel
  it too (set `dispatch_shipments.status='cancelled'`). If the shipment is already `shipped`, block
  cancel (goods are out — must be handled as a return, out of v1 scope).
- **Generate Invoice** (`generateInvoice`, perm `sales_order_manage`): allowed on a `confirmed`
  order with HSN populated on every line. Mints `invoice_no` from the FY sequence, sets
  `invoice_date`=today, `place_of_supply`=partner state, `invoice_generated=true`. Lines become
  read-only. Re-generation blocked (one invoice per order in v1 — see §8).

## 5. Fulfilment status (read-only, derived from the shipment)

Snorkel never stores fulfilment state. On every order read, snorkelops joins the linked
`dispatch_shipments` (by `dispatch_shipment_id`) and derives:

| shipment.status | sales-facing `fulfilment_status` |
|---|---|
| (no shipment / not confirmed) | `not_dispatched` |
| `draft` | `pending` |
| `packing`, `ready` | `in_progress` |
| `shipped` | `fulfilled` |
| `cancelled` | `cancelled` |

- `dispatch_date` = `dispatch_shipments.shipped_at`
- `delivery_date` = `dispatch_shipments.delivery_date`
- **`due_date` = COALESCE(delivery_date, dispatch_date) + credit_days`** — null until dispatched.
- **overdue** = `grand_total/invoice_value − amount_received > 0` AND `due_date < today`.

The sales team sees only the simple `fulfilment_status` label; nothing about boxes/scans.

## 6. GST invoicing

- **Seller** = LOT's GST entity from `store.company_addresses` (registered office row + its GSTIN).
  Seller state derived from that GSTIN/address (Karnataka). Pulled live (never hardcoded — same
  precedent as PO/challan prints, RULE-GP-001 #7).
- **Place of supply** = partner state (`sales_orders.place_of_supply` snapshot).
- **Tax split:** partner state == seller state → **intra-state** → CGST = SGST = gst%/2 each;
  else → **inter-state** → IGST = gst%.
- **Invoice number:** continuous per Indian FY from `store.sequences` (§3.7).
- **Invoice print page** (`/sales/orders/invoice` print route): seller block (name/GSTIN/address),
  invoice no + date, Bill-To + Ship-To (partner) with GSTIN, place of supply; line table
  (Sl / Description / HSN / Qty / Rate / Taxable / [CGST% amt + SGST% amt] or [IGST% amt] / Amount);
  totals; amount in words; declaration + signature block. Reuse the PO print HTML/CSS pattern
  (`apps/snorkel` print styles + `poTax.js`).
- **Deferred (NOT v1):** e-invoice IRN + QR (GSP integration), e-way bill, credit notes / sales
  returns, TCS, multi-invoice per order, rounding-off line. Noted as future phases.

## 7. Permissions (Snorkel layer — new keys on `snorkel_roles`)

New boolean keys (added to the `/admin/roles` matrix + worker `canX` gates + nav):
- `sales_view` — read orders / partners / collections / invoices.
- `sales_order_manage` — create/edit/cancel draft orders, generate invoice.
- `sales_order_confirm` — confirm an order (commits it to dispatch). Auto-implies `sales_view`.
- `sales_payment_manage` — record/edit collection receipts.
- `sales_partner_manage` — manage partner master + sales channels.

Seeded role presets (additive — does not disturb existing procurement roles):
- New **`sales_rep`** role: `sales_view` + `sales_order_manage`.
- New **`sales_manager`** role: all five sales keys.
- `admin` (is_system) already implies everything via `snorkel_admin`.

Booking an order needs at least `sales_order_manage`; viewing needs `sales_view`. Elevated keys
force `sales_view` in the UI (same footgun guard as Podium/Snorkel admin).

**Redline side:** the new `delivery_date` capture is gated by the existing dispatch gate
(`dispatch_pack` / floor) — no new Redline permission.

## 8. App surface

### apps/snorkel — new `SALES` nav group (gate `sales_view`)
- `/sales/orders` — list: filters (status, channel, partner, fulfilment, payment/overdue), search,
  CSV export. KPI tiles (open orders, value to dispatch, overdue collections ₹, this-FY sales).
- `/sales/orders/new` — partner picker (auto-fills channel + credit_days + state), order lines
  (product picker from product catalogue → model/color/sku/hsn/description, qty, rate, disc%, gst%),
  live totals.
- `/sales/orders/detail` — header + lines; **inline edit while draft**; Confirm button; Generate
  Invoice button; fulfilment status badge (read from shipment) + dispatch/delivery dates + due date;
  **Payments tab** (record receipt, list receipts, running balance, overdue badge); invoice print
  link once generated; cancel (reason).
- `/sales/orders/invoice` — GST tax-invoice print route (§6), auto-print.
- `/sales/partners` — list + search + CSV.
- `/sales/partners/new` + `/sales/partners/detail` — partner master CRUD.
- `/sales/collections` — collections queue: all orders with balance > 0, sorted by due date /
  overdue first; per row: partner, invoice, grand total, received, balance, due date, days overdue;
  record-payment action inline. (Reads the same orders; a focused lens for the collections role.)
- `/sales/settings` — manage sales channels (label / active / dispatch-channel mapping). Gate
  `sales_partner_manage` (or admin).

Shared: `src/lib/sales.js` (constants: statuses, payment modes, fulfilment-label map, GST split
helper, FY helper), reuse `src/lib/snorkelui.js` styles, `useProducts.js` for the product picker.

### apps/redline — minimal additions to the existing Shipments tab
- Show a `sales_order_no` badge/link on shipments that carry one.
- A **"Delivery date"** date input on the shipment detail (visible once `shipped`), saving via the
  existing `updateShipment` action extended to accept `delivery_date`.

### lotopsproxy (`01_worker/worker.js`) — minimal
- Extend `updateShipment` to accept/persist `delivery_date` (and ignore-safely the new columns).
- `getDispatchShipments` already `select=*` → returns the 3 new columns automatically.
- No new dispatch creation action (snorkelops inserts the shipment directly).

### snorkelops (`05_Throttle/snorkelops-worker/src/index.js`) — new actions
- **Reads (GET):** `getSalesOrders` (list + joins shipment for fulfilment + computes due/overdue +
  payment rollup), `getSalesOrder` (detail incl. lines + payments + shipment), `getSalesPartners`,
  `getSalesPartner`, `getSalesChannels`, `getSalesCollections` (balance>0 lens),
  `getSalesInvoiceData` (print payload incl. seller block + tax split).
- **Writes (POST):** `createSalesOrder`, `updateSalesOrder` (draft only; recomputes totals),
  `confirmOrder` (→ inserts shipment+lines), `cancelOrder`, `generateInvoice`,
  `recordSalesPayment`, `deleteSalesPayment`, `createSalesPartner`, `updateSalesPartner`,
  `createSalesChannel`, `updateSalesChannel`.
- All POSTs gated per §7; reads gated on `sales_view`.

## 9. Out of scope (v1)

Returns / credit notes; e-invoice IRN + QR; e-way bill; partial-dispatch / multi-invoice per order;
price lists per channel/partner (manual rate for now); TCS; partner credit-limit enforcement;
notifications (Slack/email on overdue) — all deferred to later phases.

## 10. Cross-system change summary (honours "keep to Snorkel")

| Repo | Change | Size |
|---|---|---|
| Supabase migration | 5 new `sales_*` tables + 3 cols on `dispatch_shipments` + 2 seq seeds + RLS + grants + perm-key seed | one migration |
| `snorkelops-worker` | all sales actions (the bulk of the build) | large |
| `apps/snorkel` | SALES module pages + lib | large |
| `01_worker` (lotopsproxy) | `updateShipment` accepts `delivery_date` | ~5 lines |
| `apps/redline` | show `sales_order_no`, delivery-date input on shipment detail | small |

Commits: Snorkel repos carry the module; the lotopsproxy + redline diffs are the only non-Snorkel
commits, kept as small as possible.
