# Bag Sticker Tool — Design

> Date: 2026-06-11 (Session 123) · Author: Afshaan + Claude
> Status: Approved — building.
> System: Garage (LOT Ops) · Worker: lotopsproxy

## Problem

Bag QR stickers (the labels the floor scans at picking/receiving) are minted **only**
during the receiving flow — `generateBags` / `generateBagsForShipment` (shipment lines)
and `generateBagsForGrn` (direct GRNs). Physical bags that have **no** scannable label
(old stock, a torn/lost label, a bag that never got one) cannot be made scannable —
there is no standalone "print me a bag sticker" path.

Piyush (#bugs, 2026-06-11): *"create a option somewhere under stores to generate
stickers for the bags (items) which don't have one. The sticker should not have any
effect on the stock."*

## Goal

A small admin utility in Garage that prints bag QR stickers for a **legitimate part
code**, on demand, **without changing stock**.

## Key facts (grounding)

- Bag generation today is **already stock-neutral**: `generateBags*` only insert rows into
  `store.bags`; stock is credited separately at GRN/receipt (`bulk_update_stock_received`).
  So "no stock effect" is satisfied by construction.
- A bag is a scannable container carrying a `qty`. The floor scans it at Store Issue to
  pick/issue. Therefore printing extra labels for a part that already has bags creates
  **more scannable quantity** → over-issue risk. This is operational, not a code concern —
  surface a warning on-screen; do not block.
- Bag labels print via the **browser** print path `buildBagLabelsHtml(bags, ref) +
  printWindow()` (from `@throttle/ui`), NOT the thermal-printer `print_jobs` queue
  (which only handles `PKG_LABEL` / `BOX_LABEL`). Garage's GRN page
  (`generateAndPrintBags` → `generateBagsForGrn`) is the direct template.
- `store.bags` columns: `bag_id` (PK text, the QR content), `line_id`, `shipment_id`,
  `mark_code`, `part_code`, `part_name`, `qty`, `bag_seq`, `total_bags`, `bin_code`,
  `grn_no`, `product`, `created_at`. No `created_by` column.

## Design

### Access & placement
- New permission key **`bag_sticker`** (bool). Granted in `store.roles` to **store_head,
  production_manager, admin, super_admin** (same set as `gate_pass`).
- New PERM_DEFS group "Bag Stickers" in Garage `/users`.
- Nav item **"Bag Stickers"** in the Garage **INVENTORY** group (next to GRN / Receiving,
  where bag labels already originate), gated `hasPermission(p,'bag_sticker')`.

### UI — `apps/garage/src/app/(auth)/bag-stickers/page.js`
- **Part search combobox** — source `getMaterials` (→ `material_current`), filtered to
  active parts; searchable by code or name; renders `PART-CODE — Part Name (Product)`.
  Selecting a part prefills the default bag size from its `bag_size`.
- **Two number fields** — *Bag size* (pieces per bag, prefilled, editable) and
  *Number of bags*.
- **Live preview** — "N bags × M = N·M pieces".
- **Generate & Print** button → `workerFetch('generateManualBags', { data })` →
  `buildBagLabelsHtml(res.data.bags, 'MANUAL') + printWindow()`.
- **Reprint last batch** button (reprints the just-created bags held in state — so a failed
  print never tempts re-generating, which would create duplicate scannable bags).
- On-screen note: *"Does not change stock. Only print for physical bags missing a label —
  printing extra labels creates extra scannable bags."*

### Worker — `generateManualBags` (JWT POST, lotopsproxy)
- `if (!canBagSticker(P)) return err('No permission', 403);` as first line (RULE-011).
- Input: `part_code`, `bag_size`, `num_bags`.
- Validate: part exists AND is active in `material_master` (reject unknown/inactive — the
  "legitimate part codes" requirement); `bag_size` ≥ 1; `num_bags` 1–500 (runaway cap).
- Resolve `part_name` + `product` from `material_master`.
- Insert `num_bags` rows into `store.bags`:
  - `bag_id = BAG-<part_code>-MAN-<base36(Date.now())>-<seq3>` (globally unique),
  - `qty = bag_size`, `bag_seq = 1..N`, `total_bags = N`,
  - `grn_no = 'MANUAL'` (audit tag), `line_id`/`shipment_id`/`mark_code`/`bin_code` = NULL,
    `product` = material_master product.
- **No `stock_ledger` write.**
- Return `ok({ bags_created: N, bags: <inserted rows> })` (same shape `generateBagsForGrn`
  returns, so the print helper consumes it unchanged).
- Add `const canBagSticker = p => !!p.bag_sticker;` near `canGatePass`.

### Stock behaviour
None. Pure label generation.

### Audit
`grn_no = 'MANUAL'` + `created_at` identify/filter these bags. No `created_by` (no column;
skipped for v1 per Afshaan).

### Edge cases / guards
- Unknown / inactive part → reject (422/400).
- `bag_size < 1` or `num_bags` out of 1–500 → reject.
- Universal parts (`HW-*`/`UNV-*`, product `Universal`) → allowed; `product` set from
  material_master. Scanning matches on `part_code` (postRunPick ignores `line_id`), so a
  manual bag picks like any other.

## Out of scope (YAGNI)
- No thermal-printer (`print_jobs`) integration — browser print only.
- No "who printed it" trail (no column).
- No editing/deleting generated bags from this screen (bags are managed elsewhere).

## Files
- `01_worker/worker.js` — `canBagSticker` + `generateManualBags`.
- `05_Throttle/apps/garage/src/app/(auth)/bag-stickers/page.js` — new.
- `05_Throttle/apps/garage/src/lib/nav.js` — INVENTORY nav item.
- `05_Throttle/apps/garage/src/app/(auth)/users/page.js` — PERM_DEFS group.
- `store.roles` — grant `bag_sticker` to store_head / production_manager / admin / super_admin.
