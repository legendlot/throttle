# Manifest — SF-side order lifecycle (the "one smooth flow")

> Design spec. Status: **APPROVED, pre-build** (brainstormed + signed off 2026-06-16;
> **revised 2026-06-17** with Afshaan's 10-point feedback — money model flipped to
> payment-driven, Snorkel projection decoupled, cancellation rule, per-line GST,
> immutable original plan dates, full timestamped history on orders + shipments).
> Builds on the S140 schema, S144 lifecycle engine, and S145 PO money layer.
> Next step: run `writing-plans` off this spec to produce the phased implementation plan.

## Context & goal

Manifest is a shared LOT↔Solve Factory (SF) China-import OS. This spec reframes the
order into **one continuous, party-owned lifecycle** that mirrors how the import process
actually runs on the ground: **LOT requests → SF builds the PO and drives it to the
vendor → vendor PI is attached → SF ships it (one or more independent shipments) → SF
pays vendor + logistics out of the pool as each stage happens → SF invoices LOT to close
the order.** The system should be **as live/real-time as possible**, auto-stamping dates
where it can; manual stages are expected to be loose and that is acceptable.

Two-sided system: **SF owns the whole lifecycle after the request; LOT creates the
request and funds the pool.**

**Design north star (Afshaan, point 9): keep it as simple as possible.** Every section
below was reviewed against that — see §12 Simplicity review. We deliberately reuse what
already exists (payments, charges, append-only history) instead of adding parallel
machinery.

## The flow, end to end

| # | Step | Actor | Effect |
|---|------|-------|--------|
| 0 | **Request** | LOT | Raw order request recorded. `status='requested'`. |
| 1 | **Convert to PO** | SF | SF claims the request, fills real PO detail (**vendor + vendor's product codes**, ¥ prices, terms) → `status='draft'`, editable by SF. |
| 2 | **Place** | SF | `status='placed'`. **Download PO PDF** unlocks (vendor-facing, in vendor codes). SF sends it to the vendor. |
| 3 | **PI attached** | SF | SF uploads the vendor's PI → stored + a timestamped `pi_attached` event on the order timeline. Evidence only; never generated. |
| 4 | **Advance paid** | SF | After PI, SF pays the vendor advance from the pool → recorded as a payment, **deducts the pool**. |
| 5 | **Confirm → produce → pick up** | SF | SF advances production milestones (each auto-stamped). At pickup, SF pays any **pickup balance / extra services** → deducts the pool. Goods purchase is now wrapped up. **Order is cancellable up to here, not after pickup.** |
| 6 | **Shipment + dates** | SF | SF allocates items (or whole POs) to a shipment, sets expected milestone dates (**the first plan is kept as a permanent record**). A PO may split across shipments; each shipment is its own journey. |
| 7 | **Sail → dock → clear** | SF | SF advances real shipment milestones (loaded → sailing → docked → cleared → local_transport → received); each auto-stamps date/time. At port clearance SF enters + pays **shipping / customs / other fees** → deducts the pool. |
| 8 | **Last-mile delivery** | SF | Port → warehouse fee entered + paid → deducts the pool. Order couples to `delivered`. |
| 9 | **Invoice & close** | SF | SF ticks which goods lines to bill → **per-line GST** → optional 2.5% commission → invoice (auto-VWINV). Closeout record. `partially_invoiced` until all goods lines billed, then `invoiced`. |

## 1. Order states, ownership & cancellation

- `orders.status` pipeline: `requested → draft → placed → confirmed → produced →
  picked_up → shipped → received` (+ `cancelled`, + `delivered` coupling on last-mile).
  New initial state **`requested`**. The timeline UI begins at `placed` (requested/draft
  are pre-timeline editing states).
- `orders.cost_state` gains **`partially_invoiced`** between `delivered` and `invoiced`.
  Axis: `in_flight → delivered → partially_invoiced → invoiced`.
- **Convert to PO**: new worker action `convertToPo(order_id)` — `requested → draft`,
  (re)assigns SF ownership. Only SF may convert.
- **Cancellation (point 5):** an order/PO is **cancellable only up to and including
  `produced`** — i.e. any state in `{requested, draft, placed, confirmed, produced}`.
  **Once `picked_up` (or beyond), it is NOT cancellable** (goods are paid for and in
  transit). New action `cancelOrder(order_id, reason)` enforces this guard, logs a
  timestamped `cancelled` event, requires a reason. If the order already carries
  payments, cancellation does **not** auto-reverse them — those stay as pool debits and
  are reconciled manually (loose by design, point 4).
- **Ownership / permissions** (party-aware, on the existing `manifest_roles` party tag):
  - **LOT**: create the request, fund the pool (record LOT→SF wires), view everything.
  - **SF**: convert, edit PO, place, advance all stages, create/allocate shipments,
    record vendor + logistics payments, attach PI, invoice/close, cancel (≤ produced).
  - New SF permission keys: **`sf_po_manage`** (convert/edit/place/advance/shipments/
    payments/cancel) and **`sf_invoice_create`** (invoice/close). Seeded `sf_owner` gets
    both. Existing LOT finance keys retained.

## 2. Vendor-code POs + the Snorkel connector (DECOUPLED — point 2)

- The PO SF raises is **in the vendor's product codes**, not LOT's. Example: what LOT
  calls **Flare**, the vendor may invoice as **`820D`**. `order_lines` therefore carry the
  **vendor's product code + description** as entered by SF — they are NOT LOT
  `product_master` codes.
- **Consequence: a Manifest PO can NOT be directly projected into Snorkel anymore.** The
  S140 auto-projection (`projectToSnorkel`, RULE-MANIFEST-003) assumed Manifest order
  lines already spoke LOT product codes. That assumption is now broken.
- **A connector/mapping step is required (NOT designed in this spec — explicit TODO).**
  It will translate `vendor_code → LOT product_code` (a mapping table + a review/confirm
  UI) and only then project to Snorkel. Until that connector exists:
  - Manifest runs **standalone** on vendor codes for the full lifecycle.
  - The Snorkel projection is **switched off / parked** (do not auto-fire it on `placed`
    or `confirmed`). No half-mapped China POs land in Snorkel.
- Captured now to feed the future connector: `order_lines.vendor_code`,
  `order_lines.vendor_desc`, and an optional `order_lines.lot_product_code` (nullable —
  filled in later by the connector when a mapping is confirmed). v1 leaves
  `lot_product_code` null.

## 3. PO document (PDF)

- On `placed`, a **Download PO PDF** action appears on the order. Renders in **vendor
  codes** (it's the vendor-facing document).
- **Placeholder format now** (clean vendor-facing PO: header, vendor, order no, line items
  with ¥ pricing, terms, totals); SF's preferred format folded in later.
- **Architecture:** Manifest's Pit Wall is an SPA (`/` + `/login`). Add a **dedicated
  static print route** (e.g. `/doc?type=po&id=<order_id>`) that renders a B/W printable
  HTML doc and auto-`window.print()`s — mirroring the Snorkel `/invoice` pattern. The
  route fetches its own data via `getPoDocData`. Reused later for the Reports tab
  (separate spec).

## 4. PI milestone

- SF uploads the vendor PI via the existing two-phase doc upload
  (`createDocumentUploadUrl` → `recordDocument`, `doc_type='pi'`, `order_id` FK, bucket
  `manifest-docs`).
- On record of a `pi` doc, **also** write a `pi_attached` history event (timestamped) so
  it shows on the order timeline.
- **Generalize**: a small map `DOC_TYPE_MILESTONE = { pi: 'pi_attached', ... }` so future
  doc types (BL, packing list) can log milestones too. v1 wires PI only.

## 5. Shipments — independent journeys + immutable original plan (point 1)

- A shipment = one physical container, its own schedule/dates. Existing `shipments` +
  `shipment_lines` (qty-level junction) already model this; `shipments.status` pipeline
  `planned → loaded → sailing → docked → cleared → local_transport → received` and the 9
  milestone dates already exist.
- **Item allocation**: SF allocates individual line items (or a whole PO) to a shipment.
  **Typical case: one PO → one shipment; a shipment commonly carries multiple POs.** A PO
  may also split across shipments.
- **Move between shipments**: allowed while the shipment is `planned`/`loaded`. **Locks at
  departure (`status='sailing'`)** — once it sails, its manifest is frozen (no add/remove/
  move). Extend `moveOrderToShipment` (S145) into item-level `allocateItemsToShipment` /
  `moveItemsBetweenShipments` with the sailing-lock guard on both source and target.
- **Immutable original planned dates (point 1):** when SF first sets a shipment's expected
  milestone dates, that first plan is captured as a **permanent, write-once record** and is
  **never overwritten**. SF may *revise* expected dates later; every revision is recorded in
  the shipment's timestamped history (§7), and the original remains queryable forever.
  - **Implementation (simplest — leans on §7's append-only history):** the shipment's
    milestone date columns hold the **current (revisable) plan**; the **original plan** is the
    **first `dates_planned` history event** (immutable by construction — history is
    append-only); each revision logs a `dates_revised` event; **actuals** come from the
    `stage_advanced` events when a milestone is reached. No extra "original date" columns
    needed — the history table is the system of record for original-vs-revised-vs-actual.
- **Expected dates** feed the timeline as planned targets (faint), with actual stamps
  layered on as stages advance.

## 6. Money — ONE pool, payment-driven (points 4 & 6) ⚠️ supersedes S144 invoice-billing

The single LOT↔SF pool (`running_account`, RULE-MANIFEST-001) stays the one source of
truth for who owes whom. **The pool moves on actual payments, recorded as they happen**
(not at invoice time). This is the core change from S144's invoice-billing-driven model.

### The payment ledger (the only money mechanism)

- **Credits (+) — LOT funds the pool:** LOT→SF transfers (existing `payments` / PMT, with
  UTR). When recorded, the pool goes up (SF holds more of LOT's money).
- **Debits (−) — SF spends from the pool, recorded + deducted the moment it's paid/allocated:**

  | Payment | When (stage) | Tied to | Wraps up |
  |---|---|---|---|
  | **Vendor advance** | after PI received | order | goods purchase (start) |
  | **Pickup balance / extra services** | at pickup | order | goods purchase (end) |
  | **Shipping** | port clearance | shipment | logistics |
  | **Customs / duty** | port clearance | shipment | logistics |
  | **Other port fees** | port clearance | shipment | logistics |
  | **Last-mile delivery** | port → warehouse | shipment | logistics |
  | **SF commission (2.5%)** | at invoice | order | SF fee |

- **Net** = Σ credits − Σ debits. **net > 0 → SF holds LOT funds; net < 0 → LOT owes SF**
  (SF paid from its own pocket and will recover it — point 4, balance can go either way).
- **Every debit deducts the pool immediately on record** (point 6). No "recognize at
  invoice" step — the pool is always live to whatever's actually been paid.
- **Reuse existing tables, don't add parallel ones (point 9):**
  - Goods payments (advance, pickup balance) → `vendor_payments` (VP), gaining a
    `payment_type` (`advance` | `pickup_balance`) + `order_id`.
  - Logistics payments (shipping/customs/other/last-mile) → `charges` (CHG), gaining a
    `charge_type` (`shipping` | `customs` | `other_fees` | `last_mile`) + `shipment_id` +
    `due_stage`. Entered + paid by SF around the relevant stage.
  - Both `vendor_payments` and `charges` are **back IN** the `running_account` view as pool
    debits (S144 had demoted vendor_payments to sub-detail; this re-promotes the
    payment-driven model).
- **Tracking + audit across stages (point 6):** every payment row carries its type, the
  order/shipment it's against, amount, and timestamp, and writes a history event (§7) — so
  the full payment trail is visible and auditable per order and per shipment at every stage.

### Relationship to the S145 PO money layer

S145's `po_allocations` (pool → PO → balance-due) + `po_payment_schedule` (advance/balance
milestones, due-now) overlap heavily with the payment ledger above. **To avoid two money
mechanisms (point 9):**
- The **actual payments** (typed, stage-linked, pool-affecting) become the single money
  truth.
- `po_payment_schedule` is retained **only as an optional "what's due when" planner**
  (advance after PI, balance at pickup) that surfaces a due-now nudge — it moves no money.
- `po_allocations` is **folded into / superseded by** the payment ledger (an allocation is
  just a payment tied to an order). **Confirm at build whether to formally retire
  `po_allocations` or keep it as a thin view over payments** — flagged in §13.

### Pool-sufficiency nudge (kept)

When SF is about to record any debit (advance, pickup, a shipment cost), compute available
pool (net less anything already committed). If it can't cover the amount, surface **Raise
Draw-down** (existing `createDrawdown`, `sf_drawdown_raise`). It's a **funding prompt, not a
pay-now gate** — SF can still pay from its own pocket (net goes negative).

## 7. Invoice & close — closeout record, per-line GST (points 3 & 4)

- **What invoicing IS (point 4):** an **order close-out action with a record to show for
  it** (the formal SF→LOT invoice document, for LOT's books + GST). It is **not** the thing
  that moves the pool for goods/logistics — those already moved as payments (§6). Kept
  loose on purpose: an order can be invoiced before or after it's fully paid; balance can
  sit either way.
- SF opens **Invoice** on a not-fully-invoiced order → a form listing the order's **goods
  line items** with their amounts.
- SF **ticks which lines to bill** (partial allowed). **GST is per-line editable (point
  3):** each row carries its own `gst_percent` (default 18%, editable per row) because a
  single PO can mix items on different GST codes. SF **cannot** zero GST silently — it
  defaults in but is editable per line. SF **can** toggle **SF commission** (2.5%) on/off
  for the invoice.
- Submitting:
  1. Creates an invoice — **auto VWINV** number (reuse `nextInvoiceNo()` / the
     `VWINV-<FY>00<N>` series; never typed).
  2. Stamps each billed `order_lines` row with `invoice_no` + the `gst_percent` used (a
     line is billed once).
  3. Invoice total = Σ ticked goods value + per-line GST + (commission if ticked).
  4. **Pool impact = the commission only** (goods + logistics already debited via payments
     §6). Commission debits the pool at invoice. *(GST on the document is for compliance;
     its pool treatment is a confirm-at-build item — §13.)*
  5. Order → `partially_invoiced`; when **all** goods lines carry an `invoice_no` →
     `invoiced` (closed).
- Rewrite `invoiceOrder` to accept a **line selection + per-line gst_percent +
  include_commission** and support multiple invoices per order; the current whole-order
  behaviour becomes the "all lines ticked" case. Keep auto-VWINV + the commission accrual.

## 8. History / timeline — orders AND shipments (point 7)

- **Both orders and shipments carry a running, timestamped activity/stage history** so
  anyone can see exactly when things moved and what happened. One append-only history table
  (the existing `stage_events`, generalized) keyed by **entity (`order` | `shipment`) +
  id**, every event timestamped (`occurred_at`) with `event_type`, `actor`, and a small
  detail payload.
- Events logged: stage advances (`stage_advanced`), date planning + revisions
  (`dates_planned` / `dates_revised` — these give point 1 its immutable original),
  payments (`payment_recorded`, with type + amount), PI/doc milestones (`pi_attached`),
  shipment allocation/moves, invoicing (`invoiced` / `partially_invoiced`), cancellation
  (`cancelled`).
- **Timeline UI (planned vs actual):** each pipeline step shows its **expected date**
  (current plan, faint target) **and** the **actual stamp** once advanced (from
  `stage_advanced.occurred_at`). The order timeline also threads in its payments + PI +
  invoice events; the shipment timeline threads in its milestones + logistics payments.
- This supersedes the interim created_at/invoice_date timeline fallbacks for shipment-driven
  stages while keeping them for the order-half (placed).

## 9. Data-model changes (all additive; seed reworked separately — point 8)

- `orders.status` CHECK: add `requested`. `orders.cost_state` CHECK: add
  `partially_invoiced`.
- `order_lines`: add `vendor_code text`, `vendor_desc text`, `lot_product_code text` (nullable,
  filled by the future connector), `invoice_no text` (nullable), `gst_percent numeric`
  (per-line GST used).
- `shipments`: add `cost_notes text` (logistics costs live on `charges` rows, §6, not as
  shipment columns).
- `vendor_payments`: add `payment_type text` (`advance` | `pickup_balance`) + `order_id`
  FK; re-include in `running_account`.
- `charges`: add `charge_type text` (`shipping` | `customs` | `other_fees` | `last_mile`),
  `shipment_id` FK, `due_stage text`; ensure in `running_account`.
- `stage_events`: generalize to `entity_type` (`order` | `shipment`) + `entity_id` (keep
  `order_id` working for back-compat, or add `shipment_id`), `event_type`, `occurred_at`,
  `actor`, `detail jsonb`.
- New SF role keys `sf_po_manage`, `sf_invoice_create` (+ grant to `sf_owner`).
- **`running_account` view rewrite** — payment-driven:
  `net = Σ payments(LOT→SF) − Σ vendor_payments − Σ charges − Σ sf_invoice commission +
  Σ ledger`. (Drops S144's `recognized_cost` term.)
- **Snorkel projection parked** — do not auto-fire `projectToSnorkel`; the connector (§2)
  is a separate future build.
- **Seed (point 8):** the FY2026-27 seed is **NOT** force-migrated in this build. **Once all
  the above changes are in, we revisit the seed end-to-end** to fit the new payment-driven
  model (re-express the existing orders' costs as the right payment rows, re-derive the
  running-account net). The old "net must stay −₹34,81,246" hard constraint from the prior
  draft is **relaxed** — the seed will be re-derived, not preserved as-is.

## 10. Worker actions (new / changed) — `manifestops`

- `convertToPo(order_id)` — `requested → draft`, SF-owned (`sf_po_manage`).
- `cancelOrder(order_id, reason)` — guard: only `{requested,draft,placed,confirmed,produced}`;
  logs `cancelled` history event; reason required.
- `getPoDocData(order_id)` — data for the PO PDF print route (vendor codes).
- `recordDocument` — extend to log a `pi_attached` (and future) history event for milestone
  doc types.
- `allocateItemsToShipment` / `moveItemsBetweenShipments` — item-level, sailing-lock guarded.
- `recordVendorPayment(order_id, type, amount, ...)` — advance / pickup_balance; deducts the
  pool; logs history; returns pool-sufficiency (+ shortfall for the drawdown nudge).
- `recordShipmentCost(shipment_id, charge_type, amount, due_stage, notes)` — shipping/
  customs/other/last_mile; deducts the pool; logs history; pool-sufficiency result.
- `invoiceOrder` rewrite — line selection + **per-line gst_percent** + `include_commission`;
  partial invoicing; auto-VWINV; line stamping; `partially_invoiced`/`invoiced` transition;
  commission pool debit.
- `getBootstrap`/`getOrder`/`getShipment` upgrades — expose `requested`/`partially_invoiced`,
  vendor codes, per-line `invoice_no`/`gst_percent`, the full payment ledger per order +
  shipment, the order/shipment history timelines (planned-vs-actual + original plan), pool
  available for the nudge.

## 11. Build phases (one spec, staged delivery)

1. **States + convert + cancel + permissions** — `requested`, `partially_invoiced`,
   `convertToPo`, `cancelOrder` (≤produced guard), SF keys, party-aware gates.
2. **Vendor codes + PO PDF + PI milestone** — vendor_code/vendor_desc/lot_product_code on
   lines; print route + `getPoDocData`; PI upload → `pi_attached`; **park the Snorkel
   projection** (connector = separate future spec).
3. **History/timeline generalized + immutable original plan** — generalize `stage_events`
   to orders + shipments; planned-vs-actual timeline; original-plan-from-first-event.
4. **Payment-driven money** — `vendor_payments`/`charges` typing + stage links + back into
   `running_account` (view rewrite); `recordVendorPayment` / `recordShipmentCost`; pool-
   sufficiency → Raise Draw-down nudge; fold/retire S145 `po_allocations`.
5. **Shipments item allocation/move/lock** — item-level allocate/move with sailing-lock.
6. **Partial invoicing** — line-selection invoice form, **per-line GST** + optional
   commission, partial/close transitions, commission pool debit.
7. **Seed rework (point 8)** — after 1–6, re-derive the FY26-27 seed onto the new model.

## 12. Simplicity review (point 9)

Where the design was deliberately kept simple / de-complicated:
- **One money mechanism, not two.** Actual payments drive the pool; the S145 allocation
  sub-ledger is folded into payments rather than run alongside it. The invoice stops being
  a second money path — it's a record.
- **Immutability for free.** The immutable original plan date (point 1) needs **no new
  columns** — it's the first event in the append-only history (point 7). One feature pays
  for two requirements.
- **Reuse existing tables.** `vendor_payments` + `charges` already exist — we add a type +
  a link, not new tables. `stage_events` already exists — we generalize it, not duplicate
  it.
- **Vendor codes are just stored, not resolved.** No mapping logic in this build; the
  Snorkel connector is explicitly deferred so this spec doesn't grow a translation engine.
- **Loose by design.** No hard gates between pay / invoice / deliver (point 4); cancellation
  is a single stage threshold (point 5). Fewer rules, fewer edge cases.

## 13. Open items / confirm at build time

- **GST-on-invoice vs pool:** §7 debits only commission to the pool (goods/logistics already
  paid). Confirm whether per-line GST on the SF invoice should also hit the pool or stays a
  document/compliance figure only. Decide alongside the seed rework (§9/point 8).
- **S145 `po_allocations`:** formally retire it, or keep it as a thin view over the payment
  ledger? (Leaning retire for simplicity.)
- **Snorkel connector** (vendor_code → LOT product_code mapping + projection) is a **separate
  future spec** — not built here. Confirm the mapping table shape + review UI when scoped.
- **PO PDF format** is a placeholder; swap in SF's real layout when provided.
- **Reports tab + running-account statement** (downloadable) is a **separate spec** — out of
  scope here (the PO print route is built reusable for it).
- **v2 landed cost-per-unit** (allocate logistics to per-unit CPU → standard cost) remains a
  later, separate build; this spec stops at order-level cost tracking.
- **Cancellation with payments already made:** payments are NOT auto-reversed on cancel
  (loose); confirm whether a manual reversal/credit tool is wanted later.
