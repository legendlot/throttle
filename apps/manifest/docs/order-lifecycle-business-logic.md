# Manifest — How a China order works (business logic & flow)

> **Plain-language reference.** This is the canonical description of how an order flows
> through Manifest and the rules that govern it. It is written to be read by anyone on
> the LOT or Solve Factory (SF) team — no technical detail — and is the source text for
> the Manifest user manual.
>
> The matching engineering spec is
> `05_Throttle/docs/superpowers/specs/2026-06-16-manifest-sf-order-lifecycle-design.md`.
> If the two ever disagree, this file describes the *intent*; the spec describes the *build*.
>
> Last updated: 2026-06-17.

---

## 1. What Manifest is, in one paragraph

Manifest is the shared workspace where **Legend of Toys (LOT)** and **Solve Factory (SF)**
run every China import together. LOT asks for what it needs and puts money into a shared
pool. SF takes it from there — raising the purchase order with the Chinese vendor, paying
the vendor, shipping the goods, clearing customs, delivering to LOT's warehouse, and finally
invoicing LOT to close the order. Everything is tracked live, with dates stamped
automatically as each step happens, and a full timestamped history on every order and every
shipment so anyone can see exactly what happened and when.

**The golden rule of who does what:**
- **LOT** raises the request and funds the shared pool. That's it.
- **SF** owns the entire lifecycle after the request.

---

## 2. The two sides of the money: the shared pool

There is **one shared pool of money** between LOT and SF. Think of it as a running tab.

- **LOT pays money in** → the pool goes up. SF is now holding LOT's money.
- **SF spends money out** (paying the vendor, paying for shipping, customs, delivery, and
  taking its commission) → the pool goes down.
- The **balance can go either way**:
  - **Pool positive** → SF is holding LOT's money, ready to spend.
  - **Pool negative** → SF has spent more than LOT has put in (SF paid out of its own
    pocket), so **LOT owes SF**. This is allowed and normal.

**The most important money rule:** every payment SF makes is deducted from the pool **the
moment it is recorded** — not later at invoice time. So the pool is always live and accurate
to whatever has actually been paid out on LOT's behalf.

---

## 3. The journey of an order, step by step

### Step 0 — LOT requests it
LOT records what it wants. The order is now in the **Requested** state. This is the only
thing LOT does to the order itself.

### Step 1 — SF converts it to a PO
SF picks up the request and fills in the real purchase-order detail: the vendor, the
**vendor's own product codes** (see §5), the prices in Chinese Yuan (¥), and the terms. The
order moves to **Draft** and is fully editable by SF.

### Step 2 — SF places the PO
SF finalises the PO. The order moves to **Placed**, and a **printable PO document (PDF)**
becomes available. SF sends that PDF to the Chinese vendor.

### Step 3 — Vendor sends the PI; SF attaches it
The vendor replies with a Proforma Invoice (PI). SF uploads it into Manifest. It's stored as
evidence and shows up as a **timestamped milestone** on the order's timeline. Manifest never
generates the PI — it only stores the vendor's.

### Step 4 — SF pays the vendor advance
After the PI is in, SF pays the vendor the **advance** out of the pool. This is recorded as a
payment and **immediately deducts the pool**.

### Step 5 — Production → pickup
SF advances the order through production (**Confirmed → Produced → Picked up**); each step is
date-stamped automatically. At **pickup**, SF pays any **remaining balance or extra services**
to the vendor — again recorded and deducted from the pool. At this point the **goods purchase
is fully wrapped up**.

> **Cancellation cut-off (important):** an order can be **cancelled at any time up to and
> including "Produced"**. **Once it is "Picked up", it can no longer be cancelled** — the
> goods are paid for and on their way.

### Step 6 — SF puts it on a shipment
SF allocates the goods to a **shipment** (a container) and sets the **expected dates** for
each leg of the journey. The very first set of dates is kept **permanently as the original
plan** — even if SF revises the dates later, the original is never lost (see §7).

- Usually **one PO travels on one shipment**, but a single shipment often carries **several
  POs** together, and one PO can be **split across more than one shipment** if needed.
- Items can be **moved between shipments while the container hasn't left yet**. **Once the
  shipment departs, its contents are locked** — nothing can be added, removed, or moved.
- A shipment is either **Air** or **Sea** (see §4.5). Both follow the same steps; air is
  faster and the costs differ. The same PO can even be **split across an air shipment and a
  sea shipment** — e.g. urgent items fly while the bulk sails.
- Manifest **suggests the expected dates** for each leg from the team's saved defaults for
  that mode (air or sea). These are only suggestions — SF can change any date — and the
  defaults themselves are **editable by SF/admin** in a settings screen.
- Manifest records **who is carrying the shipment** (the freight partner — e.g. DHL, FedEx,
  a shipping line), with a tracking link where available. Partners are always picked from a
  shared list, never typed as loose text.

### Step 7 — The shipment sails, docks, and clears customs
SF advances the real shipment milestones — **Loaded → Sailing → Docked → Cleared → Local
transport → Received** — each one date-stamped automatically. When the goods clear the port,
SF now knows the real logistics costs and enters + pays them out of the pool:
- **Shipping**
- **Customs / duty**
- **Other port fees**

Each is recorded against the shipment and **deducts the pool immediately**. (For an **air**
shipment these milestones read *In Flight* and *Landed* instead of *Sailing* and *Docked* —
same steps, different words.)

### Step 8 — Last-mile delivery to the warehouse
SF arranges delivery from the port to LOT's warehouse, enters + pays that **last-mile
delivery** cost (deducts the pool), and the order is now **delivered**.

At this point Manifest also records **who is doing the last-mile delivery** and the **vehicle
number**, so the **store team knows exactly who and what vehicle to expect** when the material
arrives. (The delivery partner is picked from the shared list — if a new one is needed, it's
added to the master in the moment, never typed as loose text.)

### Step 9 — SF invoices LOT and closes the order
Finally, SF raises the **invoice to LOT** to close the order out (see §6). The order moves to
**Partially invoiced** and then **Invoiced (closed)** once everything is billed.

---

## 4. The full list of payments SF makes (and when)

Everything SF pays comes out of the shared pool and is tracked + auditable at every stage:

| Payment | When it happens | Tied to |
|---|---|---|
| **Vendor advance** | after the PI is received | the order |
| **Pickup balance / extra services** | at pickup | the order |
| **Shipping** | when the goods clear the port | the shipment |
| **Customs / duty** | when the goods clear the port | the shipment |
| **Other port fees** | when the goods clear the port | the shipment |
| **Last-mile delivery** | port → warehouse | the shipment |
| **SF commission (2.5%)** | at invoice | the order |

The first two wrap up the **goods purchase**. The middle four are **logistics**. The last is
**SF's fee**. Every one of them reduces the pool the moment it's recorded.

---

## 4.5 Air vs Sea — what's different

Every shipment is either **Air** or **Sea**. The journey steps are the same; what changes is:

- **Speed.** Sea is roughly **30–40 days** door-to-door; air is roughly **5–8 days**.
- **Cost.** Sea freight is priced by container or volume; air freight is priced by
  **chargeable weight**. Both still incur customs/duty, handling fees, and last-mile delivery —
  Manifest just prompts SF for the right set of costs for the mode.
- **Wording.** The same milestones are labelled to suit the mode — "Sailing / Docked" for sea,
  "In Flight / Landed" for air. The carrier document is a "Bill of Lading (BL)" for sea and an
  "Air Waybill (AWB)" for air.
- **Lock point.** A shipment's contents lock the moment it **departs** — when the vessel sails
  or the flight leaves.

The **suggested timelines per mode are editable** by SF/admin, so the dates Manifest pre-fills
always reflect the team's real experience.

---

## 5. Why the PO uses the vendor's product codes (and what that means)

The PO SF raises is written in the **Chinese vendor's product codes**, not LOT's names. For
example, the product LOT calls **Flare** might appear on the vendor's PO as **`820D`**.

Because of this, a Manifest PO **cannot be automatically pushed into Snorkel** (LOT's
procurement system), which speaks LOT's own product codes. Bridging the two needs a
**translation step** — matching each vendor code to its LOT product — and **that connector is
a separate piece of work, not yet built**. Until it exists, Manifest runs fully on its own
using vendor codes, and nothing half-matched is sent to Snorkel.

---

## 6. How invoicing works (closing the order out)

**Invoicing is a close-out action with a record to show for it** — the formal SF→LOT invoice
document, for LOT's books and GST. It is **not** the thing that moves the money for goods and
logistics; those were already paid and deducted from the pool as they happened (§2, §4). It's
deliberately kept loose: an order can be invoiced before or after it's fully paid, and the
pool balance can sit either way.

When SF invoices an order:
- SF sees the order's **goods line items** and **ticks which ones to bill** — **partial
  invoicing is allowed** (bill some now, the rest later).
- **GST is applied per line and is editable on each line** (defaults to 18%). This matters
  because a single PO can contain items on **different GST codes**.
- SF can **optionally add its 2.5% commission** to the invoice.
- The invoice gets an **automatic invoice number** (the VWINV series) — never typed by hand.
- Each billed line is stamped with that invoice number so it's never billed twice.
- The order becomes **Partially invoiced**, and once **all** goods lines have been billed, it
  becomes **Invoiced (closed)**.

---

## 7. The history & timeline on every order and shipment

**Both orders and shipments keep a running, timestamped history** of everything that happens
— so anyone can look back and see exactly when each thing moved and what it was. Recorded
events include: stage advances, dates being planned and later revised, every payment (with its
type and amount), the PI and other documents, allocation to and moves between shipments,
invoicing, and cancellation.

Two things fall out of this history automatically:
- **The original plan is permanent.** The first set of expected dates SF enters is captured as
  the original plan and is never overwritten, even when dates are revised later. You can always
  see what was originally promised versus what actually happened.
- **Planned vs actual on the timeline.** Each step shows its **expected date** as a faint
  target and its **actual date** once the step is reached.

---

## 8. The states an order moves through

**Lifecycle (production side):**
`Requested → Draft → Placed → Confirmed → Produced → Picked up → Shipped → Received → Delivered`
(plus **Cancelled**, allowed only up to *Produced*).

**Billing side (runs in parallel near the end):**
`In flight → Delivered → Partially invoiced → Invoiced (closed)`

**Shipment journey (Sea):**
`Planned → Loaded → Sailing → Docked → Cleared → Local transport → Received`
(contents lock at *Sailing*).

**Shipment journey (Air):** the same steps, read as
`Planned → Loaded → In Flight → Landed → Cleared → Local transport → Received`
(contents lock at *In Flight* — i.e. departure).

---

## 9. The short version (cheat sheet)

1. **LOT requests, LOT funds the pool.** Everything else is SF.
2. **One shared pool**; every SF payment deducts it the moment it's recorded; balance can go
   either way.
3. **SF: convert → place (PO PDF) → attach PI → pay advance → produce → pickup (pay balance) →
   ship → clear customs (pay shipping/customs/fees) → deliver (pay last-mile) → invoice.**
4. **Cancellable until pickup, never after.**
5. **PO is in vendor codes** — Snorkel linking needs a future connector.
6. **Invoice = close-out record**; partial allowed; **GST editable per line**; optional 2.5%
   commission; auto invoice number.
7. **Original plan dates are permanent**; full timestamped history on orders + shipments.
8. **Air or Sea** — same steps, different speed/cost/wording; the suggested timelines per mode
   are editable; one PO can split across both.
9. **Every leg names its carrier**; last-mile records the **delivery partner + vehicle number**
   for the store team; partners always come from the shared master, never free text.
