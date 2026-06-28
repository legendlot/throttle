# Dispatch — Box max-capacity + scan-out-to-restock (design)

> Status: design — pending Afshaan approval before build/deploy.
> System: Depot (dispatch back-office) + Scanner. Worker: `lotopsproxy` (shared, no new worker). Schema: `public`.
> Spec date: 2026-06-29. Requested by: Padmajit (dispatch) via #bugs (2026-06-27, 19:48).
> Blast radius: lotopsproxy serves Garage + Redline + Scanner + Depot — 3-system deploy. Sequence: edit → commit → push → `npx wrangler deploy`.

## Problem

Two gaps in the dispatch packing flow:

1. **No per-carton capacity cap.** When loading an outer carton (`dispatch_boxes`, BOX-NNN) on
   the PACK station, there is no limit on how many units can be scanned into it. Padmajit wants
   to lock a max capacity per carton so that once it's full the scanner hard-blocks and prompts
   for a new box. (`fulfillment_model:'unit'` already auto-closes at 1 unit — this generalises
   that to N.)

2. **No tracked way to pull a unit back out.** Once a unit is loaded into a carton (or even
   already dispatched), the only way to "un-load" it is an untracked manual claim. That invites
   human error — someone *says* they put a box in but didn't, or *says* they pulled one out but
   left it in the carton. Padmajit wants removal to be a **physical scan event** (ground truth,
   same principle as RULE-DSP-001: a scan can't be invented, a click can), which removes the unit
   from the carton, reverses every counter, and **restocks the unit back into dispatch's
   possession** so it can be re-dispatched.

## Current model (verified in code)

- Carton = `dispatch_boxes` row: `box_ref` (BOX-NNN), `channel_id`, optional `shipment_id`,
  `status` (open → packed → shipped), `unit_count`, `fulfillment_model` ('unit' = auto-close at 1,
  'box' = bulk carton), `capacity` (NEW — this spec).
- Units in a carton = `dispatch_box_units` (`box_id`, `car_upc`, `batch_label`, variant cols,
  `is_active`, and already-present `removed_at`/`removed_by`).
- **PACK** (`postPack`): derives `carUpc = batch_label.replace(/-[ER]$/i,'')` (label string,
  **no `pkg_scans` dependency**); requires unit `allocated` + box `open` + channel match +
  manifest slot free (`claim_dispatch_line_slot` bumps `dispatch_shipment_lines.packed_qty`);
  inserts the box_unit, `increment_box_unit_count`, flips unit → `packed_dispatch`.
- **DTK / ALLOC** also resolve the unit by label string only (no `pkg_scans`). DTK requires
  `rtd` → sets `handed_over`. ALLOC requires `handed_over` → sets `allocated` (+ `dispatch_allocations`).
- **DOUT** scans BOX-NNN → every unit → `shipped`.
- Dispatch status ladder: `rtd → (DTK) handed_over → (ALLOC) allocated → (PACK) packed_dispatch → (DOUT) shipped`.
- **RESTOCK** station (`postRestock`) already exists and is already under the **Dispatch**
  department in the scanner (`dispatch › Restock › ['RESTOCK']`, with a reason-picker panel).
  Today it: writes a RESTOCK scan + a `unit_restocks` audit row, flips the unit → `qc_pass`,
  deactivates the `dispatch_box_units` row, **deletes `pkg_scans`**, mirrors the paired remote,
  and requires a reason. Eligible statuses today: `{shipped, allocated, pending_rtd, handed_over}`.

## Decisions (Afshaan, this thread)

- **Restock target = `handed_over`** (the post-DTK state), **not `qc_pass`**. The unit never
  physically leaves dispatch, so it must land back in dispatch's possession, ready to re-ALLOC →
  re-PACK → re-DOUT. The current `qc_pass` behaviour is itself a gap and is corrected here.
- **Eligibility = allocated onwards: `{allocated, packed_dispatch, shipped}`.** Drop
  `pending_rtd` (pre-DTK — never entered dispatch) and `handed_over` (already the target state —
  nothing to put back).
- **Reuse the existing RESTOCK station** — no new station, table, or status.
- **Keep `pkg_scans`** on restock (stop deleting it): the unit stays in dispatch with its physical
  `LOT-…-E/R` label, and re-dispatch resolves by label string, so its label/channel record should
  survive. (The delete only ever made sense for the retired `qc_pass` → re-PKG path.)

## Part 1 — Box max-capacity

### Schema
- `ALTER TABLE public.dispatch_boxes ADD COLUMN capacity int;` (nullable; NULL = unlimited =
  today's behaviour). Migration `dispatch_box_capacity_v1`.

### Capture
- Set at carton creation (the box-create step on the PACK station / Depot box selector): operator
  enters "this carton holds N". Optional — left blank = unlimited.

### Enforcement (`postPack`, single guard)
- **Before** inserting the box_unit: if `box.capacity != null && box.unit_count >= box.capacity`
  → hard reject `BOX FULL — start a new box` (red screen + buzz, standard hard-block; logged to
  `scan_violations`). No slot is claimed, nothing mutates.
- **After** a successful pack: if `box.capacity != null && effectiveCount >= box.capacity` →
  auto-close the box (`closeBoxInternal`, same path `fulfillment_model:'unit'` uses) and return a
  `box_full:true` flag so the scanner shows "Box full — open the next one."

## Part 2 — Scan-out → restock (reuse RESTOCK)

Rewrite `postRestock` target + eligibility + counter reversal. The scan, the `unit_restocks`
audit row, the reason requirement, and the paired-remote mirror are unchanged.

### Eligibility
- Eligible: `{allocated, packed_dispatch, shipped}`.
- `{qc_pass, inwarded, handed_over}` → idempotent no-op ("already in stock / in dispatch").
- Customer-touched lifecycle (`rto_in/in_repair/…`) → unchanged hard reject ("use returns/repair flow").
- `pending_rtd` → now rejected ("not in dispatch yet").

### Per-unit writes (car, then mirror remote)
Common to all eligible cases:
1. RESTOCK scan + `unit_restocks` audit row (`status_before` captured; reason required) — unchanged.
2. Flip `units.current_status` → **`handed_over`** (was `qc_pass`).
3. Deactivate the active `dispatch_box_units` row (`is_active=false`, `removed_at`, `removed_by`) — unchanged.
4. **Keep `pkg_scans`** (remove the DELETE).
5. Reset the `dispatch_allocations` row to a clean post-DTK state: clear `box_id`, `packed_at`,
   `shipped_at` (so the unit reads as handed_over + unallocated; re-ALLOC upserts on `car_upc`).

Status-specific:
- **`allocated`** (not yet packed): no carton, no claimed manifest slot → steps 1–5 only.
- **`packed_dispatch`** (in an open/packed, not-shipped carton — Padmajit's core case): also
  - **decrement `dispatch_boxes.unit_count`** (recount active box_units and set, or a small
    `decrement_box_unit_count` RPC mirroring `increment_box_unit_count`);
  - **reopen the carton** to `open` if it was `packed`/auto-closed (not `shipped`), so loading continues;
  - **release the manifest slot** for the car when the box had a `shipment_id`
    (`release_dispatch_line_slot` → `packed_qty -= 1`). Remotes never hold a manifest line (RULE-009).
- **`shipped`** (DOUT'd, cancellation came after — the original reinward scenario): steps 1–5 only.
  **Leave the shipment's historical box/manifest counts intact** — the reinward is a new event,
  not a retroactive un-ship.

### Subrequest budget
Single unit (+ optional paired remote), worst case `packed_dispatch`: unit lookup, alloc lookup,
box lookup, box-units recount, scan insert, audit insert, unit update, box-units update, alloc
update, manifest release RPC, box reopen/decrement — well under the 50-subrequest limit. No
per-row loops.

## Scanner changes

- **Part 1:** box-create on the PACK station gets an optional capacity field; PACK surfaces the
  `BOX FULL` hard block + the `box_full` auto-close prompt.
- **Part 2:** none required — the RESTOCK station already exists with its reason picker. Optional
  copy tweak: relabel "Restock" → "Restock / Remove from box" and update the hint so the dispatch
  team knows this is the scan-out station.

## Out of scope
- Bin/location tracking, partial-carton merges, capacity by weight/volume.
- Reversing a `shipped` unit's historical shipment totals (intentional — reinward is a new event).

## Build order
1. Migration `dispatch_box_capacity_v1` (additive column).
2. lotopsproxy: `postPack` capacity guard + `postRestock` rewrite (target/eligibility/reversal) +
   optional `decrement_box_unit_count` RPC. Commit → push → `npx wrangler deploy`.
3. `02_scanner`: capacity entry on box-create + BOX-FULL handling; optional RESTOCK relabel. Deploy.
4. Manual: update the Depot + Scanner (Redline-folded) chapters for both features.
5. Slack: reply to Padmajit's thread.
