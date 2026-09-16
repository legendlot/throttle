# Snorkel: purchase-unit conversions + automated `unit_cost` derivation (S385, 2026-09-16)

Two linked backlog items (`backlog/snorkel.md`), both approved by Afshaan 2026-09-16:
- **(A) Roll/kg/Packet conversion store** — parts bought in a bulk unit have nowhere to store pieces-per-unit, so no per-piece cost can derive.
- **(B) `unit_cost` automation** — decided 2026-09-10 (decisions § "`material_master.unit_cost` is AUTOMATED"), never built (verified 2026-09-16: no trigger, no function, no worker code).

## Decisions taken by the lane (assumptions, stated)
- Conversion lives on **`store.material_master`** (RULE-014 precedent: new part dimensions are columns, never a side table): `purchase_uom text` + `pieces_per_purchase_uom numeric(12,4)`. `store.material_current` view re-created with both appended LAST.
- **kg is NOT stored as a conversion** — for a `kg` line the factor is `1000 / weight_per_unit_grams` (RULE-014: weight is the single source of truth for screws). A re-weigh flows through automatically.
- Derivation is a **SQL function** `store.derive_unit_costs(p_part_codes text[] DEFAULT NULL, p_apply boolean DEFAULT true)` owned by the lane; the worker only calls it. Every evaluation is logged to `store.unit_cost_derivations` (auditable, re-runnable).
- Edit surface: a Snorkel **LIBRARY → Purchase units** page (`/library/purchase-units`), gated on `po_create` (buyers set it; no new permission key). Lists parts that have any non-`pcs` India PO line, with the current conversion editable and a per-piece preview.
- Hook: `acceptPO` (the terminal state of request-raised POs, see the comment there) re-derives the part codes on that PO after the requester DM. Plus an explicit `rederiveUnitCosts` action (full pass, `po_create`) for the page's "Re-derive all" button.

## Derivation rules (encode exactly — the S369/S370 rule set)
1. Candidate lines per part: `store.po_lines l JOIN store.purchase_orders p ON p.po_number=l.po_number` where `p.source='India'`, `lower(p.status)<>'cancelled'`, `l.unit_price>0`, and the line unit is convertible:
   - `lower(trim(l.unit))='pcs'` → factor 1
   - `lower(trim(l.unit))='kg'` and `weight_per_unit_grams>0` → factor `1000/weight_per_unit_grams`
   - `purchase_uom IS NOT NULL` and `lower(trim(l.unit))=lower(purchase_uom)` and `pieces_per_purchase_uom>0` → factor `pieces_per_purchase_uom`
   - anything else → not a candidate.
   Per-piece price = `unit_price / factor`.
2. Latest PO wins (`max(p.created_at)`, tie-break `po_number desc`). Within that PO, if the part's candidate lines span more than one `coalesce(mould_no, description)` → **not applied**, reason `mixed_moulds` (S369b: different parts sharing one code). Else the value is the **qty-weighted mean** of per-piece across those lines.
3. Detectors, both, always:
   - `category_absolute`: value ≥ 100 and `part_category IN ('Sticker','Fastener','Packaging','Accessories','Consumables')` → reject.
   - `family_outlier`: family = first two dash-segments of `part_code` (`<PREFIX>-<TYPE>`); median of OTHER active family members' current `unit_cost`; if median>0 and value/median > 15 → reject.
4. Apply only when `p_apply` and the value differs from the current `unit_cost`. **Never null an existing value** (no candidate lines → reason `no_lines`, untouched).
5. Log every evaluated part: `store.unit_cost_derivations(run_id uuid, part_code, old_cost, new_cost, applied bool, reason text, po_number, line_unit, factor, run_at)`.

## Tasks
1. **Lane (SQL):** snapshot `store.safety_material_master_unit_cost_2026_09_16 AS SELECT * FROM store.material_master`; migration `snorkel_purchase_units_and_unit_cost_derivation_v1` (columns + CHECK `pieces_per_purchase_uom > 0`, view re-create, log table + RLS + service_role grant, function, `NOTIFY pgrst, 'reload schema'`); seed `UNV-PP-SHRINK-1418-01` = `Roll` / 2200 (Afshaan 2026-09-03); dry run (`p_apply=false`) over all parts, inspect every row that would change an existing value, then apply.
2. **Builder (snorkelops):** actions `listPurchaseUnits` (parts with ≥1 non-pcs India line: part_code, name, category, current purchase_uom/pieces, weight, the distinct non-pcs units seen with their latest unit_price, current unit_cost, per-piece preview), `setPurchaseUnit` (`po_create`; validates uom text ≤ 20 chars, pieces > 0; writes material_master + updated_at; then calls `derive_unit_costs` for that code and returns the log row), `rederiveUnitCosts` (`po_create`; optional part_codes; returns the applied/rejected counts + rows). `acceptPO`: after the DM, `waitUntil(rpc('derive_unit_costs', { p_part_codes: [...codes on the PO] }))` — never block the accept on it, never let it throw into the response.
3. **Builder (Snorkel app):** `/library/purchase-units/page.js` + nav item (`requires: 'po_create'`), table with inline edit of the two fields, per-piece preview, a "Re-derive all" button showing the result summary; follows the Addresses page's shape. Tests: pure helpers (unit normalisation, per-piece preview) lifted from source like `prior-tds.test.mjs`; `node --test snorkelops-worker/test/*.test.mjs` green.
4. **Manual-builder:** new chapter "Purchase units" under Library; bump patch; both renders.
5. **Lane:** hostile review → commit → push → `npx wrangler deploy` in `snorkelops-worker` → `tools/wait-deploy.sh snorkel` → smoke.

## Pass conditions (from the backlog)
- `UNV-PP-SHRINK-1418-01` per-piece derives to ≈ ₹2.29 (₹5,040 / 2,200) from stored data alone.
- `HW-SC-23-8` stays ≈ ₹0.35 (its `pcs` lines) — the kg line converts via weight to ₹0.29 and is older, so the latest-PO rule decides; either is within the ~10% bar of ₹0.38 only for the pcs value, which is what the latest PO gives.
- A second run with no new POs changes 0 rows (idempotent).
