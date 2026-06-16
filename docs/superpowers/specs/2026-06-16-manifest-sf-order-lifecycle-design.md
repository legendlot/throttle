# Manifest — SF-side order lifecycle (the "one smooth flow")

> Design spec. Status: **APPROVED, pre-build** (brainstormed + signed off 2026-06-16).
> Builds on the S140 schema, S144 lifecycle engine + invoice-billing model, and S145 PO money layer.
> Next step: run `writing-plans` off this spec to produce the phased implementation plan.

## Context & goal

Manifest is a shared LOT↔Solve Factory (SF) China-import OS. Today an "order"
(`MF-NNNN`) is created in Manifest, runs a two-axis lifecycle (status + cost_state),
projects into Snorkel as a China PO, and is invoiced LOT-side via `invoiceOrder`
(auto-VWINV + 2.5% commission), with a per-PO money layer (`po_allocations` /
`po_payment_schedule`).

This spec reframes that into **one continuous, party-owned lifecycle** that mirrors
how the LOT↔SF import process actually runs on the ground: **LOT requests → SF builds
the PO and drives it to the vendor → vendor PI is attached → SF ships it (one or more
independent shipments) → costs fall due per shipment as it lands → SF invoices LOT to
close (partial invoicing allowed).** The system should be **as live/real-time as
possible**, auto-stamping dates where it can; manual stages are expected to be loose
and that is acceptable.

Two-sided system: **SF owns the whole lifecycle after the request; LOT creates the
request and funds the pool.**

## The flow, end to end

| # | Step | Actor | Effect |
|---|------|-------|--------|
| 0 | **Request** | LOT | Raw order request recorded. `status='requested'`. |
| 1 | **Convert to PO** | SF | SF claims the request, fills real PO detail (vendor, ¥ prices, terms) → `status='draft'`, editable by SF. |
| 2 | **Place** | SF | `status='placed'`. **Download PO PDF** unlocks. SF sends the PDF to the vendor. |
| 3 | **PI attached** | SF | SF uploads the vendor's PI (any file) → stored in `manifest-docs` + logs a timestamped `pi_attached` stage-event (shows in the order timeline). Evidence only; never generated. Soft, not gated. |
| 4 | **Shipment + expected dates** | SF | SF allocates items (or whole POs) to a shipment, sets expected milestone dates. A PO may split across several shipments; each shipment is its own journey. |
| 5 | **Actuals** | SF | SF advances real shipment milestones (loaded → sailing → docked → cleared → local_transport → received); each auto-stamps date/time. |
| 6 | **Costs due** | SF | On arrival/clearance SF enters that shipment's shipping/customs/other-fees. System runs a **pool-sufficiency check**; if short, offers **Raise Draw-down**. |
| 7 | **Invoice & close** | SF | SF ticks which goods lines to bill → GST auto on that amount → optional commission → invoice (auto-VWINV). `partially_invoiced` until all goods lines billed, then `invoiced` (closed). Auto-allocate the due amount from the pool if none yet. |

## 1. Order states & ownership

- `orders.status` gains **`requested`** as the new initial state (before `draft`).
  Pipeline: `requested → draft → placed → confirmed → produced → picked_up →
  shipped → received` (+ `cancelled`). The timeline UI still begins at `placed`
  (requested/draft are pre-timeline editing states).
- `orders.cost_state` gains **`partially_invoiced`** between `delivered` and
  `invoiced`. Axis: `in_flight → delivered → partially_invoiced → invoiced`.
- **Convert to PO**: new worker action `convertToPo(order_id)` — moves a
  `requested` order to `draft` and (re)assigns SF ownership. Only SF may convert.
- **Ownership / permissions** (party-aware, on top of the existing `manifest_roles`
  party tag):
  - **LOT**: create the request (`order_manage` reframed; or a dedicated
    request-create), fund the pool (LOT finance records wires), view everything.
  - **SF**: convert, edit PO, place, advance all stages, create/allocate shipments,
    enter shipment costs, attach PI, invoice/close.
  - New SF permission keys: **`sf_po_manage`** (convert/edit/place/advance/shipments/
    costs) and **`sf_invoice_create`** (invoice/close). Existing LOT finance keys
    (`payment_record`, `charge_manage`, etc.) retained; `invoiceOrder` becomes
    callable by SF (`sf_invoice_create`) as well as LOT finance.
  - Seeded `sf_owner` role gets `sf_po_manage` + `sf_invoice_create` added.

## 2. PO document (PDF)

- On `placed`, a **Download PO PDF** action appears on the order.
- **Placeholder format now** (clean vendor-facing PO: header, vendor, order no, line
  items with ¥ pricing, terms, totals); SF's preferred format folded in later.
- **Architecture:** Manifest's Pit Wall is an SPA (`/` + `/login` only). Add a
  **dedicated static print route** (e.g. `/doc?type=po&id=<order_id>`) that renders a
  B/W printable HTML doc and auto-`window.print()`s — mirroring the Snorkel
  `/invoice` pattern (`apps/snorkel/src/app/(auth)/sales/orders/invoice/page.js`).
  The route fetches its own data via a worker getter (e.g. `getPoDocData`). This same
  print-route mechanism is reused later for the Reports tab (separate spec).

## 3. PI milestone

- SF uploads the vendor PI via the existing two-phase doc upload
  (`createDocumentUploadUrl` → `recordDocument`, `doc_type='pi'`, `order_id` FK,
  bucket `manifest-docs`).
- On record of a `pi` doc against an order, **also** write a `pi_attached`
  `stage_events` row (timestamped) so it appears in the order timeline/history.
- **Generalize**: a small map `DOC_TYPE_MILESTONE = { pi: 'pi_attached', ... }` so
  future doc types (BL, packing list) can also log milestones. v1 wires PI only.

## 4. Shipments (independent journeys)

- A shipment = one physical container, its own schedule/dates. Existing `shipments`
  + `shipment_lines` (qty-level junction) already model this; `shipments.status`
  pipeline `planned → loaded → sailing → docked → cleared → local_transport →
  received` and the 9 milestone dates already exist.
- **Item allocation**: SF allocates individual line items (or a whole PO) to a
  shipment. **Typical case: one PO → one shipment; a shipment commonly carries
  multiple POs.** A PO may also split across shipments.
- **Move between shipments**: allowed while the shipment is `planned`/`loaded`.
  **Locks at departure (`status='sailing'`)** — once it sails, its manifest is
  frozen (no add/remove/move). Extend the S145 `moveOrderToShipment` into
  item-level `allocateItemsToShipment` / `moveItemsBetweenShipments` with the
  sailing-lock guard on both source and target.
- **Expected dates** are set on the shipment (per milestone) and feed the timeline
  as planned targets.
- **Shipment costs** (new columns): `shipping_inr`, `customs_inr`, `other_fees_inr`
  (+ optional `cost_notes`), **manually entered by SF** (actuals, around arrival).
  Default `due_stage` = arrival/clearance (`docked`/`cleared`).

## 5. Money — two streams

The single LOT↔SF pool (`running_account`, RULE-MANIFEST-001) stays the truth. Two
cost streams feed it:

1. **Goods** → recognized via the **SF invoice** (§6). Drives `recognized_cost` +
   commission (existing running-account inputs).
2. **Shipping/customs/other-fees** → per shipment, recognized as a **charge** on
   **arrival/clearance**. Pro-rated across the POs on that shipment **by goods
   value**, and the per-order computed share rolls up onto the order (a computed
   `landed_freight_share` for display + the order's landed total). The pool is
   debited as these charges are recognized.

**Pool-sufficiency nudge:** when SF enters a shipment's costs (or a goods cost falls
due), compute available pool (running-account net less already-allocated/committed);
if it can't cover the due amount, surface **Raise Draw-down** (existing
`createDrawdown`, `sf_drawdown_raise`). The nudge is a funding prompt, **not** a
pay-now gate.

## 6. Invoice & close (partial invoicing)

- SF opens **Invoice** on a not-fully-invoiced order → a form listing the order's
  **goods line items** (products with a purchasing cost) with their amounts.
- SF **ticks which products to bill** (partial allowed). SF **cannot** toggle GST —
  **GST is auto-applied** on the ticked amount (**18% default, editable per invoice**
  via an explicit rate field). SF **can** toggle **SF commission** (2.5%) on/off.
- Submitting:
  1. Creates an invoice — **auto VWINV** number (reuse `nextInvoiceNo()` / the
     `VWINV-<FY>00<N>` series; never typed).
  2. Stamps each billed `order_lines` row with the `invoice_no` (a line is billed
     once). `gst_percent` stored per line/invoice.
  3. Invoice total = ticked goods value + GST(rate) on it + (commission if ticked).
  4. Order → `partially_invoiced`; when **all** goods lines carry an `invoice_no`,
     → `invoiced` (closed).
  5. **Auto-allocate**: if the order has **no `po_allocations` yet**, create an
     allocation for the **amount due** of what was just invoiced (so the PO
     balance-due clears). Reuses the S145 `po_allocations` layer.
- Rewrite `invoiceOrder` to accept a **line selection + gst_percent + include_commission**
  and support multiple invoices per order; the current whole-order behaviour becomes
  the "all lines ticked" case. Keep auto-VWINV + the SF-invoice/commission accrual.

## 7. Timeline (planned vs actual)

Each pipeline step shows its **expected date** (from the shipment's expected
milestone dates) as a faint target **and** the **actual stamp** once that stage is
advanced (from `stage_events.occurred_at`). This supersedes the interim S-prev
created_at/invoice_date fallbacks for shipment-driven stages while keeping them for
the order-half (placed). Delivers the "timeline should show date stamps wherever
applicable" requirement with planned-vs-actual.

## 8. Data-model changes (all additive; existing data grandfathered)

- `orders.status` CHECK: add `requested`. `orders.cost_state` CHECK: add
  `partially_invoiced`.
- `order_lines`: add `invoice_no text` (nullable, which invoice billed it) +
  `gst_percent numeric` (per-line GST used).
- `shipments`: add `shipping_inr`, `customs_inr`, `other_fees_inr numeric`,
  `cost_notes text`, `due_stage text` (default `cleared`).
- New SF role keys `sf_po_manage`, `sf_invoice_create` (+ grant to `sf_owner`).
- **Grandfathering**: the FY2026-27 seed (orders carry order-level
  `shipping_inr`/`customs_inr`; net **−₹34,81,246**) is **not** retroactively
  migrated — those orders keep their stored totals and the new shipment-cost model
  applies **forward** to new orders/shipments. The running-account reconciliation
  must remain unchanged after this build. Verify the net is still −₹34,81,246 after
  migration.

## Worker actions (new / changed) — `manifestops`

- `convertToPo(order_id)` — `requested → draft`, SF-owned (`sf_po_manage`).
- `getPoDocData(order_id)` — data for the PO PDF print route.
- `recordDocument` — extend to log a `pi_attached` (and future) `stage_events` row
  when a milestone doc type is recorded.
- `allocateItemsToShipment` / `moveItemsBetweenShipments` — item-level, sailing-lock
  guarded (extends `moveOrderToShipment`).
- `setShipmentCosts(shipment_id, shipping_inr, customs_inr, other_fees_inr, notes)` —
  SF-entered; recognizes charges on arrival; pro-rates to POs by goods value;
  returns a pool-sufficiency result (+ shortfall for the drawdown prompt).
- `invoiceOrder` rewrite — line selection + `gst_percent` (default 18, editable) +
  `include_commission`; partial invoicing; auto-VWINV; line stamping;
  `partially_invoiced`/`invoiced` transition; auto-allocate due if none.
- `getBootstrap`/`getOrder` upgrades — expose `requested`/`partially_invoiced`,
  per-line `invoice_no`, shipment costs + computed order freight share, expected vs
  actual timeline stamps, pool-available for the nudge.

## Build phases (one spec, staged delivery)

1. **States + convert + permissions** — `requested`, `partially_invoiced`, `convertToPo`, SF keys, party-aware gates.
2. **PO PDF + PI milestone** — print route + `getPoDocData`; PI upload → `pi_attached` stage-event.
3. **Shipment cost model + item allocation/move/lock** — shipment cost columns, item-level allocate/move, sailing-lock, by-value pro-rate + order roll-up.
4. **Per-shipment dues + pool-check/drawdown nudge** — arrival-triggered charge recognition + pool-sufficiency → Raise Draw-down.
5. **Partial invoicing** — line-selection invoice form, GST (18% editable) + optional commission, partial/close transitions, auto-allocate.

## Open items / assumptions (confirm at build time)

- Shipment-cost pro-rate basis = **goods value** of each PO's items on the shipment (agreed).
- Goods invoicing is **not hard-gated** to arrival (SF invoices at close; typically after receipt). Confirm if a gate is wanted.
- PO PDF format is a **placeholder**; swap in SF's real layout when provided.
- Reports tab + running-account statement (downloadable report) is a **separate spec** — explicitly out of scope here.
- v2 landed cost-per-unit (allocate shipment charges to per-unit CPU → standard cost) remains a later, separate build; this spec stops at order-level freight share.
