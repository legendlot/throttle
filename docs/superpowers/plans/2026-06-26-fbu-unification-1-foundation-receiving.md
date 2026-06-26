# FBU Unification · Plan 1 — Foundation + Receipt-Side Receiving

> **For agentic workers:** execute task-by-task. **No unit-test harness** — "verify" = live Supabase SQL / worker curl / authenticated browser smoke. Sequence per task: migration → worker (edit→commit→push→`cd 01_worker && npx wrangler deploy`) → app (commit→push auto-deploys) → verify. **Snapshot before every data touch.** Steps use `- [ ]` for tracking.

**Goal:** Make a received FBU unit land in `stock_ledger` as a first-class part (`<PROD>-CAR-01`/`-RM-01`) via **receiver-declared format**, with `source` tagging and a soft purchase-vs-receipt **mismatch warning** — while production stays untouched via a **dual-write bridge** to `fbu_stock`.

**Architecture:** Receipt-side format becomes the *binding* explode driver (`shipments.receive_format`, set by the receiver at shipment creation); the PO's `receive_format`/`item_type` demote to *advisory* (cost + mismatch warning only). FBU receiving lands 1:1 as ordinary `line_type='parts'` rows on the built-part codes (which already exist for pure-FBU SKUs), posting to `stock_ledger` at GRN **and** mirroring to `fbu_stock` (bridge) so existing `issue_mode='fbu'` production keeps working. Source/ext_run + `qty_received` write-back added.

**Tech Stack:** Supabase Postgres (`store`/`public`), Cloudflare Worker `lotopsproxy` (`01_worker/worker.js`), Next.js static-export Garage (`05_Throttle/apps/garage`).

**Spec:** `docs/superpowers/specs/2026-06-26-fbu-outsourced-unification-design.md` (§3.4, §4).

**Scope of THIS plan (Plan 1 of 4):**
- ✅ `grn_register.source` + `ext_run_no` columns.
- ✅ Receipt-side format declaration drives the receiving explode (replaces PO-marker OR).
- ✅ FBU receipt lands as `stock_ledger` built-parts (pure-FBU SKUs only) + **dual-write to `fbu_stock`** (bridge).
- ✅ `source='fbu_purchase'` on built-part GRN; soft mismatch warning; `po_lines.qty_received` write-back.
- ❌ **NOT** in Plan 1 (later plans): production cutover off `fbu_stock` (Plan 2); `bom_format='ANY'`/`FBU` + format-aware matcher (Plan 2); Shadow/dual-format + `SH-CAR-01` mint (Plan 2); live-stock migration + `fbu_stock` retirement (Plan 2); outsourced collapse + `EXT_INW`/pool removal (Plan 3); dead-code/heuristic cleanup (Plan 4).

**Pure-FBU SKUs in scope (built-part codes already exist):** Rift (`RI-CAR-01`,`RI-RM-01`), Rumble (`RU-CAR-01`,`RU-RM-01`), Dash (`DS-CAR-01`), Mac (`MA-CAR-01`), Nitro (`NT-CAR-01`). FBU POs show `remote_qty>0` only for Rift/Rumble — so only they land a `-RM-01` line; Dash/Mac/Nitro land car-only.

---

## Task 1: Migration `fbu_grn_source_v1`

**Files:** Supabase migration (via `apply_migration`).

- [ ] 1a. Snapshot: `CREATE TABLE store.safety_grn_register_2026_06_26 AS SELECT * FROM store.grn_register;`
- [ ] 1b. Add columns (additive, nullable — no behavior change until the worker writes them):
```sql
ALTER TABLE store.grn_register ADD COLUMN IF NOT EXISTS source text;        -- 'fbu_purchase' | 'jobwork' | NULL (legacy/parts)
ALTER TABLE store.grn_register ADD COLUMN IF NOT EXISTS ext_run_no text;     -- EXT-NNN when source='jobwork' (Plan 3)
```
- [ ] 1c. Verify: `SELECT column_name FROM information_schema.columns WHERE table_schema='store' AND table_name='grn_register' AND column_name IN ('source','ext_run_no');` → expect 2 rows.
- [ ] 1d. Advisors clean: `get_advisors(type:'security')` shows no NEW issue attributable to grn_register (it already has RLS; columns are additive).

---

## Task 2: Worker — receipt-side explode in `seedReceivingLinesFromPO`

**File:** `01_worker/worker.js` — `seedReceivingLinesFromPO` (~778–932).

**Change:** make the **declared shipment format** (`shipReceiveFormat`) the *sole* driver of the explode decision, and make the FBU branch produce ordinary built-part `line_type='parts'` rows (not a single `line_type='fbu'` row). The PO line's `receive_format`/`item_type` are no longer read for the explode decision (they become advisory — used only for the mismatch warning in Task 4).

- [ ] 2a. Replace the three predicates (lines ~786–793) so they key on the **declared** format, not the PO line:
```javascript
const fmt = String(shipReceiveFormat || '').toUpperCase();   // 'CKD' | 'SKD' | 'FBU' | 'PARTS' (declared at receipt)
const isSkdLine = ()  => fmt === 'SKD';
const isFbuLine = ()  => fmt === 'FBU';
// A product-level unit line (no explicit part_code) under a CKD-declared shipment explodes the CKD BOM.
const isCkdUnitLine = (l) => fmt === 'CKD' && !l.part_code && !!l.product;
```
- [ ] 2b. In the FBU branch (the `else` at ~893–904), when `isFbuLine()`, emit **built-part rows** instead of one `line_type='fbu'` row. Replace the `else` block with:
```javascript
} else if (isFbuLine()) {
  // Receipt-side FBU: land the built unit 1:1 as ordinary parts on the built-part codes.
  // car_qty → <PROD>-CAR-01 ; remote_qty → <PROD>-RM-01 (only when the PO carries remote_qty>0).
  const carQty    = Math.round((Number(l.qty_ordered) || 0) - (Number(l.qty_received) || 0));
  const remoteQty = Math.round(Number(l.remote_qty) || 0);
  const carCode   = builtPartCode(l.product, 'car');     // helper added in 2c
  const rmCode    = builtPartCode(l.product, 'remote');
  if (carCode && carQty > 0) addExploded(l, { part_code: carCode, part_name: `${l.product} — Car`,  variant_model: 'Common' }, carQty,    false, 0);
  if (rmCode  && remoteQty > 0) addExploded(l, { part_code: rmCode,  part_name: `${l.product} — Remote`, variant_model: 'Common' }, remoteQty, true,  0);
} else {
  // genuine part-level line (real part_code) — received 1:1, no explosion
  const qtyExp = (Number(l.qty_ordered) || 0) - (Number(l.qty_received) || 0);
  pending.push({
    part_code: l.part_code || '', part_name: l.description || l.part_code || '',
    product: l.product || null, variant: l.variant || null, color: l.color || null,
    line_type: 'parts', component_type: l.component_type || null,
    qty_expected: Math.round(qtyExp), bags_of: bagSizeMap[l.part_code] || 50,
  });
}
```
(Note: `addExploded` already writes `line_type:'parts'` and sets `component_type` from the `isRemote` flag — so FBU lines flow through the GRN parts path automatically. The old `line_type:'fbu'` / `part_code=product.substr(0,8)` path is gone.)
- [ ] 2c. Add a module-scope helper near `isLumpSum` (~278) that resolves a product's built-part code by convention, with a DB-backed fallback for non-standard prefixes:
```javascript
// Built-unit part code for an FBU receipt. Convention <2-letter prefix>-CAR-01 / -RM-01,
// resolved against bom_register so a non-conventional code still maps. Cached per request via closure.
async function builtPartCodeResolver() {
  const r = await query('bom_register', `?or=(part_code.like.*-CAR-*,part_code.like.*-RM-*)&is_active=eq.true&select=product,part_code,part_category`);
  const map = {}; // `${product}|car|remote` → code
  for (const row of (r.ok ? r.data : [])) {
    const comp = String(row.part_category||'').toLowerCase()==='remote' || /-RM-/.test(row.part_code) ? 'remote' : 'car';
    map[`${row.product}|${comp}`] = row.part_code;
  }
  return (product, comp) => map[`${product}|${comp}`] || null;
}
```
Then in `seedReceivingLinesFromPO`, before the loop, build `const builtPartCode = await builtPartCodeResolver();` (only the FBU branch uses it; harmless for other formats). Replace the `builtPartCode(...)` calls in 2b accordingly.
- [ ] 2d. `node --check 01_worker/worker.js` (syntax). Commit `worker.js`; push; `cd 01_worker && npx wrangler deploy`; record the version id.
- [ ] 2e. Verify (no real stock touched — seeding only writes `receiving_lines`, GRN is Task 3): create a synthetic FBU shipment for **Nitro** (small footprint) against a throwaway PO, confirm the seeded `receiving_lines` are `line_type='parts'`, `part_code='NT-CAR-01'`, qty = ordered, **no** `line_type='fbu'` row. SQL after seeding:
```sql
SELECT part_code, line_type, component_type, qty_expected FROM store.receiving_lines WHERE shipment_id = '<TEST_SHP>';
-- expect: NT-CAR-01 / parts / car / <qty>   (and a -RM-01 row ONLY if remote_qty>0)
```

---

## Task 3: Worker — GRN posts built-parts to `stock_ledger` + dual-write bridge + source + qty_received

**File:** `01_worker/worker.js` — `raiseGRNFromReceiving` (~16028–16122).

**Change:** built-part FBU lines are now `line_type='parts'`, so they already flow through the parts path → `grn_register` + `bulk_update_stock_received` (stock_ledger). Add: (i) the `fbu_stock` **bridge** mirror when the shipment is FBU-declared, (ii) `source`/`ext_run_no` on the GRN rows, (iii) `po_lines.qty_received` write-back. **Remove** the `fbuLines → fbu_grn_register` path (FBU lines are no longer `line_type='fbu'`).

- [ ] 3a. Delete the `const fbuLines = lines.filter(l => l.line_type === 'fbu')` block and its `for (const l of fbuLines)` loop (the `fbu_grn_register` insert + `update_fbu_stock_received`). All lines are now `partsLines`.
- [ ] 3b. On the `grn_register` insert rows for this GRN, set `source` + `ext_run_no`:
```javascript
const ship = /* already fetched shipment row */;
const isFbuShip = String(ship.receive_format || '').toLowerCase() === 'fbu';
// ...in the grn_register row object:
source:     isFbuShip ? 'fbu_purchase' : null,   // Plan 3 sets 'jobwork'+ext_run_no for vendor returns
ext_run_no: null,
```
- [ ] 3c. After the parts post (`bulk_update_stock_received`) succeeds, mirror FBU built-parts into `fbu_stock` (transition bridge — removed in Plan 2):
```javascript
if (isFbuShip) {
  for (const l of partsLines) {
    const delta = grnDelta(l);
    if (delta <= 0) continue;
    const comp = (String(l.component_type||'').toLowerCase()==='remote' || /-RM-/.test(l.part_code)) ? 'remote' : 'car';
    await rpc('update_fbu_stock_received', {
      p_product: l.product, p_variant: l.variant || null, p_color: l.color || null,
      p_qty: delta, p_component_type: comp,
    });
  }
}
```
(Respects the 50-subrequest limit: FBU shipments are ≤ a few product lines. If a future FBU shipment exceeds ~40 lines, batch — out of scope here.)
- [ ] 3d. Write `po_lines.qty_received` back (robustness, all formats). After the GRN posts, for each `(po, part_code)` GRN'd this call, `UPDATE store.po_lines SET qty_received = qty_received + delta` — but PO-line granularity for exploded unit lines is by product, not part. **Scope the write-back to part-level lines only in Plan 1** (the safe subset): for shipments whose PO lines carry a real `part_code`, bump that line; for unit lines (null part_code) defer to Plan 2 (where the format model is complete). Implement:
```javascript
// Only part-level PO lines (real part_code) get qty_received written back in Plan 1.
const poRef = ship.po_reference;
if (poRef) {
  for (const l of partsLines) {
    const delta = grnDelta(l);
    if (delta <= 0) continue;
    // match a part-level PO line by (po_number, part_code); skip if none (unit line) — Plan 2 handles unit lines
    const plR = await query('po_lines', `?po_number=eq.${encodeURIComponent(poRef)}&part_code=eq.${encodeURIComponent(l.part_code)}&select=line_no,qty_received&limit=1`);
    if (plR.ok && plR.data[0]) {
      await update('po_lines', { qty_received: (Number(plR.data[0].qty_received)||0) + delta }, `po_number=eq.${encodeURIComponent(poRef)}&part_code=eq.${encodeURIComponent(l.part_code)}`);
    }
  }
}
```
- [ ] 3e. `node --check`; commit; push; `cd 01_worker && npx wrangler deploy`; record version id.
- [ ] 3f. Verify end-to-end on the synthetic **Nitro** shipment from Task 2 (snapshot `stock_ledger`+`fbu_stock` first):
```sql
CREATE TABLE store.safety_sl_nitro_2026_06_26 AS SELECT * FROM store.stock_ledger WHERE part_code='NT-CAR-01';
CREATE TABLE store.safety_fbu_nitro_2026_06_26 AS SELECT * FROM store.fbu_stock WHERE product='Nitro';
```
Count the synthetic shipment, raise the GRN, then:
```sql
-- stock_ledger NT-CAR-01 total_received increased by qty; closing recomputed
SELECT part_code, total_received, closing_stock FROM store.stock_ledger WHERE part_code='NT-CAR-01';
-- fbu_stock Nitro mirrored by the same qty (bridge)
SELECT product, variant, color, qty_on_hand FROM store.fbu_stock WHERE product='Nitro';
-- grn_register row carries source='fbu_purchase'
SELECT grn_no, part_code, qty_received, source, ext_run_no FROM store.grn_register WHERE grn_no='<GRN>';
```
Then **revert the synthetic data** (delete the test shipment/receiving_lines/grn rows; restore `stock_ledger`/`fbu_stock` from the safety snapshots) so no test qty pollutes live stock. Drop the synthetic PO.

---

## Task 4: Worker + App — receiver declares format + soft mismatch warning

**Files:** `01_worker/worker.js` (shipment-creation handler — `createShipment`/`createReceivingShipment`, find via `grep -n "seedReceivingLinesFromPO(" 01_worker/worker.js`); `05_Throttle/apps/garage/src/app/(auth)/receiving/page.js` + the create-shipment entry (the "create shipment from PO" control, likely `getUpcomingShipments` consumer).

- [ ] 4a. Worker: the shipment-creation handler must accept a `receive_format` from the request body (the receiver's declaration) and persist it on the `shipments` row (it already has the column). Default to the PO's advisory format (`po.receive_format` lower-cased) when the caller omits it. Pass it as `shipReceiveFormat` into `seedReceivingLinesFromPO` (already wired — confirm the call uses `ship.receive_format`).
- [ ] 4b. Worker: compute the **mismatch warning** at shipment creation. Fetch the PO's advisory format (max of `po_lines.receive_format`/`item_type` for the PO); if the declared `receive_format` differs, return it in the response:
```javascript
const declared = (body.receive_format || po.receive_format || '').toLowerCase();
const intended = (po.receive_format || '').toLowerCase();   // advisory
const warning = (intended && declared && declared !== intended)
  ? `Purchased format (${intended.toUpperCase()}) ≠ received format (${declared.toUpperCase()}) — escalate.`
  : null;
return ok({ shipment_id, receive_format: declared, warning });
```
(Non-blocking — the shipment is created regardless. Received is truth.)
- [ ] 4c. App: on the create-shipment-from-PO control, add a **format selector** (CKD / SKD / FBU / Parts) defaulting to the PO's advisory format; send the chosen value as `receive_format`. Render the returned `warning` as a dismissible amber banner (non-blocking) on the receiving page.
- [ ] 4d. `node --check` worker; `npx turbo build --filter=garage` green. Commit+push worker (`cd 01_worker && npx wrangler deploy`) and app (auto-deploys).
- [ ] 4e. Verify (authenticated browser smoke): create a shipment from a Nitro FBU PO, **change the declared format to CKD** → confirm the amber mismatch banner appears, the shipment still creates, and the worksheet seeds as CKD (granular) — then recreate as FBU and confirm built-part lines. Use a throwaway PO; clean up after.

---

## Task 5: Knowledge + snapshots cleanup

- [ ] 5a. Confirm all `safety_*_2026_06_26` snapshot tables created in Tasks 1/3 are either retained (grn_register snapshot — keep until Plan 2 cutover verified) or dropped (the Nitro stock snapshots, once the synthetic test is reverted and confirmed clean).
- [ ] 5b. Update `systems/lotops.md` + `BUSINESS_RULES.md` (RULE-FBU-001 / RULE-SKD-001) to note: *receipt-side declared format is the binding explode driver (Plan 1 live); FBU receipts land as `stock_ledger` built-parts with `source`, dual-written to `fbu_stock` during transition; production still consumes `fbu_stock` until Plan 2.* Add a `[lotops]` BACKLOG line tracking Plans 2–4.
- [ ] 5c. Commit knowledge (root repo) — the brain-sync hook will also auto-push.

---

## Self-review notes (covered vs deferred)

- **Spec §3.4 (source attribution)** → Task 1 (cols) + Task 3b (`source='fbu_purchase'`). `jobwork` deferred to Plan 3.
- **Spec §4 (receipt-side format, binding truth)** → Task 2 (explode driver) + Task 4 (declaration UI + mismatch warning).
- **Spec §4 (FBU lands 1:1)** → Task 2b/2c.
- **Spec §4 (`qty_received` write-back)** → Task 3d (part-level subset in Plan 1; unit lines in Plan 2).
- **Bridge safety (production untouched)** → Task 3c dual-write; Plan 1 does NOT touch `getProductionRun`/`issueAgainstRun`/`setRunIssueMode`, so `issue_mode='fbu'` runs keep deducting `fbu_stock` unchanged.
- **Deferred (by design):** `bom_format` ANY/FBU + matcher, Shadow/`SH-CAR-01`, live-stock migration, `fbu_stock` retirement → Plan 2. Outsourced collapse → Plan 3. Dead-code cleanup → Plan 4.

---

## Roadmap — follow-on plans (each its own bite-sized plan after Plan 1 ships + is floor-proven)

- **Plan 2 — Production cutover & migration.** `bom_format` += `FBU`/`ANY`; retag kit→`ANY` + built-car/remote→`FBU`; format-aware matcher (`IN(runFmt,'ANY')`) across `getProductionRun`/`calcKit`/`getProducibility`/`getPartCoverage`/`checkRunBomStock`; mint `SH-CAR-01` + Shadow dual-format BOM; reframe `setRunIssueMode` as the store fulfillment toggle; unit-line `qty_received` write-back; **migrate `fbu_stock` balances → `stock_ledger` (Piyush physical counts), stop the dual-write, freeze `fbu_stock`.**
- **Plan 3 — Outsourced collapse.** EXT run = issue raw CKD build parts + "issue more to vendor" supplementary + GRN built cars `source='jobwork'`+`ext_run_no`; recompute `ext_summary`; remove `EXT_INW`/`ext_return_pool`/`markRunSentOut`→`requestExtFinish`→`assignOutsourcedLine`→`receiveExtUnits`→`postExtInw`; scanner `outsourced` category removal; in-flight EXT-run migration.
- **Plan 4 — Retirement & cleanup.** Remove `fbu_includes_remote`, `fbu_products` heuristic, dead `fbu_grn_register`/`fbu_issue_register` readers, RULE-EXT-001 dedup warning; finalize rule docs.
