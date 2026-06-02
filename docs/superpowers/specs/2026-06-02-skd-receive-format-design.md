# SKD Receive Format — Design

> Session 94 · 2026-06-02 · author: Claude (autonomous, approved by Afshaan)
> Status: approved (design), building. Floor-blocking: SHP-048 (Flare Burnout) cannot inward.

## Problem

The vendor (Dowellin/Kai) shipped Flare Burnout as **SKD** (semi-knocked-down) — a
handful of pre-assembled bundle components per car (Half-Built Chassis, Accessories
Bag, Grip-Tyre Bag, Built-Up Remote, colour Top, + a few loose parts) — *coarser than
CKD, finer than FBU*. The system only understands **FBU** (built units → `fbu_stock`)
and **CKD/parts** (granular parts → `stock_ledger`). The SKD bundle components have no
part codes, no BOM, and aren't on any receiving line, so PO IN-PRD-0074 / shipment
SHP-048 cannot be inwarded — the two seeded receiving lines have empty `part_code`
("Flare Burnout Grey/Red [CKD]") and the GRN path keys everything on `part_code`.

## Design (approved)

A third receive format **SKD**, reusable across all products, keyed off format flags —
no per-product code.

### Data model
- **`store.bom_register.bom_format`** — new column, `text DEFAULT 'CKD'`. Existing rows
  backfilled to `'CKD'`. A product keeps its granular CKD rows AND gets SKD bundle rows.
- **`bom_current` view recreated** to expose `bom_format` (it's an explicit column list).
- **`receive_format = 'SKD'`** (po_lines, uppercase) / **`'skd'`** (shipments, lowercase)
  — already free-text columns, just new values. Mirrors the existing `FBU`/`fbu` split.
- **`work_orders.issue_mode = 'skd'`** — mirrors the existing `'fbu'` value.

### SKD part codes — separate from CKD
SKD parts get their **own SKD-encoded codes** (`FL-SKD-NN`) so SKD stock never commingles
with CKD stock — even where a CKD equivalent exists (top/splitter/diffuser/battery cover).
This is intentional (Afshaan): SKD-received goods are tracked as their own stock.

### SKD BOM = single source of truth
SKD BOM = `bom_register` rows tagged `bom_format='SKD'`, listing bundle components + per-car
qty. Drives BOTH receiving (explode × car qty) AND issuance (picklist). `variant_model`
follows RULE-NAME-002: common-across-variant parts = `'<model>'` (e.g. `Burnout`);
the colour Top = `'<model> <color>'` (e.g. `Burnout Grey`).

### Flare Burnout SKD BOM (from Piyush's received-parts list; qty 1/car unless noted)
| Code | Part name | variant_model | component_type |
|---|---|---|---|
| FL-SKD-01 | Half Built Chassis | Burnout | car |
| FL-SKD-02 | Accessories Bag | Burnout | car |
| FL-SKD-03 | Grip Tyre Bag | Burnout | car |
| FL-SKD-04 | USB Cable | Burnout | car |
| FL-SKD-05 | Screw Driver | Burnout | car |
| FL-SKD-06 | Splitter | Burnout | car |
| FL-SKD-07 | Diffuser | Burnout | car |
| FL-SKD-08 | Car Battery Cover | Burnout | car |
| FL-SKD-09 | Burnout Grey Top | Burnout Grey | car |
| FL-SKD-10 | Burnout Red Top | Burnout Red | car |
| FL-SKD-11 | Built Up Remote | Burnout | remote |

Assumptions (flagged to Piyush for correction): qty 1/car each; only the Top is
colour-specific; everything else is Burnout-common. Remote seeds at the PO's remote_qty.

### Receiving flow
SKD shipment → `seedReceivingLinesFromPO` explodes the product's SKD BOM: car-side
components × car_qty, remote components × remote_qty (handles the 347≠350 cleanly). For
common parts across colours, one line per part_code (qtys summed: Grey+Red). Team counts
actuals → GRN → `bulk_update_stock_received` bumps `stock_ledger`. **NOTE:** that RPC is
UPDATE-only (no upsert) → SKD codes must have pre-created `stock_ledger` rows.

### Issuance flow
SKD production run carries `issue_mode='skd'`; `getProductionRun` matcher filters BOM lines
to the run's format: `runFmt = wo.issue_mode==='skd' ? 'SKD' : 'CKD'`, then
`allBom.filter(b => variantModels.has(b.variant_model) && (b.bom_format||'CKD')===runFmt)`.
FBU/CKD runs keep picking CKD rows (default) — unchanged. **This filter is mandatory and
must ship before any SKD BOM rows exist**, else a CKD Flare run would wrongly pick SKD rows
(blast radius: every product's picklist).

### PO flip (backend)
Flip = set `po_lines.receive_format='SKD'` + `shipments.receive_format='skd'`, then re-seed
receiving from the SKD BOM. Afshaan does this from the backend (SQL); no flip UI needed for v1.

## Phasing
- **Phase 0 — unblock SHP-048 (data-only, no deploy dependency):** create the 11 SKD codes
  (material_master + stock_ledger) + Flare SKD BOM rows + manually seed SHP-048's 11
  receiving lines + flip the PO/shipment. Team inwards immediately.
- **Phase 1 — reusable feature (worker deploy):** migration (`bom_format` + view) + matcher
  format-filter (safety guard) + `seedReceivingLinesFromPO` SKD-explode (future auto-seed).

## Out of scope (follow-ups)
- BOM-editor format toggle + SKD run-creation UI (set `issue_mode='skd'`); for now set via
  backend when production builds these cars (days out — receiving is the blocker).
- PO-flip admin button (backend SQL suffices per Afshaan).

## Blast radius / safety
- The picklist matcher serves **every product**. Order: migration (col default CKD, all
  existing rows CKD) → deploy matcher guard → add SKD rows. `(b.bom_format||'CKD')` makes the
  worker backward-safe even pre-migration.
- Lotopsproxy serves Garage+Redline+Scanner — standard edit→commit→push→deploy, verify.
