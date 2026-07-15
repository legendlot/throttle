# Snorkel — Mould-based procurement (order by mould, receive by part)

> Design spec · 2026-07-15 · System: Snorkel (procurement) + lotopsproxy (receiving)
> Status: approved (design), pre-implementation

## Problem

Some India-sourced components are **injection-moulded parts LOT owns the mould for** — a
vendor runs our mould and injection-moulds the parts (the vendor also buys the plastic, so
they charge a finished-part block price, not a job-work/shift rate). A single mould is a
**family mould**: one mould produces many distinct part codes (e.g. mould `25306` → part
codes P1…P10), in a **fixed ratio per shot** (the cavity layout).

The procurement team orders **by mould** because that is the only unit the vendor
understands — "mould 25306 × 2000 shots". But the store team needs the **exact part codes**
to inward stock. That mould → part-code mapping has no home in the system today, so
procurement takes a shortcut: they raise a **one-line PO carrying the mould number**, and to
make it receivable they overload a **fake aggregate part code** (observed live: `D1-PB-40`
renamed *"Remote Parts (Mold No :- 25306)"*, ordered 2000, on shipment SHP-116). The result:
2000 shots' worth of a whole mould is inwarded as 2000 of one made-up part, and the real
constituent parts never hit `stock_ledger` at their true codes.

## Goal

Let procurement keep ordering **by mould** (one PO line = one mould, priced as one block cost),
while the store receives **by part code** — the mould line **explodes into its constituent
parts at receiving**, exactly the way a full-CKD product order already explodes into its BOM
parts today. No change to the store's receiving/GRN experience; the only new machinery is the
**PO → receiving conversion** for mould lines and a home for the mould → parts mapping.

### Non-goals (explicitly out of scope for v1)
- **Per-part cost allocation.** Cost stays at mould grain (one block rate per shot). Parts
  inward at **quantity only** — no cost split down to the part code.
- **Per-shot / per-shift cost detail on the PO.** Not required (vendor buys the plastic).
- **Coverage / supply-status mould-awareness.** `getPartCoverage` / `getSupplyStatus` remain
  part-grain and will show mould-ordered parts as "not ordered" until taught to expand mould
  lines — deferred to v2 (see Follow-ups).
- **`po_lines.qty_received` write-back.** Pre-existing gap across all PO types; unchanged here.
- **Multi-vendor moulds.** One vendor per mould (confirmed).

## Confirmed semantics (from brainstorming)
- **Quantity = shots × parts-per-shot.** Ordering N shots of a mould yields, per constituent
  part, `N × qty_per_shot`. The per-shot count is fixed per (mould, part). Shot count can vary
  per order (usually one or two shifts' worth) but is always the multiplier.
- **Money = one block cost at mould grain.** PO line is `Mould × N shots @ block-rate`. No
  per-part or per-shift breakdown on the PO.
- **Receiving is unchanged for the floor.** Explosion happens at receiving-line generation,
  like the CKD-product → BOM explosion; the store then counts/GRNs the real part codes exactly
  as they do for any parts shipment.
- **Mould-map editing gated to `po_create`** (procurement managers). View gated to
  `procurement_view`.

## Data model (new tables, `store` schema)

Both tables RLS-on / service_role-only (RULE-RLS-001), `GRANT ALL … TO service_role`.
`store` is already on the PostgREST exposed-schemas list — no schema-list change.

### `store.moulds`
One row per physical mould LOT owns.

| column | type | notes |
|---|---|---|
| `mould_no` | text **PK** | vendor-facing mould number, e.g. `25306` |
| `description` | text | e.g. "Drift-1 Remote Parts" — shown on the PO/vendor doc |
| `vendor_code` | text | → `store.vendors.vendor_code` (loose ref); **one vendor per mould** |
| `hsn_code` | text | default HSN for the block; auto-fills the PO line |
| `gst_percent` | numeric | default GST %; auto-fills the PO line |
| `default_shot_rate` | numeric null | optional default block rate/shot; overridable per PO |
| `is_active` | boolean default true | deactivate rather than hard-delete a mould in use |
| `notes` | text null | |
| `created_at` / `updated_at` | timestamptz | |

### `store.mould_parts`
The mapping — which part codes a mould produces, and how many per shot.

| column | type | notes |
|---|---|---|
| `id` | bigint identity **PK** | |
| `mould_no` | text | → `store.moulds.mould_no`, `ON DELETE CASCADE` |
| `part_code` | text | → `material_master.part_code` (loose ref; validated in UI) |
| `qty_per_shot` | numeric NOT NULL | parts of this code produced per shot |
| `created_at` / `updated_at` | timestamptz | |
| | | `UNIQUE(mould_no, part_code)` |

Cardinality: a mould has many parts (1→N). A part *may* appear in more than one mould's map
without breaking explosion (explosion is always mould → parts), so no reverse-uniqueness is
enforced; in practice a part is moulded by one mould.

## PO line represents a mould

Add a nullable column to the shared `store.po_lines`:

| column | type | notes |
|---|---|---|
| `mould_no` | text null | set on a mould line; → `store.moulds.mould_no` (loose ref) |

A **mould line** is identified by `mould_no IS NOT NULL` and carries:
- `part_code` = NULL, `product` = NULL, `item_type` = `'Mould'` (explicit marker, mirrors how
  CKD lines are marked),
- `qty_ordered` = **shots**, `unit_price` = block rate per shot, `total_value` = shots × rate,
- `hsn_code` / `gst_percent` from the mould (overridable),
- `description` = mould description (so the vendor doc reads
  "Mould 25306 — Drift-1 Remote Parts × 2000 shots").

Nothing else on `purchase_orders` changes; the PO's money, GST split, approval chain, and print
path all operate at mould grain with no special-casing.

## Receiving explosion (lotopsproxy `computeReceivingRowsFromPO`)

Receiving stays in Garage/lotopsproxy (RULE: procurement ends at PO issue; lotopsproxy owns
`seedReceivingLinesFromPO` / `computeReceivingRowsFromPO` / GRN / `stock_ledger`). Add a new
branch, evaluated **first** (before the SKD/CKD/FBU/part branches):

```
isMouldLine(l) := !!l.mould_no
```

For each outstanding mould line (`qty_ordered − qty_received > 0`):
1. `shots = round(qty_ordered − qty_received)`.
2. Load `store.mould_parts` for the line's `mould_no` (batched across all mould lines on the PO
   via an `IN` filter — 50-subrequest limit).
3. Emit one receiving row per constituent part:
   - `part_code` = `mp.part_code` (the **real** code),
   - `qty_expected = round(shots × mp.qty_per_shot)`,
   - `part_name` / `bag_size` / `product` from `material_master` (batched `IN` on part_code —
     reuse the existing `material_current` bag-size lookup, extended to also pull part_name +
     product),
   - `line_type = 'parts'`, `component_type` = null (loose moulded parts are neither car nor
     remote units), `bags_of` = bag_size.

The mould branch explodes **unconditionally** on `mould_no` presence — unlike CKD it needs no
declared-shipment-format override (a mould line can only ever be a mould). The store then
counts/GRNs each exploded part into `stock_ledger` through the **existing** receiving flow —
zero change to the floor UX. `RE-SYNC FROM BOM` (`resyncReceivingFromBOM`) shares
`computeReceivingRowsFromPO`, so it picks up mould-map additions the same way.

## Snorkel worker (snorkelops) + app

### Worker actions (`05_Throttle/snorkelops-worker/src/index.js`)
- **Reads** (`procurement_view`): `getMoulds` (list + part-count + vendor name),
  `getMould` (header + its `mould_parts` joined to `material_master` names).
- **Writes** (`po_create`): `createMould`, `updateMould` (incl. `is_active` toggle),
  `setMouldParts` (replace the full part map for a mould — simplest correct write; the detail
  page sends the whole list).
- **PO create/edit** (`postPO` / `updatePO`): accept a mould line shape (`mould_no`, `qty` =
  shots, `unit_price`, `hsn_code`, `gst_percent`) → persist to `po_lines` with `mould_no` set,
  `part_code`/`product` NULL, `item_type='Mould'`.
- No cross-worker calls: the receiving explosion reads `store.mould_parts` directly (lotopsproxy
  is service_role on `store`).

### App (`05_Throttle/apps/snorkel`)
- **`/moulds`** — list (KPI: active moulds, parts mapped), gated `procurement_view`.
- **`/moulds/new`** + **`/moulds/detail`** — header form (mould_no, description, vendor picker,
  HSN/GST, default rate, active) + a **part-map editor**: rows of `Combobox` (searchable, from
  `getMaterials`) + `qty_per_shot`, add/remove rows. Edits gated `po_create` (view-only
  otherwise). Nav entry under the Procurement / Library group; `src/lib/nav.js` gate on
  `procurement_view`.
- **PO new/edit form** — a per-line **kind toggle: Part | Mould**. On *Mould*: pick the mould
  (`Combobox` from `getMoulds`), enter shots; rate + HSN/GST auto-fill from the mould
  (overridable). Show a **read-only "Will receive" preview** — the exploded parts × qty — so
  procurement sees exactly what the store will inward before issuing.
- **PO print/doc** — a mould line renders "Mould <no> — <description> × <shots> shots" at the
  block rate (existing print path; just reads the mould line's `description`/`qty`/`unit_price`).
- All part/mould pickers use the shared `Combobox` with `portal` (PATTERN-160 / the standard
  picker rule).

## Migration / cleanup of the existing hack
One-off, executed when the real mapping is provided:
1. Seed `store.moulds` + `store.mould_parts` from the mould → part-code sheet.
2. For the live case (mould `25306` → fake part `D1-PB-40 "Remote Parts (Mold No :- 25306)"`,
   shipment SHP-116): convert the open PO line to a mould line and re-seed the shipment's
   receiving lines (or patch in place), so the shipment receives the real constituent parts.
3. Sweep `material_master` for other "mould-as-a-part" aggregate codes (names containing
   "Mold No" / "Mould") and **soft-deactivate** them (RULE-004) once their moulds are mapped.
4. Snapshot touched `po_lines` / `receiving_lines` / `material_master` rows before any update
   (`store.safety_mould_*_2026_07_15`).

## Testing / verification
- **DB layer:** create a test mould with a known part map; raise a PO mould line for N shots;
  create a shipment against it; assert `computeReceivingRowsFromPO` returns one line per part at
  `N × qty_per_shot`; GRN one part and confirm `stock_ledger` moves at the real code.
- **Idempotency:** re-running `seedReceivingLinesFromPO` / `RE-SYNC FROM BOM` on the same
  shipment adds no duplicates (existing identity-key guard covers part-grain rows).
- **Non-mould PO byte-identical:** a PO with no mould lines produces byte-identical receiving
  rows to before (the mould branch is a pure addition gated on `mould_no`).
- **Authenticated browser smoke** (Afshaan / a `po_create` Snorkel login): create a mould +
  map, raise a mould PO, verify the "Will receive" preview, receive on the floor scanner-less
  Garage receiving screen.

## Affected surfaces
- **Migration:** new `store.moulds` + `store.mould_parts`; `store.po_lines.mould_no` column
  (additive). GRANTs + RLS.
- **lotopsproxy** (`01_worker/worker.js`): `computeReceivingRowsFromPO` mould branch (+ the
  shared `material_current` lookup extended to part_name/product). 3-system blast radius — needs
  explicit go-ahead + live-DB verification before deploy.
- **snorkelops** (`05_Throttle/snorkelops-worker/src/index.js`): mould read/write actions +
  PO-line mould shape in `postPO`/`updatePO`.
- **apps/snorkel**: `/moulds` pages, PO form line-kind toggle + preview, `nav.js`, print doc.
- **Docs:** new RULE-SNORKEL-005 in `systems/snorkel.md`; `reference/db-schema.md` re-gen
  (`/schema-sync`) after DDL.
