# Snorkel ↔ Depot — Sales-Order Fulfilment Flow (multi-channel, request→accept→split, tracking, collections)

> Design spec · 2026-06-22 · spans **Snorkel** (`apps/snorkel` + `snorkelops`) and **Depot** (`apps/depot` on `lotopsproxy`).
> Status: **approved design, pre-plan.** Supersedes the locked "confirm → ONE shipment" behaviour in RULE-SNORKEL-004 #3 and closes the backlog item *"[snorkel] Offline Sales — future phases — partial-dispatch/multi-invoice"*.

---

## 1. Problem & goal

Today Snorkel's Offline Sales module (S98) is GT/MT-only and one-shot: confirming a sales order
auto-creates **one** `public.dispatch_shipments` row, and fulfilment is whatever the dispatch team
does to that single shipment. We are extending sell-side to **all bulk channels** — especially
**quick commerce (QC)**, where platforms (Blinkit, Zepto, Instamart, …) raise **bulk purchase orders
per fulfilment-centre warehouse** — and the dispatch team needs a real fulfilment workflow:
**accept / reject**, **full or split** dispatch, **per-shipment tracking**, and the **fulfilment +
tracking + collection state flowing back to the sales order** for the sales team.

### Primary vs secondary sale (the Odo boundary — foundational)
- **Primary sale (sell-in)** = our bulk shipment fulfilling the platform's PO. **This is what these
  Snorkel sales orders capture.**
- **Secondary sale (sell-out)** = the platform selling to the end consumer. **This is what Odo shows**,
  and Odo already ingests it from QC seller-portal reports (`qc_upload`).
- They are **different events** → no double-count. QC Snorkel orders must **not** feed Odo's sell-out;
  GT/MT continue to feed Odo (the Snorkel order is our only sell-out signal there). Enforced by a
  channel flag (§4.A, §10).

## 2. Locked decisions (from brainstorming, 2026-06-22)

1. **Approach A** — a fulfilment-request *parent* in `public` owned by Depot/lotopsproxy, with shipment
   *children*; the SO's fulfilment/tracking state is **derived read-only** by Snorkel.
2. **Unify all channels** — GT/MT **and** QC/marketplace all go through request→accept→full/split.
   One code path; GT/MT also gain split + tracking. (Existing already-confirmed orders are *not*
   retro-migrated — clean forward cutover, §11.)
3. **Reject = cancel the SO** (reason required, terminal). Retry = a fresh order.
4. **Full = one-and-done** — a full shipment can only be **shortened** (overwrite scheduled units),
   never topped up; a shortened full closes the order **partially fulfilled**. Multi-shipment is the
   **Split** path.
5. **Fulfilment basis = total PO quantity** — fully fulfilled when Σ shipped ≥ Σ requested across the
   whole PO; else partially. (Per-line detail still surfaced, but the headline is total-qty.)
6. **Warehouse = free-text** on the SO; shown in the shipment title.
7. **Collection: channel-driven for auto channels** (period from channel master, per-order overridable);
   partner `default_credit_days` is the fallback (GT/manual).
8. **Depot permission = reuse the existing dispatch gate** (`canManageFloor`) — no new key.
9. **Tracking V1 = manual entry; V2 = Delhivery API** (deferred, §9).

## 3. Architecture & write-ownership (extends RULE-SNORKEL-004 #2)

Both workers are `service_role` on the same project; the discipline is a clean write-split, not a
hard wall:

- **`snorkelops` owns all `store.sales_*` writes.** On confirm it does the **one-time** insert of the
  fulfilment request + request lines into `public` (exactly as it already inserts `dispatch_shipments`
  today). It **reconciles** the SO's own `status` (the reject→cancel stamp) on read.
- **`lotopsproxy` (Depot) owns all `public.dispatch_*` writes** — request accept/reject, shipment
  creation (full/split), shipment lifecycle, cancel, and tracking. It **never writes `store.sales_*`**.
- **Snorkel derives** fulfilment status + tracking by reading the request + its shipments (read-only),
  extending the existing RULE-SNORKEL-004 #4 derived-status pattern.

```
Snorkel (snorkelops)                         Depot (lotopsproxy / apps/depot)
─────────────────────                        ────────────────────────────────
sales_orders (store)  ──confirm: insert──►   dispatch_fulfilment_requests (public)  [pending]
sales_order_lines     ──snapshot lines──►    dispatch_fulfilment_request_lines      │
        ▲                                        │ accept(full|split) / reject       │
        │ derive (read-only)                     ▼                                   │
   fulfilment status  ◄───── read ──────    dispatch_shipments (public) [N children] │
   tracking fields    ◄───── read ──────    dispatch_shipment_lines    + tracking    │
   reject→cancel stamp ◄── reconcile ───    request.status='rejected'  ──────────────┘
```

## 4. Data model

### 4.A `store.sales_channels` — add channel config (migration: `snorkel_channel_master_v2`)
| Column | Type | Notes |
|---|---|---|
| `channel_type` | text | `general_trade\|modern_trade\|quick_commerce\|marketplace\|d2c\|other` |
| `collection_type` | text default `'auto'` | `auto\|manual` |
| `collection_period_days` | int null | used when `auto` (e.g. Blinkit 30) |
| `feeds_odo_sellout` | bool default `false` | **true only for GT/MT** → Odo sell-out source; QC/marketplace false (sell-in only) |

Seed: GT → `general_trade`/`manual`/`feeds_odo_sellout=true`; MT → `modern_trade`/(manual or auto per
reality)/`true`. QC/marketplace channels → `auto`, period per platform, `feeds_odo_sellout=false`.
Managed on Snorkel `/sales/settings`. The concrete channel list (names + periods) is seeded at build
from Afshaan; channels are otherwise self-serve.

### 4.B `store.sales_orders` / `sales_order_lines` — (migration: `snorkel_sales_order_fulfilment_v1`)
- `sales_orders.destination_warehouse` text null — free-text QC fulfilment-centre id; on order, request, shipment title.
- No new fulfilment-status column — **derived** (§6). `status` CHECK stays `draft|confirmed|cancelled`.
- `dispatch_shipment_id` retained as legacy/nullable (1:1 link from the old model); the new link is
  the request (§4.C). `partner_po_ref` = the platform PO number (already exists).

### 4.C New `public` tables — owned by Depot (migration: `depot_fulfilment_requests_v1`)
**`dispatch_fulfilment_requests`**
| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `request_no` | text | `FR-NNNN`, new `store.sequences` key `fulfilment_request` (DB default like `dso_seq`) |
| `sales_order_id` / `sales_order_no` | uuid / text | link to the Snorkel SO |
| `channel_id` | uuid | → `public.dispatch_channels.id` |
| `destination_warehouse` | text null | free-text (mirrored from SO) |
| `partner_po_ref` | text null | platform PO number |
| `title` | text | e.g. `Blinkit · WH-Bhiwandi · SO-0123` |
| `requested_units` | int | Σ requested qty (total-PO basis) |
| `status` | text default `'pending'` | `pending → accepted \| rejected \| cancelled` (CHECK) |
| `fulfilment_mode` | text null | `full \| split` (set on accept) |
| `accepted_by/at`, `rejected_by/at`, `reject_reason` | | audit |
| `created_at` | timestamptz | |

**`dispatch_fulfilment_request_lines`** — `request_id` fk (cascade), `product/model/color/sku`, `qty`,
`sort_order`. Immutable snapshot of what was requested (lets Depot build shipments with no cross-schema read).

`dispatch_shipments.fulfilment_request_id` uuid null — parent link (children of a request).

All new tables **RLS-on, service_role-only** (RULE-RLS-001) + `GRANT ALL … TO service_role`.

### 4.D `public.dispatch_shipments` — tracking columns (all shipments, incl. GT/MT)
| Field | Source |
|---|---|
| Dispatch date | existing **`shipped_at`** (auto on mark-shipped) |
| Actual delivery | existing **`delivery_date`** |
| **`expected_delivery_date`** date | new |
| **`courier_partner`** text | new |
| **`tracking_number`** text | new |
| **`tracking_link`** text | new |

Shipped-qty for fulfilment math = `dispatch_shipment_lines.target_qty` of shipments in `status='shipped'`
(the overwritable scheduled units; scan-based flows keep `packed_qty` in sync but `target_qty` is the
authoritative shipped count for these manual bulk shipments).

## 5. Flow & state machine

1. **Confirm (Snorkel, `sales_order_confirm`)** → insert request `pending` + line snapshot; resolve
   `credit_days` (channel-auto period else partner default). No shipment yet. Request appears in Depot's
   **Fulfilment Requests** queue.
2. **Reject (Depot, `canManageFloor`)** → request `rejected` (+reason). Snorkel reconciles SO →
   `cancelled` (`cancel_reason='Fulfilment rejected: …'`) on next read.
3. **Accept — Full** → request `accepted`/`full`; create **1** child shipment (`target_qty`=requested,
   title carries warehouse). Dispatch may **shorten** `target_qty` before ship. Shipping a shortened
   full ⇒ partially fulfilled, done.
4. **Accept — Split** → request `accepted`/`split`; create **N** child shipments, each own
   `scheduled_date` + qty. Each shipment **cancellable** (selected or all).
5. **Fulfilment complete** = no shipment still open (every child `shipped` or `cancelled`):
   **fully** if Σ shipped ≥ requested_units, else **partially**.

Shipment status reuses the existing `dispatch_shipments.status` lifecycle (`draft → … → shipped`/`cancelled`).

## 6. Derived fulfilment status (Snorkel, read-only)
Computed in snorkelops read handlers from the request + its shipments — **not stored** on the SO:

| Condition | Derived label |
|---|---|
| no request (draft) | `not_submitted` |
| request `pending` | `awaiting_acceptance` |
| request `accepted`, ≥1 shipment open | `in_fulfilment` |
| complete, Σ shipped ≥ requested | `fully_fulfilled` |
| complete, 0 < Σ shipped < requested | `partially_fulfilled` |
| complete, Σ shipped = 0 (all cancelled) | `not_fulfilled` |
| request `rejected` | SO `cancelled` (stamped on reconcile) |

## 7. Worker actions

### snorkelops (`05_Throttle/snorkelops-worker/src/index.js`)
- **`confirmOrder`** rewritten: insert request + request_lines into `public` (replaces the direct
  `dispatch_shipments` insert); stamp `sales_orders.dispatch_shipment_id`→null/legacy; resolve credit_days.
- **`getSalesOrders` / `getSalesOrder` / `getSalesCollections`** join the request + child shipments →
  return derived fulfilment status + per-shipment tracking; reconcile reject→cancel.
- Channel CRUD (`createSalesChannel`/`updateSalesChannel`) gains the new config fields.

### lotopsproxy (`01_worker/worker.js`) — Depot
- New GET `getFulfilmentRequests` / `getFulfilmentRequest`.
- New POST (all `canManageFloor`): `acceptFulfilmentFull`, `acceptFulfilmentSplit` (array of
  {qty, scheduled_date, lines}), `rejectFulfilment` (reason), `cancelShipments` (ids[]),
  `updateShipmentSchedule` (overwrite `target_qty` on a full), `updateShipmentTracking`
  (courier/tracking#/link/expected_delivery), and `markShipmentShipped` (stamps `shipped_at`).
- Reuse existing `updateShipment`/`delivery_date` for actual-delivery write-back.
- **50-subrequest rule**: split creation + line inserts are array/batch inserts, never per-row awaits.

## 8. UI

### Depot (`apps/depot`)
- **Fulfilment Requests** `/fulfilment-requests` (Outbound nav group): pending queue + history;
  detail → Accept (Full / Split) / Reject (reason). Split builder = add rows {qty, scheduled_date}.
- **Shipments** `/dispatch-shipments`: add tracking fields (courier, tracking #, link, expected/actual
  delivery — editable); **Cancel shipment(s)** (select/all); **edit scheduled units** on a full shipment;
  Mark Shipped (stamps dispatch date). Title shows channel · warehouse · SO.

### Snorkel (`apps/snorkel`)
- **SO detail + list**: derived fulfilment status badge; a **shipments panel** (read-only) with
  per-shipment courier/tracking link/dispatch/expected/actual delivery.
- **Collections** `/sales/collections`: due = `(latest shipped shipment delivery_date, else dispatch
  date) + credit_days`; auto-collection channels surface automatically. Order-level in V1.
- **Channel settings** `/sales/settings`: edit `channel_type`, `collection_type`,
  `collection_period_days`, `feeds_odo_sellout` per channel.

## 9. Delhivery tracking — V2 (deferred, separate plan)
For shipments with `courier_partner='Delhivery'` + a `tracking_number` (waybill): a scheduled poll
(Supabase `pg_cron` → a lotopsproxy endpoint, mirroring `auto-close-attendance`) calls the Delhivery
**Track API** by waybill to auto-populate `delivery_date` + a tracking status. Needs a `DELHIVERY_TOKEN`
secret (`wrangler secret put` — gated). >90% of shipments are Delhivery, so this covers most. **V1 ships
with manual entry only.**

## 10. Odo guard (RULE-SALES-001 amendment)
`odoops` snorkel adapter filters confirmed orders to channels with `feeds_odo_sellout = true` → only
GT/MT flow as sell-out; QC/marketplace Snorkel orders (primary/sell-in) are excluded. Documented as a
RULE-SALES-001 amendment + the primary-vs-secondary distinction.

## 11. Migration / rollout
- Additive migrations only (new columns + new tables) — advisor-clean, RLS-on at creation.
- **No retro-migration** of already-confirmed orders: existing confirmed GT/MT orders keep their
  legacy `dispatch_shipment_id` shipment; only **new** confirms (after deploy) create requests.
- Deploy order: migrations → snorkelops (commit→push→deploy) → lotopsproxy (commit→push→deploy; **3-system
  blast radius — verify `canManageFloor` predicate**) → apps auto-deploy (snorkel + depot).
- `feeds_odo_sellout` seeded **before** the odoops filter change so Odo never momentarily drops GT/MT.

## 12. Business-rule changes
- **RULE-SNORKEL-004 amended**: #3 (confirm→ONE shipment) replaced by confirm→fulfilment request;
  add the request→accept→full/split model + total-PO fulfilment basis + channel-driven collection.
- **New RULE-DEPOT/FULFIL-001**: fulfilment request is the parent (public, Depot-owned); shipments are
  children; reject=cancel SO; full=one-and-done, split=multi; write-split (lotopsproxy never writes
  `sales_*`, snorkelops one-time request insert + reconcile).
- **RULE-SALES-001 amended**: primary vs secondary sale; `feeds_odo_sellout` gate.

## 13. Out of scope (V1)
- Delhivery / any courier API auto-tracking (V2, §9).
- Per-shipment (vs per-order) collections; bank-reconciliation auto-receipts.
- Per-line fulfilment headline (kept total-PO; per-line data still stored).
- Multi-invoice per order / e-way bill / e-invoice (separate deferred items).
- Backorder remainder on the Full path (declined — use Split).

## 14. Open items to confirm during build
- Concrete channel seed list (names + collection periods) + whether MT is auto or manual collection.
- Whether QC channels already exist as rows in `public.dispatch_channels` (map vs create) — Odo lists 17 `is_sale` channels; reuse those ids.
- Exact Delhivery API contract for V2 (token, waybill track endpoint).
