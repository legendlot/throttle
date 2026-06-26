# FBU Run-Model Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **No unit-test harness in this codebase** — "verify" = live Supabase SQL / worker `curl` / authenticated browser smoke (the norm established by Plans 1–3). Headless agent CANNOT OAuth/JWT → all browser steps are handed to Afshaan as a smoke checklist; everything else is verified via SQL or worker version checks.
>
> **Deploy discipline (lotopsproxy = 3-system blast radius — Garage + Redline + Scanner):** every worker change is its own increment — `node --check 01_worker/worker.js` → commit → push → `cd 01_worker && npx wrangler deploy` → record the Cloudflare version id → verify before starting the next. Never batch two worker edits into one deploy. Apps auto-deploy on push (build them with `npx turbo build --filter=<app>` first, zero errors).
>
> **Snapshot before every data touch.** All snapshots use the suffix `_2026_06_27` (this session) so they don't collide with Plans 1–3's `_2026_06_26` snapshots.

**Goal:** Move the CKD/SKD/FBU format choice to **production** (declared at run-create, mandatory on Fresh/Repair), remove the **store-side flip** (`setRunIssueMode` → accept/reject only), correct **FBU car granularity to per-(variant,colour)**, and consolidate the **outsourced receive into the receiving flow with auto-close**.

**Architecture:** Builds on the shipped FBU unification (Plans 1–3, lotopsproxy `2b71bb09`): built car/remote are first-class `stock_ledger` parts; `bom_format ∈ {CKD,SKD,FBU,ANY}`; the picklist matcher filters `variant_model ∈ {Common, <variant>, <variant> <colour>}` AND `bom_format ∈ {runFmt, ANY}`. This refinement (a) re-mints the 4 wrongly-merged Common FBU car codes into per-(variant,colour) codes encoded with `variant_model='<variant> <colour>'` so the existing matcher picks the right one; (b) adds a run-level `format` to `createProductionRun`/`createRepairRun` that drives WO `issue_mode`; (c) deletes `setRunIssueMode` + its Garage UI; (d) surfaces/defaults FBU at run-create; (e) routes vendor-built receives through `postShipment` with an optional outsourced-run link + auto-close.

**Tech Stack:** Supabase Postgres (`store`/`public`), Cloudflare Worker `lotopsproxy` (`01_worker/worker.js`), Next.js static-export Garage + Redline (`05_Throttle/apps/{garage,redline}`), reportlab (floor-guide PDF).

**Spec:** `docs/superpowers/specs/2026-06-27-fbu-run-model-refinement-design.md`.

**Build order (the user's sequence):** Task 1–2 = FBU granularity correction (§5); Task 3–5 = production-declared format + remove store flip + surface/default FBU (§2–4); Task 6 = outsourced receive into receiving flow + auto-close (§6–7); Task 7 = business-rule + knowledge + log deferred fast-follows (§8–9); Task 8 = floor-guide PDF (LAST — only after the build is live).

---

## Data facts established before planning (verified via SQL this session)

- **4 wrongly-merged Common FBU car codes, all zero movement** (`opening=closing`, `total_received=total_issued=0`) — clean to re-split:
  | code | product | merged qty | combos to split into (alphabetical: variant, colour) |
  |---|---|---|---|
  | `DS-CAR-01` | Dash | 2000 | Base Black 500 · Base Green 750 · Street White 750 |
  | `MA-CAR-01` | Mac | 600 | Base Black 300 · Base Red 300 |
  | `NT-CAR-01` | Nitro | 428 | Race Blue 6 · Race Grey 269 · Tarmac Black 58 · Tarmac Green 24 · Tarmac Grey 71 |
  | `SH-CAR-01` | Shadow | 0 | Asphalt Black 0 · Tarmac Black 0 |
- **Rift/Rumble** (`RI-CAR-01`/`RI-RM-01`/`RU-CAR-01`/`RU-RM-01`) are single-combo and have **real movement** — **leave untouched** (design §5: "already fine"). Their `variant_model='Common'` is correct (one combo each).
- **No built-remote codes exist for Dash/Mac/Nitro/Shadow** — the FBU snapshot has only `component_type='car'` rows. Only CAR codes need splitting; remotes are unchanged.
- Per-colour quantities are preserved in **`store.safety_fbu_stock_2026_06_26`** (the Plan-2 snapshot — the re-split source of truth).
- `store.stock_ledger` / `material_master` require `part_code, product, part_name` (NOT NULL, no default). `closing_stock` is GENERATED (`opening + received − issued + returned`) — only set `opening_stock`.
- **Code-naming decision (deviation from spec §5.4, documented):** rather than retire the merged Common codes and mint all-fresh, **re-purpose `-CAR-01` as the first combo** (rebalance its `opening_stock`, set its `variant_model`) and mint `-CAR-02, -03…` for the rest. Cleaner numbering, reuses the existing `stock_ledger`/`material_master` rows, leaves no orphan Common code (they have zero movement so re-purposing is safe). Net effect = identical to spec intent (no Common-grain FBU car code remains).
- **Matcher confirmed** (`01_worker/worker.js:3427-3436`): `variantModels = {'Common'} ∪ {wo.variant} ∪ {`${wo.variant} ${wo.colour}`}`; `woBom = allBom.filter(b => variantModels.has(b.variant_model) && ['ANY', runFmt].includes(b.bom_format||'CKD'))`. So a per-combo car row with `variant_model='Tarmac Grey'` is picked **only** by a WO with `variant='Tarmac', colour='Grey'`. ✅

---

## Task 1: FBU granularity correction — re-split the 4 merged car codes (DATA)

**Files:** Supabase migration `fbu_car_granularity_v1` (via `apply_migration`).

**Why:** Plan 2 collapsed multi-colour products into one Common `<PROD>-CAR-01`. Re-split into per-(variant,colour) codes so production runs of a specific colour pick (and deduct) the right built-car stock.

- [ ] **Step 1: Snapshot the three tables** (idempotent — `IF NOT EXISTS`).

```sql
CREATE TABLE IF NOT EXISTS store.safety_bom_register_2026_06_27   AS SELECT * FROM store.bom_register;
CREATE TABLE IF NOT EXISTS store.safety_material_master_2026_06_27 AS SELECT * FROM store.material_master;
CREATE TABLE IF NOT EXISTS store.safety_stock_ledger_2026_06_27    AS SELECT * FROM store.stock_ledger;
```

- [ ] **Step 2: Pre-flight assertions** — confirm the 4 merged codes still have zero movement before touching them (abort if not).

```sql
SELECT part_code, opening_stock, total_received, total_issued, returned, closing_stock
FROM store.stock_ledger
WHERE part_code IN ('DS-CAR-01','MA-CAR-01','NT-CAR-01','SH-CAR-01');
-- EXPECT: each row total_received=0 AND total_issued=0 AND returned=0 (opening=closing).
-- If ANY has movement, STOP and re-derive (an FBU run was issued since planning).
```

- [ ] **Step 3: Re-purpose the `-01` rows to combo #1 + mint the rest** (migration `fbu_car_granularity_v1`).

Run as one migration. Each multi-combo product: UPDATE `-01` to combo #1 (set `variant_model` + rebalance `opening_stock`); INSERT `-02…` for the rest into all three tables.

```sql
-- ========== DASH (3 combos; total 2000) ==========
-- combo #1 → re-purpose DS-CAR-01 = Base Black (500)
UPDATE store.bom_register SET variant_model='Base Black', part_name='Car (Dash) — Base Black' WHERE part_code='DS-CAR-01';
UPDATE store.material_master SET part_name='Car (Dash) — Base Black' WHERE part_code='DS-CAR-01';
UPDATE store.stock_ledger SET opening_stock=500, part_name='Car (Dash) — Base Black' WHERE part_code='DS-CAR-01';
-- combo #2 DS-CAR-02 = Base Green (750)
INSERT INTO store.bom_register (product, part_code, part_name, part_category, variant_model, qty_per_unit, bom_format, is_active)
  VALUES ('Dash','DS-CAR-02','Car (Dash) — Base Green','Car','Base Green',1,'FBU',true) ON CONFLICT (part_code) DO UPDATE SET is_active=true, bom_format='FBU', variant_model='Base Green';
INSERT INTO store.material_master (part_code, part_name, product, part_category, is_active)
  VALUES ('DS-CAR-02','Car (Dash) — Base Green','Dash','Car',true) ON CONFLICT (part_code) DO NOTHING;
INSERT INTO store.stock_ledger (part_code, product, part_name, opening_stock)
  VALUES ('DS-CAR-02','Dash','Car (Dash) — Base Green',750) ON CONFLICT (part_code) DO UPDATE SET opening_stock=750;
-- combo #3 DS-CAR-03 = Street White (750)
INSERT INTO store.bom_register (product, part_code, part_name, part_category, variant_model, qty_per_unit, bom_format, is_active)
  VALUES ('Dash','DS-CAR-03','Car (Dash) — Street White','Car','Street White',1,'FBU',true) ON CONFLICT (part_code) DO UPDATE SET is_active=true, bom_format='FBU', variant_model='Street White';
INSERT INTO store.material_master (part_code, part_name, product, part_category, is_active)
  VALUES ('DS-CAR-03','Car (Dash) — Street White','Dash','Car',true) ON CONFLICT (part_code) DO NOTHING;
INSERT INTO store.stock_ledger (part_code, product, part_name, opening_stock)
  VALUES ('DS-CAR-03','Dash','Car (Dash) — Street White',750) ON CONFLICT (part_code) DO UPDATE SET opening_stock=750;

-- ========== MAC (2 combos; total 600) ==========
UPDATE store.bom_register SET variant_model='Base Black', part_name='Car (Mac) — Base Black' WHERE part_code='MA-CAR-01';
UPDATE store.material_master SET part_name='Car (Mac) — Base Black' WHERE part_code='MA-CAR-01';
UPDATE store.stock_ledger SET opening_stock=300, part_name='Car (Mac) — Base Black' WHERE part_code='MA-CAR-01';
INSERT INTO store.bom_register (product, part_code, part_name, part_category, variant_model, qty_per_unit, bom_format, is_active)
  VALUES ('Mac','MA-CAR-02','Car (Mac) — Base Red','Car','Base Red',1,'FBU',true) ON CONFLICT (part_code) DO UPDATE SET is_active=true, bom_format='FBU', variant_model='Base Red';
INSERT INTO store.material_master (part_code, part_name, product, part_category, is_active)
  VALUES ('MA-CAR-02','Car (Mac) — Base Red','Mac','Car',true) ON CONFLICT (part_code) DO NOTHING;
INSERT INTO store.stock_ledger (part_code, product, part_name, opening_stock)
  VALUES ('MA-CAR-02','Mac','Car (Mac) — Base Red',300) ON CONFLICT (part_code) DO UPDATE SET opening_stock=300;

-- ========== NITRO (5 combos; total 428) ==========
UPDATE store.bom_register SET variant_model='Race Blue', part_name='Car (Nitro) — Race Blue' WHERE part_code='NT-CAR-01';
UPDATE store.material_master SET part_name='Car (Nitro) — Race Blue' WHERE part_code='NT-CAR-01';
UPDATE store.stock_ledger SET opening_stock=6, part_name='Car (Nitro) — Race Blue' WHERE part_code='NT-CAR-01';
INSERT INTO store.bom_register (product, part_code, part_name, part_category, variant_model, qty_per_unit, bom_format, is_active) VALUES
  ('Nitro','NT-CAR-02','Car (Nitro) — Race Grey','Car','Race Grey',1,'FBU',true),
  ('Nitro','NT-CAR-03','Car (Nitro) — Tarmac Black','Car','Tarmac Black',1,'FBU',true),
  ('Nitro','NT-CAR-04','Car (Nitro) — Tarmac Green','Car','Tarmac Green',1,'FBU',true),
  ('Nitro','NT-CAR-05','Car (Nitro) — Tarmac Grey','Car','Tarmac Grey',1,'FBU',true)
  ON CONFLICT (part_code) DO UPDATE SET is_active=true, bom_format='FBU', variant_model=EXCLUDED.variant_model;
INSERT INTO store.material_master (part_code, part_name, product, part_category, is_active) VALUES
  ('NT-CAR-02','Car (Nitro) — Race Grey','Nitro','Car',true),
  ('NT-CAR-03','Car (Nitro) — Tarmac Black','Nitro','Car',true),
  ('NT-CAR-04','Car (Nitro) — Tarmac Green','Nitro','Car',true),
  ('NT-CAR-05','Car (Nitro) — Tarmac Grey','Nitro','Car',true)
  ON CONFLICT (part_code) DO NOTHING;
INSERT INTO store.stock_ledger (part_code, product, part_name, opening_stock) VALUES
  ('NT-CAR-02','Nitro','Car (Nitro) — Race Grey',269),
  ('NT-CAR-03','Nitro','Car (Nitro) — Tarmac Black',58),
  ('NT-CAR-04','Nitro','Car (Nitro) — Tarmac Green',24),
  ('NT-CAR-05','Nitro','Car (Nitro) — Tarmac Grey',71)
  ON CONFLICT (part_code) DO UPDATE SET opening_stock=EXCLUDED.opening_stock;

-- ========== SHADOW (2 combos; total 0; dual-format — granular CKD car parts stay CKD) ==========
UPDATE store.bom_register SET variant_model='Asphalt Black', part_name='Car (Shadow) — Asphalt Black' WHERE part_code='SH-CAR-01';
UPDATE store.material_master SET part_name='Car (Shadow) — Asphalt Black' WHERE part_code='SH-CAR-01';
UPDATE store.stock_ledger SET opening_stock=0, part_name='Car (Shadow) — Asphalt Black' WHERE part_code='SH-CAR-01';
INSERT INTO store.bom_register (product, part_code, part_name, part_category, variant_model, qty_per_unit, bom_format, is_active)
  VALUES ('Shadow','SH-CAR-02','Car (Shadow) — Tarmac Black','Car','Tarmac Black',1,'FBU',true) ON CONFLICT (part_code) DO UPDATE SET is_active=true, bom_format='FBU', variant_model='Tarmac Black';
INSERT INTO store.material_master (part_code, part_name, product, part_category, is_active)
  VALUES ('SH-CAR-02','Car (Shadow) — Tarmac Black','Shadow','Car',true) ON CONFLICT (part_code) DO NOTHING;
INSERT INTO store.stock_ledger (part_code, product, part_name, opening_stock)
  VALUES ('SH-CAR-02','Shadow','Car (Shadow) — Tarmac Black',0) ON CONFLICT (part_code) DO UPDATE SET opening_stock=0;
```

- [ ] **Step 4: Verify the split — totals conserved, per-combo `variant_model` correct.**

```sql
SELECT b.product, b.part_code, b.variant_model, b.bom_format, sl.opening_stock, sl.closing_stock
FROM store.bom_register b JOIN store.stock_ledger sl USING (part_code)
WHERE b.is_active AND b.part_code ~ '-CAR-' AND b.product IN ('Dash','Mac','Nitro','Shadow')
ORDER BY b.product, b.part_code;
-- EXPECT per product: Dash 3 rows sum 2000; Mac 2 sum 600; Nitro 5 sum 428; Shadow 2 sum 0.
-- Every row variant_model='<variant> <colour>', bom_format='FBU'. No 'Common' FBU car row remains for these 4.
```

```sql
-- Conservation check (must all be true):
SELECT
  (SELECT sum(closing_stock) FROM store.stock_ledger WHERE part_code LIKE 'DS-CAR-%')=2000 AS dash_ok,
  (SELECT sum(closing_stock) FROM store.stock_ledger WHERE part_code LIKE 'MA-CAR-%')=600  AS mac_ok,
  (SELECT sum(closing_stock) FROM store.stock_ledger WHERE part_code LIKE 'NT-CAR-%')=428  AS nitro_ok,
  (SELECT sum(closing_stock) FROM store.stock_ledger WHERE part_code LIKE 'SH-CAR-%' AND part_code ~ '-CAR-0')=0 AS shadow_ok;
```

- [ ] **Step 5: Advisors clean** — `get_advisors(type:'security')` shows no NEW issue attributable to these rows (additive to RLS-on tables).

---

## Task 2: Worker — variant+colour resolver, receiving branch, `receiveExtBuiltUnits`

**Files:** `01_worker/worker.js` — `builtPartCodeResolver` (~285), `seedReceivingLinesFromPO` FBU branch (~823+ — the `addExploded`/`pending.push` FBU block), `receiveExtBuiltUnits` (~17493).

**Why:** After Task 1 the per-product `Common` FBU car code is gone for the 4 split products. Any resolver that returns `(product, 'car')→Common` now returns the wrong code (or null). It must resolve by **variant+colour**.

- [ ] **Step 1: Rewrite `builtPartCodeResolver` to key on `variant_model`** (worker.js ~285-294). Replace the whole function:

```javascript
// Built-unit part code for an FBU receipt/return (FBU run-model refinement, S180).
// FBU car codes are per-(variant,colour) — variant_model='<variant> <colour>'. Remotes
// stay one Common code per product. Returns a (product, variant, colour, 'car'|'remote')
// → code resolver that tries the most specific variant_model first, then Common.
async function builtPartCodeResolver() {
  const r = await query('bom_register',
    `?or=(part_code.like.*-CAR-*,part_code.like.*-RM-*)&is_active=eq.true&select=product,part_code,part_category,variant_model,bom_format`);
  const map = {}; // `${product}|${variant_model}|${comp}` → code
  for (const row of (r.ok ? r.data : [])) {
    if (String(row.bom_format || '') !== 'FBU') continue; // only FBU built-part rows
    const comp = (String(row.part_category || '').toLowerCase() === 'remote' || /-RM-/.test(row.part_code)) ? 'remote' : 'car';
    const vm = row.variant_model || 'Common';
    if (!map[`${row.product}|${vm}|${comp}`]) map[`${row.product}|${vm}|${comp}`] = row.part_code;
  }
  return (product, variant, colour, comp) => {
    const tries = [];
    if (variant && colour) tries.push(`${variant} ${colour}`);
    if (variant) tries.push(variant);
    tries.push('Common');
    for (const vm of tries) { const c = map[`${product}|${vm}|${comp}`]; if (c) return c; }
    return null;
  };
}
```

- [ ] **Step 2: Find every caller** and confirm the new 4-arg signature is satisfied.

```bash
grep -n "builtPartCodeResolver\|builtPartCode(" 01_worker/worker.js
```
Expected callers: `seedReceivingLinesFromPO` (~823, builds `const builtPartCode = await builtPartCodeResolver()`) and `receiveExtBuiltUnits` (~17513, `const resolveBuilt = await builtPartCodeResolver()`). Both are updated in Steps 3–4.

- [ ] **Step 3: Update the FBU branch in `seedReceivingLinesFromPO`** to resolve per variant+colour. Read the current FBU branch first:

```bash
sed -n '820,915p' 01_worker/worker.js
```
The FBU branch resolves `builtPartCode(l.product, 'car')` / `'remote'` and pushes one row per PO line carrying the line's variant/color (per Plan 1 execution log). Change the two resolver calls to pass the line's variant+colour:

```javascript
// BEFORE (per Plan 1 log — one row per PO line, carries variant/color):
//   const carCode = builtPartCode(l.product, 'car');
//   const rmCode  = builtPartCode(l.product, 'remote');
// AFTER:
const carCode = builtPartCode(l.product, l.variant || null, l.color || null, 'car');
const rmCode  = builtPartCode(l.product, l.variant || null, l.color || null, 'remote');
```
Keep the rest of the branch (the `pending.push({ part_code: carCode, …, variant_model: <line variant>, … })` rows) unchanged — they already carry the line's `variant`/`color`, which is what the per-combo code needs. If a product has no FBU car code for the line's combo (`carCode===null`), the existing legacy `fbu_stock` fallback fires (harmless; only the un-split products would hit it, and they're all split now). **Confirm with the actual code in the `sed` output before editing** — match the exact variable names in situ.

- [ ] **Step 4: Update `receiveExtBuiltUnits`** (~17493) to resolve per variant+colour. The handler currently takes `{run_no, qty}` and resolves the product's `'car'` code (now → null after the split). Make it resolve from the run's WO variant/colour, and accept an optional per-combo breakdown. Replace the resolver block (the `const eCarCode = resolveBuilt(erun.product, 'car')` region, ~17513-17532) with:

```javascript
const resolveBuilt = await builtPartCodeResolver();
// Resolve the (variant,colour) to receive against. Priority: explicit body lines →
// the run's single WO combo → error asking for a breakdown when the run is multi-combo.
const woR = await query('work_orders', `?run_id=eq.${erun.id}&select=variant,colour,qty`);
const wos = (woR.ok && Array.isArray(woR.data)) ? woR.data : [];
let recvLines; // [{variant, colour, qty}]
if (Array.isArray(d.lines) && d.lines.length) {
  recvLines = d.lines.map(x => ({ variant: x.variant || null, colour: x.colour || x.color || null, qty: Math.round(Number(x.qty) || 0) })).filter(x => x.qty > 0);
} else if (wos.length === 1) {
  recvLines = [{ variant: wos[0].variant || null, colour: wos[0].colour || null, qty: eqty }];
} else {
  return err('This outsourced run has multiple variant/colour combos — send a per-combo breakdown in data.lines:[{variant,colour,qty}]', 422);
}
const eGrnNo = await nextSeq('grn', 'GRN-');
const eVendor = erun.vendor_id
  ? ((await query('vendors', `?id=eq.${erun.vendor_id}&select=vendor_name&limit=1`)).data?.[0]?.vendor_name || '')
  : '';
const eGrnRows = []; const eStockUpd = []; let eTotal = 0;
for (const rl of recvLines) {
  const carCode = resolveBuilt(erun.product, rl.variant, rl.colour, 'car');
  if (!carCode) return err(`No built-car code for ${erun.product} ${rl.variant || ''} ${rl.colour || ''} — mint it first`, 422);
  const rmCode = resolveBuilt(erun.product, rl.variant, rl.colour, 'remote');
  eGrnRows.push({
    grn_no: eGrnNo, grn_date: d.grn_date || todayISO(), batch_no: generateBatch(erun.product),
    supplier: eVendor, po_reference: '', part_code: carCode, part_name: `${erun.product} — Car`,
    product: erun.product, qty_ordered: rl.qty, qty_received: rl.qty, qty_rejected: 0,
    received_by: postRole, inspection: 'Pass', notes: `Job-work return ${erun.run_no}`,
    source: 'jobwork', ext_run_no: erun.run_no,
  });
  eStockUpd.push({ part_code: carCode, qty: rl.qty });
  if (rmCode) {
    eGrnRows.push({ ...eGrnRows[eGrnRows.length - 1], part_code: rmCode, part_name: `${erun.product} — Remote` });
    eStockUpd.push({ part_code: rmCode, qty: rl.qty });
  }
  eTotal += rl.qty;
}
```
Then update the downstream insert/RPC/return to use `eGrnRows`/`eStockUpd`/`eTotal` (the existing code already inserts `eGrnRows` and RPCs `eStockUpd`; just ensure the final `return ok({…, received: eTotal, part_code: eGrnRows[0].part_code})` uses `eTotal`). **Read ~17493-17542 and edit in place** to match the exact surrounding variable names.

- [ ] **Step 5: `node --check 01_worker/worker.js`** — expect no output (syntax OK).

- [ ] **Step 6: Commit + deploy (increment 1).**

```bash
git -C 01_worker add worker.js && git -C 01_worker commit -m "fbu: resolve built-car code per variant+colour (granularity correction, S180)"
git -C 01_worker push origin main
cd 01_worker && npx wrangler deploy   # record the Cloudflare version id
```

- [ ] **Step 7: Verify the matcher picks the right per-combo car (SQL-simulated, no stock touched).** Pick a live combo and confirm exactly one FBU car row matches its `variantModels` set:

```sql
-- Simulate the matcher for a Nitro Tarmac Grey FBU WO:
SELECT part_code, variant_model, bom_format FROM store.bom_register
WHERE is_active AND product='Nitro' AND part_code ~ '-CAR-'
  AND variant_model IN ('Common','Tarmac','Tarmac Grey') AND bom_format IN ('FBU','ANY');
-- EXPECT exactly one row: NT-CAR-05 / 'Tarmac Grey' / FBU. (Race/other combos excluded.)
```

- [ ] **Step 8: Browser smoke (hand to Afshaan).** Add to the checklist: *Redline → create a Fresh run for Nitro Tarmac Grey, format FBU (after Task 5) → Garage Issue Queue shows `NT-CAR-05` in the pick list, qty = run qty, not the merged total. Issue it → `stock_ledger` `NT-CAR-05` `total_issued` rises (not `NT-CAR-01`).*

---

## Task 3: Worker — production-declared `format` on Fresh & Repair runs

**Files:** `01_worker/worker.js` — `createProductionRun` (~16899), `createRepairRun` (~11074); migration `repair_run_format_v1`.

**Why:** Format becomes production's intent at run-create (design §2), driving the WO `issue_mode` 1:1 (no store flip). Reverses S121.

- [ ] **Step 1: `createProductionRun` — accept a run-level `format` and drive `issue_mode`.** Read ~16930-16980 (the `resolveIssueMode` + WO insert). Add a format→issue_mode map and prefer the declared format:

```javascript
// FBU run-model refinement (S180): production declares the run FORMAT at create.
// CKD→components · SKD→skd · FBU→fbu. Mandatory for in-house Fresh runs (the UI sends it);
// fall back to the product_master-derived resolveIssueMode only when omitted (back-compat /
// outsourced, which has its own build flow).
const FMT_TO_MODE = { CKD: 'components', SKD: 'skd', FBU: 'fbu' };
const declaredFormat = String(d.format || '').toUpperCase();
const runIssueMode = FMT_TO_MODE[declaredFormat] || null;   // null ⇒ use per-variant resolveIssueMode
if (runType === 'in-house' && !runIssueMode && !d.force_no_format) {
  // Soft guard: in-house runs should declare a format. Don't hard-block legacy callers,
  // but the Redline form (Task 5) always sends one.
}
```
Then in the WO insert (~16979) change `issue_mode`:

```javascript
issue_mode: v.issue_mode || runIssueMode || resolveIssueMode(v.variant, v.colour),
```

- [ ] **Step 2: Record the format on the run row + activity log.** In the `insert('production_runs', {…})` object (~16946), add `format` is not a column — store the human format in `notes` is wrong; instead persist via a real column. Add it in the migration (Step 4) and set it here:

```javascript
// added to the production_runs insert object:
issue_format: runIssueMode ? declaredFormat : null,
```
And in the `RUN_CREATED` log line, append `· ${declaredFormat || 'auto'}`.

- [ ] **Step 3: `createRepairRun` — accept `format`, store on `repair_runs`.** Read ~11074-11109.
  **⚠ Architecture note (flag, not skip):** repair runs use `public.repair_runs`/`repair_run_lines` — **no `work_orders`, no `issue_mode`**; repair parts are requested ad-hoc and linked. So a format on a repair run is a **declared classification** (FBU = repair-by-built-unit-swap vs CKD = repair-from-parts), NOT a 1:1 pick-list driver (there is no pick list to project). This is the faithful build of design §2's "format mandatory on Repair" given the existing repair model. Persist it as a column for visibility + later monitoring.
  In the `insertPublic('repair_runs', {…})` object add:

```javascript
issue_format: ['CKD','SKD','FBU'].includes(String((body.data||body).format||'').toUpperCase())
  ? String((body.data||body).format).toUpperCase() : null,
```

- [ ] **Step 4: Migration `repair_run_format_v1`** — add the two columns (additive, nullable).

```sql
CREATE TABLE IF NOT EXISTS store.safety_production_runs_2026_06_27 AS SELECT * FROM store.production_runs;
ALTER TABLE store.production_runs ADD COLUMN IF NOT EXISTS issue_format text;  -- 'CKD'|'SKD'|'FBU'|NULL (production's declared intent)
-- repair_runs lives in public:
ALTER TABLE public.repair_runs   ADD COLUMN IF NOT EXISTS issue_format text;
```
Verify:
```sql
SELECT table_schema, table_name, column_name FROM information_schema.columns
WHERE column_name='issue_format' AND table_name IN ('production_runs','repair_runs');  -- expect 2 rows
```

- [ ] **Step 5: `node --check`; commit + deploy (increment 2).**

```bash
git -C 01_worker add worker.js && git -C 01_worker commit -m "fbu: production declares run format (CKD/SKD/FBU) at create → issue_mode (S180)"
git -C 01_worker push origin main && cd 01_worker && npx wrangler deploy   # record version
```

- [ ] **Step 6: Verify via curl** (worker accepts `format` and sets `issue_mode`). Use a throwaway in-house run for a known FBU product, then inspect the WOs, then delete the test run/WOs.

```bash
# (needs a valid JWT — if headless, hand this to Afshaan; otherwise verify by SQL after a browser-created run)
```
```sql
-- After a Fresh run is created with format=FBU, confirm its WOs:
SELECT pr.run_no, pr.issue_format, wo.wo_no, wo.variant, wo.colour, wo.issue_mode
FROM store.production_runs pr JOIN store.work_orders wo ON wo.run_id=pr.id
WHERE pr.run_no='<NEW_RUN>';  -- EXPECT pr.issue_format='FBU' AND every wo.issue_mode='fbu'
```

---

## Task 4: Remove the store-side format flip (`setRunIssueMode`)

**Files:** Garage `apps/garage/src/app/(auth)/issue-queue/page.js` (toggle UI ~1129-1153 + `setIssueMode` ~500-510), `apps/garage/src/hooks/useProducts.js` (`FBU_PRODUCTS`), then `01_worker/worker.js` (`setRunIssueMode` case ~17573).

**Why:** Store has no format discretion — accept or reject only (design §3). Remove the UI **before** the worker case so no caller hits a removed action (app deploys are independent of the worker).

- [ ] **Step 1: Remove the Garage Issue-Queue toggle UI.** In `issue-queue/page.js`, delete the toggle block at ~1129-1153 (the `selectedItem.fbu_available` conditional rendering "CKD parts / FBU units" buttons) and the `setIssueMode` function at ~500-510. **Read those exact ranges first** and remove the whole block(s); leave the `fbu_lines` rendering (it's empty/dormant since Plan 2 — Plan 4 cleanup territory).

- [ ] **Step 2: Drop `FBU_PRODUCTS` from `useProducts.js`** if it now has zero readers.

```bash
grep -rn "FBU_PRODUCTS\|setIssueMode\|setRunIssueMode" 05_Throttle/apps 05_Throttle/packages
```
If `FBU_PRODUCTS` has no remaining reader, remove line 33 (`const FBU_PRODUCTS = …`) and drop it from the returned object (line 40). If something still reads it, leave it.

- [ ] **Step 3: Build Garage.**

```bash
npx turbo build --filter=garage   # zero errors required
```

- [ ] **Step 4: Commit + push the app (auto-deploys).**

```bash
git -C 05_Throttle add -A && git -C 05_Throttle commit -m "fbu: remove store-side FBU flip — production owns the format now (S180)"
git -C 05_Throttle push origin main
```

- [ ] **Step 5: Remove the `setRunIssueMode` worker case** (~17567-17599 incl. the comment block). Delete the whole `case 'setRunIssueMode': { … }` and its preceding comment.

- [ ] **Step 6: `node --check`; commit + deploy (increment 3).**

```bash
grep -n "setRunIssueMode" 01_worker/worker.js   # expect: no matches
git -C 01_worker add worker.js && git -C 01_worker commit -m "fbu: remove setRunIssueMode (store flip retired, S180)"
git -C 01_worker push origin main && cd 01_worker && npx wrangler deploy   # record version
```

- [ ] **Step 7: Browser smoke (hand to Afshaan).** *Garage Issue Queue → open a Fresh in-house run → there is NO "CKD parts / FBU units" toggle anymore; the pick list reflects the run's declared format; the only levers are Issue and Reject.*

---

## Task 5: Redline `/new-run` — format selector + FBU surfacing/default

**Files:** `apps/redline/src/app/(auth)/new-run/page.js` (`ProductionForm` ~133, `RepairForm` ~219), `apps/redline/src/components/production-runs/CoveragePanel.js`; `01_worker/worker.js` (new GET `getBuiltUnitStock`).

**Why:** Production picks the format at create, with built-unit (FBU) availability surfaced and FBU defaulted when stock exists (design §4).

- [ ] **Step 1: Worker — add GET `getBuiltUnitStock`** returning per-(variant,colour) built-car closing stock for a product. Add a `case 'getBuiltUnitStock':` in the GET switch (place it near `getProducibility` ~2711; mirror its style). Implementation:

```javascript
case 'getBuiltUnitStock': {
  const product = url.searchParams.get('product');
  if (!product) return err('product required');
  // FBU built-car rows for this product + their stock_ledger closing.
  const bomR = await query('bom_register',
    `?product=eq.${encodeURIComponent(product)}&is_active=eq.true&bom_format=eq.FBU&part_code=like.*-CAR-*&select=part_code,variant_model`);
  const codes = (bomR.ok ? bomR.data : []);
  if (!codes.length) return ok({ product, total: 0, by_combo: [] });
  const list = codes.map(c => c.part_code);
  const slR = await query('stock_ledger',
    `?part_code=in.(${list.map(encodeURIComponent).join(',')})&select=part_code,closing_stock`);
  const stockMap = {}; (slR.ok ? slR.data : []).forEach(r => { stockMap[r.part_code] = Number(r.closing_stock) || 0; });
  const by_combo = codes.map(c => ({ part_code: c.part_code, variant_model: c.variant_model, qty: stockMap[c.part_code] || 0 }));
  const total = by_combo.reduce((s, x) => s + x.qty, 0);
  return ok({ product, total, by_combo });
}
```
`node --check`; commit + deploy (**increment 4**); record version.

```bash
git -C 01_worker add worker.js && git -C 01_worker commit -m "fbu: add getBuiltUnitStock (per-combo built-car availability for run-create) (S180)"
git -C 01_worker push origin main && cd 01_worker && npx wrangler deploy
```
Verify: `curl 'https://lotopsproxy.afshaan.workers.dev/?action=getBuiltUnitStock&product=Nitro'` → `total:428`, 5 combos. (GET, no JWT needed if `getBuiltUnitStock` is a public GET like `getProductCatalogue`; if the GET switch requires auth, hand the curl to Afshaan with a token, or verify by SQL equivalence.)

- [ ] **Step 2: Redline `ProductionForm` — add the format selector + FBU availability.** In `new-run/page.js` `ProductionForm` (~133), add state + a fetch of built stock when `product` changes, and a format selector that defaults to FBU when `total>0`:

```javascript
const [format, setFormat] = useState('CKD');
const [builtStock, setBuiltStock] = useState(null); // {total, by_combo}
useEffect(() => {
  if (!product || outsourced) { setBuiltStock(null); return; }
  garageFetch('getBuiltUnitStock', { product }, session)
    .then(d => { setBuiltStock(d || null); setFormat((d?.total || 0) > 0 ? 'FBU' : 'CKD'); })
    .catch(() => setBuiltStock(null));
}, [product, outsourced, session]);
```
Render a selector (only for in-house Fresh runs — `!outsourced`) above the variants table, with an availability hint:

```jsx
{!outsourced && (
  <div style={{ marginBottom: 16 }}>
    <span className="eyebrow" style={lblStyle}>Format *</span>
    <div style={{ display: 'flex', gap: 8 }}>
      {['FBU', 'CKD', 'SKD'].map(f => (
        <button key={f} type="button" onClick={() => setFormat(f)}
          style={format === f ? btnPrimary : btnGhost}>{f}</button>
      ))}
    </div>
    {builtStock && builtStock.total > 0 && (
      <div style={{ ...helpText, marginTop: 6, color: 'var(--accent)' }}>
        {builtStock.total} built unit(s) in stock — finish these first (FBU).
      </div>
    )}
  </div>
)}
```
Pass `format` in the `createProductionRun` payload (the `submit` fn, ~159):

```javascript
const r = await workerFetch('createProductionRun', { data: {
  product, run_date: runDate, line_no: outsourced ? null : line, shift, notes: notes.trim() || null,
  variants: variantsPayload, run_type: runType, vendor_id: outsourced ? Number(vendorId) : null,
  format: outsourced ? null : format, force,
} }, session);
```
Guard: block submit if `!outsourced && !format` (it always defaults, so this is belt-and-suspenders).

- [ ] **Step 3: Redline `RepairForm` — add the same format selector** (~219). Repair format is a classification (see Task 3 Step 3 note). Add `const [format, setFormat] = useState('CKD');` + the same 3-button selector (no availability hint needed — repair parts are ad-hoc), and pass `format` into the `createRepairRun` payload (~237):

```javascript
const r = await workerFetch('createRepairRun', { data: { line, run_date: runDate, notes: notes.trim() || 'Repair run (Redline)', lines, format } }, session);
```

- [ ] **Step 4: Build Redline.**

```bash
npx turbo build --filter=redline   # zero errors
```

- [ ] **Step 5: Commit + push (auto-deploys).**

```bash
git -C 05_Throttle add -A && git -C 05_Throttle commit -m "fbu: run-create format selector + FBU availability/default on Redline /new-run (S180)"
git -C 05_Throttle push origin main
```

- [ ] **Step 6: Browser smoke (hand to Afshaan).** *Redline /new-run → pick Nitro → Format defaults to FBU and shows "428 built units in stock"; pick a CKD-only product → Format defaults to CKD, no hint. Create an FBU run → Garage Issue Queue pick list shows the per-combo built car. Create a Repair run with a format → it's stored (`repair_runs.issue_format`).*

---

## Task 6: Outsourced receive → receiving flow with run-link + auto-close

**Files:** `01_worker/worker.js` (`postShipment` ~12114, `seedReceivingLinesFromPO`, `raiseGRNFromReceiving`, `getProductionRun` ext_summary ~3543, new GET `getOpenOutsourcedRuns`); Garage `receiving/page.js` (~176, ~729 format toggle); Garage `issue-queue/page.js` ("Receive built cars" button — remove).

**Why:** One receiving surface for all FBU (purchase + job-work); linking an outsourced run tags the GRN `source='jobwork'` and auto-closes the run at received ≥ planned (design §6–7). Replaces Plan 3's standalone Issue-Queue "Receive built cars" action.

- [ ] **Step 1: Worker — GET `getOpenOutsourcedRuns`** (list runs to offer in the link picker). Add near `getBuiltUnitStock`:

```javascript
case 'getOpenOutsourcedRuns': {
  const product = url.searchParams.get('product');
  let f = `?run_type=eq.outsourced&status=in.(Issued,In Progress)&select=run_no,product,vendor_id,status&order=run_date.desc&limit=200`;
  if (product) f = `?run_type=eq.outsourced&status=in.(Issued,In Progress)&product=eq.${encodeURIComponent(product)}&select=run_no,product,vendor_id,status&order=run_date.desc&limit=200`;
  const r = await query('production_runs', f);
  return ok({ runs: r.ok ? r.data : [] });
}
```

- [ ] **Step 2: Worker — `postShipment` accepts + persists `ext_run_no`.** In the `insert('shipments', {…})` object (~12109) add `ext_run_no: d.ext_run_no || null,` (column already exists on `grn_register`; add to `shipments` via migration Step 3). Pass it through to seeding/GRN via the shipment row (already fetched downstream).

- [ ] **Step 3: Migration `shipment_ext_link_v1`** — add `ext_run_no` to `shipments`.

```sql
ALTER TABLE store.shipments ADD COLUMN IF NOT EXISTS ext_run_no text;  -- EXT-NNN when this receipt is a job-work return
```
Verify column exists.

- [ ] **Step 4: Worker — `raiseGRNFromReceiving` sets `source`/`ext_run_no` from the shipment + auto-closes the linked run.** Read the GRN-row construction + the `isFbuShip` block (Plan 1 added `source:'fbu_purchase'`). Change the source logic to honour the link:

```javascript
const linkedExt = ship.ext_run_no || null;
// ...in the grn_register row object (replace the Plan-1 source line):
source:     linkedExt ? 'jobwork' : (isFbuShip ? 'fbu_purchase' : null),
ext_run_no: linkedExt,
```
After the stock post succeeds, auto-close the linked outsourced run when received ≥ planned:

```javascript
if (linkedExt) {
  const erR = await query('production_runs', `?run_no=eq.${encodeURIComponent(linkedExt)}&select=id,status&limit=1`);
  const erun = erR.ok && erR.data[0];
  if (erun) {
    if (erun.status === 'Issued')
      await update('production_runs', { status: 'In Progress', updated_at: new Date().toISOString() }, `id=eq.${erun.id}`);
    // planned = Σ WO qty; received = Σ jobwork GRN car qty tagged to this run
    const woR = await query('work_orders', `?run_id=eq.${erun.id}&select=qty`);
    const planned = (woR.ok ? woR.data : []).reduce((s, w) => s + (Number(w.qty) || 0), 0);
    const grR = await query('grn_register', `?ext_run_no=eq.${encodeURIComponent(linkedExt)}&part_code=like.*-CAR-*&select=qty_received`);
    const received = (grR.ok ? grR.data : []).reduce((s, g) => s + (Number(g.qty_received) || 0), 0);
    if (planned > 0 && received >= planned)
      await update('production_runs', { status: 'Completed', updated_at: new Date().toISOString() }, `id=eq.${erun.id}`);
  }
}
```

- [ ] **Step 5: Worker — `getProductionRun` ext_summary counts jobwork GRNs** (not `units.production_run_id`). Replace the `returnedQty` computation (~3548-3550):

```javascript
const grR = await queryPublic ? null : null; // (placeholder — see below)
const grSumR = await query('grn_register', `?ext_run_no=eq.${encodeURIComponent(run.run_no)}&part_code=like.*-CAR-*&select=qty_received`);
const returnedQty = (grSumR.ok && Array.isArray(grSumR.data)) ? grSumR.data.reduce((s, g) => s + (Number(g.qty_received) || 0), 0) : 0;
```
(Remove the `units` query for `returnedQty`. Keep `plannedQty` from WOs.)

- [ ] **Step 6: `node --check`; commit + deploy (increment 5).**

```bash
git -C 01_worker add worker.js && git -C 01_worker commit -m "fbu: outsourced receive via receiving flow (ext_run link + auto-close); ext_summary off jobwork GRN (S180)"
git -C 01_worker push origin main && cd 01_worker && npx wrangler deploy   # record version
```

- [ ] **Step 7: Garage `receiving/page.js` — "Link outsourced run" picker when FBU.** When `newFormat==='fbu'`, fetch `getOpenOutsourcedRuns` (optionally filtered by the chosen product) and show an optional `<select>`/Combobox; pass the chosen `ext_run_no` in the `postShipment` payload (~185-193). Read ~170-200 + ~720-735 first.

```jsx
{newFormat === 'fbu' && extRuns.length > 0 && (
  <div style={{ marginTop: 10 }}>
    <span className="eyebrow">Link outsourced run · optional</span>
    <select value={extRunNo} onChange={e => setExtRunNo(e.target.value)} style={inp}>
      <option value="">— Purchased FBU (no link) —</option>
      {extRuns.map(r => <option key={r.run_no} value={r.run_no}>{r.run_no} · {r.product} ({r.status})</option>)}
    </select>
  </div>
)}
```
```javascript
// in the postShipment body:
receive_format: newFormat,
ext_run_no: newFormat === 'fbu' ? (extRunNo || null) : null,
```

- [ ] **Step 8: Garage `issue-queue/page.js` — remove the standalone "Receive built cars" button** (the `receiveExtBuiltUnits` caller in the outsourced run panel). Grep + remove:

```bash
grep -n "receiveExtBuiltUnits\|Receive built cars\|Receive built" 05_Throttle/apps/garage/src/app/\(auth\)/issue-queue/page.js
```
Remove the button + its handler. Replace with a one-line hint: *"Receive vendor-built cars in Receiving → declare FBU → link this run."* (Leave the `receiveExtBuiltUnits` worker handler in place as a fallback/no-UI for now; its removal is Plan-4 cleanup.)

- [ ] **Step 9: Build Garage; commit + push.**

```bash
npx turbo build --filter=garage
git -C 05_Throttle add -A && git -C 05_Throttle commit -m "fbu: receiving links outsourced run for FBU receipt; drop issue-queue Receive-built-cars button (S180)"
git -C 05_Throttle push origin main
```

- [ ] **Step 10: Verify auto-close in SQL (synthetic, then revert).** Create a small synthetic outsourced run (1 WO, qty 5), a throwaway FBU shipment linked to it, count + GRN it, then:

```sql
-- after GRN: run Completed, jobwork GRN tagged, stock rose
SELECT run_no, status FROM store.production_runs WHERE run_no='<EXT_TEST>';        -- EXPECT Completed
SELECT grn_no, part_code, qty_received, source, ext_run_no FROM store.grn_register WHERE ext_run_no='<EXT_TEST>';
```
Then revert the synthetic shipment/receiving_lines/grn rows + restore stock from the Task-1 snapshots; cancel/delete the test run. **Hand the full create→issue→send→receive→auto-complete browser walk to Afshaan** (it needs JWT).

---

## Task 7: Business rules, knowledge, deferred fast-follows

**Files:** `BUSINESS_RULES.md`, `systems/lotops.md`, `CORE.md`, `BACKLOG.md` (workspace root).

- [ ] **Step 1: Rewrite RULE-FBU-001** to: *production declares the format (CKD/SKD/FBU) at run-create (mandatory on Fresh; classification on Repair — `repair_runs.issue_format`); store projects it 1:1, no flip (accept/reject only — `setRunIssueMode` removed); FBU car = per (variant,colour) (`variant_model='<variant> <colour>'`, `bom_format='FBU'`), remote = one Common code/product; FBU surfaced + defaulted at run-create when built stock exists (`getBuiltUnitStock`). Reverses the S121 store-side-choice amendment.* Mark the S121/Plan-2 store-toggle text as superseded (don't delete the history).

- [ ] **Step 2: Amend RULE-EXT-001** to: *outsourced run = vendor build-materials issue → FBU-stock return; **receive via the receiving flow** (declare FBU + link the EXT run on `postShipment` → `shipments.ext_run_no` → `source='jobwork'` GRN); **auto-close** when Σ jobwork-GRN built-car qty ≥ Σ WO qty; finishing = a separate Fresh+FBU run. Replaces Plan 3's standalone Issue-Queue "Receive built cars" action.*

- [ ] **Step 3: Update `systems/lotops.md`** — the run-model refinement (format on the run; per-combo FBU codes; receiving run-link + auto-close; `getBuiltUnitStock`/`getOpenOutsourcedRuns`). Bump `Last updated`.

- [ ] **Step 4: Update `CORE.md`** schema map — `production_runs.issue_format`, `repair_runs.issue_format`, `shipments.ext_run_no`; note FBU car codes are per-(variant,colour). Bump `Last updated`.

- [ ] **Step 5: `BACKLOG.md`** — close the "FBU run-model refinement" line (move to archive narrative); ensure the two deferred fast-follows are present as their own `[lotops]` items:
  - **SKD-for-any-product [BIG, DEFERRED]** — already logged (S178); refresh the line to reference this plan.
  - **Per-format output monitoring [MED, fast-follow]** — units finished from FBU vs SKD vs CKD for differentiated targets/allocation; data present (`production_runs.issue_format` + qty); a reporting build. Add if not present.
  - **Plan 4 cleanup (carried)** — freeze vestigial `fbu_stock`/`ext_return_pool`; remove dormant old EXT handlers + `EXT_INW` SCANNER_ACTION + `receiveExtBuiltUnits` standalone + `fbu_includes_remote`/`fbu_products`/`fbu_lines` dead-code; gate FBU toggle removal cleanup.

- [ ] **Step 6: Commit knowledge** (root repo; brain-sync hook also auto-pushes).

```bash
git -C /Users/afshaansiddiqui/Documents/Claude add -A
git -C /Users/afshaansiddiqui/Documents/Claude commit -m "knowledge: FBU run-model refinement live — RULE-FBU-001/EXT-001 rewrite, schema map, backlog (S180)"
git -C /Users/afshaansiddiqui/Documents/Claude push origin main
```

---

## Task 8: Regenerate the team floor-guide PDF (LAST — only after the build is live)

**Files:** create `05_Throttle/docs/floor-guides/build-fbu-floor-guide.py` (reportlab generator, committed so it versions with the guide); output `05_Throttle/docs/floor-guides/FBU-Outsourced-Floor-Guide.pdf` (A4).

**Why:** Hand the floor the steps that are now actually in the system. **Do NOT run until Tasks 1–6 are deployed and browser-smoked** (don't document steps the system doesn't do yet).

- [ ] **Step 1: Read the existing v2 PDF** to match its style/structure.

```bash
# render to text to capture the existing structure (perspectives, headings, tone)
python3 -c "import pypdf,sys; r=pypdf.PdfReader('05_Throttle/docs/floor-guides/FBU-Outsourced-Floor-Guide.pdf'); print('\n\n'.join(p.extract_text() for p in r.pages))" 2>/dev/null || echo "install pypdf or read via the Read tool"
```
(Also `Read` the PDF directly with the Read tool for layout.)

- [ ] **Step 2: Write `build-fbu-floor-guide.py`** (reportlab, A4, 3 perspectives — Store team / In-house Production / Outsourced team). Keep the v2 visual style (cover, per-perspective sections, numbered steps, callouts). Content must reflect the NEW model:
  - **(a) Production DECLARES the format (CKD / SKD / FBU)** when creating a run — mandatory on Fresh runs; it's their intent.
  - **(b) Store no longer decides/flips** — it issues exactly what the run requested (1:1) or **REJECTS** the run and asks production to re-raise it to match stock. Remove all "store chooses loose parts vs built cars" wording.
  - **(c) FBU is shown + defaulted at run-create** when built units are in stock ("finish these first").
  - **(d) Outsourced:** Store receives vendor-built cars in the **normal Receiving flow** by declaring FBU + **linking the outsourced run** (not a separate button) → **auto-closes** the run; finishing is a separate **Fresh + FBU** run by the in-house team.

- [ ] **Step 3: Generate the PDF.**

```bash
pip install reportlab >/dev/null 2>&1 || pip3 install reportlab
python3 05_Throttle/docs/floor-guides/build-fbu-floor-guide.py
ls -la 05_Throttle/docs/floor-guides/FBU-Outsourced-Floor-Guide.pdf
```

- [ ] **Step 4: Visually verify** — `Read` the regenerated PDF; confirm 3 perspectives, the four content changes above, A4, clean layout.

- [ ] **Step 5: Commit the generator + PDF.**

```bash
git -C 05_Throttle add docs/floor-guides/build-fbu-floor-guide.py docs/floor-guides/FBU-Outsourced-Floor-Guide.pdf
git -C 05_Throttle commit -m "docs: regenerate FBU/Outsourced floor guide for the run-model refinement (S180)"
git -C 05_Throttle push origin main
```

- [ ] **Step 6: Send the regenerated PDF to Afshaan** (attach `05_Throttle/docs/floor-guides/FBU-Outsourced-Floor-Guide.pdf`).

---

## Browser-smoke checklist (handed to Afshaan — needs Google login)

1. **Granularity (Task 1/2):** Redline → Fresh run, **Nitro Tarmac Grey**, format **FBU** → Garage Issue Queue pick list shows **`NT-CAR-05`** (qty = run qty, not 428). Issue → `stock_ledger.NT-CAR-05.total_issued` rises.
2. **Format at create (Task 3/5):** Redline /new-run → pick **Nitro** → Format defaults to **FBU**, hint "428 built units in stock". Pick a CKD-only product → defaults **CKD**, no hint. Repair run with a format → saved.
3. **No store flip (Task 4):** Garage Issue Queue → Fresh run → **no CKD/FBU toggle**; only **Issue** / **Reject**.
4. **Reject path (Task 4):** a run whose declared FBU can't be met → store **Rejects** → production re-raises as CKD.
5. **Outsourced (Task 6):** Redline → Outsourced run (vendor) → Garage issues build materials → Send to vendor (challan) → **Receiving**: new shipment, declare **FBU**, **link the EXT run**, count, raise GRN → run **auto-Completes**; built-car `stock_ledger` rises with a `source='jobwork'` GRN. Then a **Fresh + FBU** finishing run consumes that built car.

---

## Self-review (spec coverage)

- **§2 (format on Fresh/Repair, run-level, drives 1:1 pick list)** → Task 3 (worker) + Task 5 (UI). Repair = classification (flagged; repair has no WO/issue_mode).
- **§3 (remove `setRunIssueMode`, accept/reject only)** → Task 4.
- **§4 (FBU surfaced + defaulted at run-create)** → Task 5 (`getBuiltUnitStock` + default).
- **§5 (FBU car per variant+colour; remote Common; re-split from snapshot; fix resolver + receiveExtBuiltUnits)** → Task 1 (data) + Task 2 (worker). Naming deviation (re-purpose `-01` vs retire) documented.
- **§6 (outsourced = build-materials issue → FBU return; auto-close; finishing = Fresh+FBU; remove standalone receive button)** → Task 6.
- **§7 (one receiving flow; FBU run-link; jobwork vs fbu_purchase source)** → Task 6.
- **§8 (RULE-FBU-001 rewrite, RULE-EXT-001 amend)** → Task 7.
- **§9 (defer SKD-any-product + per-format monitoring + Plan 4 cleanup)** → Task 7 Step 5 (logged, not built).
- **Floor PDF (3 perspectives, new content, after live)** → Task 8.

**Deploy increments (worker, each its own deploy+verify):** 1 = resolver/receiving/receiveExt (Task 2); 2 = createProductionRun/createRepairRun format (Task 3); 3 = remove setRunIssueMode (Task 4); 4 = getBuiltUnitStock (Task 5 Step 1); 5 = receiving link + auto-close + ext_summary (Task 6). App deploys: Garage (Task 4), Redline (Task 5), Garage (Task 6).
