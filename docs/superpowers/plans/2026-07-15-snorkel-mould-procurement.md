# Snorkel Mould-Based Procurement — Implementation Plan

> **For agentic workers:** Executed inline end-to-end by the single LOT agent (no subagent handoff — workspace operating model). This codebase has **no unit-test harness**; per-task verification is Supabase SQL checks + `wrangler deploy` + authenticated browser smoke (the house pattern). Steps use `- [ ]` for tracking.

**Goal:** Let procurement order by mould (one PO line = one mould, block cost) while the store receives the real constituent part codes — the mould line explodes into per-part receiving lines at `shots × qty_per_shot`, mirroring the CKD→BOM explosion.

**Architecture:** New `store.moulds` + `store.mould_parts` mapping + `store.po_lines.mould_no`. lotopsproxy `computeReceivingRowsFromPO` gains a mould branch (explodes on `mould_no` presence). snorkelops gains mould CRUD + passes `mould_no` through PO line writes. apps/snorkel gets a `/moulds` master + a Part|Mould line-kind toggle on the PO form. Cost stays at mould grain; part expansion is quantity-only.

**Tech Stack:** Supabase Postgres (`store` schema), Cloudflare Workers (lotopsproxy `01_worker/worker.js`, snorkelops `05_Throttle/snorkelops-worker/src/index.js`), Next.js static-export (`05_Throttle/apps/snorkel`), shared `@throttle/ui` `Combobox`.

**Spec:** `docs/superpowers/specs/2026-07-15-snorkel-mould-procurement-design.md`

---

### Task 1: Migration — mould master tables + `po_lines.mould_no`

**Files:**
- Migration via Supabase MCP `apply_migration` name `snorkel_mould_procurement_v1`

- [ ] **Step 1: Apply the migration**

```sql
-- Mould master: one row per physical mould LOT owns
CREATE TABLE store.moulds (
  mould_no          text PRIMARY KEY,
  description       text,
  vendor_code       text,                    -- → store.vendors.vendor_code (loose ref); one vendor per mould
  hsn_code          text,
  gst_percent       numeric,
  default_shot_rate numeric,
  is_active         boolean NOT NULL DEFAULT true,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Mould → part mapping (the recipe): which part codes, how many per shot
CREATE TABLE store.mould_parts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mould_no      text NOT NULL REFERENCES store.moulds(mould_no) ON DELETE CASCADE,
  part_code     text NOT NULL,
  qty_per_shot  numeric NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mould_no, part_code)
);
CREATE INDEX mould_parts_mould_no_idx ON store.mould_parts(mould_no);

-- PO line can be a mould line
ALTER TABLE store.po_lines ADD COLUMN IF NOT EXISTS mould_no text;

-- RLS on + service_role grants (RULE-RLS-001; worker is service_role/BYPASSRLS)
ALTER TABLE store.moulds ENABLE ROW LEVEL SECURITY;
ALTER TABLE store.mould_parts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON store.moulds TO service_role;
GRANT ALL ON store.mould_parts TO service_role;
```

- [ ] **Step 2: Verify structure**

Run `list_tables` (schema `store`) or:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='store' AND table_name IN ('moulds','mould_parts');
SELECT column_name FROM information_schema.columns
WHERE table_schema='store' AND table_name='po_lines' AND column_name='mould_no';
```
Expected: both tables present; `mould_no` column present.

- [ ] **Step 3: `get_advisors` (security)** — expect 0 new `rls_disabled_in_public`/exposed-table warnings for the two new tables (they're RLS-on, service_role-only).

---

### Task 2: Seed mould master + mapping from the sheet (data-only)

Source: sheet `14dJH3mrI92Z3LXs5iv2q9kcT0a2vdyEVxFylgNOw_MU`. 15 moulds. **`qty_per_shot = 1` for every part** (sheet carries no per-shot count; confirmed default — Afshaan to correct exceptions in `/moulds`). No snapshot needed (new empty tables; rollback = `DELETE FROM store.moulds` cascades).

**Data cleaning applied at seed:**
- `D1-PB10 ` (mould 25311, "BRAKE CALIPERR") → normalize to `D1-PB-10`; it duplicates the same mould's "Brake Calliper" `D1-PB-10` → **one row**.
- `SH-PB-54` appears twice in mould 25315 (Tarmac diffuser + Hellcat diffuser) → **one row** (UNIQUE).
- Moulds `26017`/`26018` (Flare Race/Burnout unpainted tops) have `<part code to be minted>` → **seed the mould header, hold the part row** until codes exist (Task 2b).
- `description` = the sheet's "Parts" group label (e.g. `25310`→"GEARS", `25315`→"BODY ACCESSORIES").
- `vendor_code` = NULL (not in sheet; set per mould in UI later).

- [ ] **Step 1: Validate all part codes exist in `material_master`**

```sql
-- Feed the distinct sheet part codes; list any missing before inserting mould_parts
SELECT code FROM (VALUES
 ('D1-PB-01'),('D1-PB-02'),('D1-PB-03'),('D1-PB-04'),('D1-PB-06'),('D1-PB-07'),('D1-PB-08'),
 ('D1-PB-10'),('D1-PB-11'),('D1-PB-13'),('D1-PB-15'),('D1-PB-18'),('D1-PB-19'),('D1-PB-21'),
 ('D1-PB-22'),('D1-PB-23'),('D1-PB-24'),('D1-PB-25'),('D1-PB-29'),('D1-PB-31'),('D1-PB-32'),
 ('D1-PB-33'),('D1-PB-36'),('D1-PB-37'),('D1-PB-38'),('D1-PB-39'),('D1-PB-40'),('D1-PB-41'),
 ('D1-PB-42'),('D1-PB-43'),('D1-RB-01'),('D1-AU-01'),('D1-AU-02'),('UNV-AU-CONE-SO-01'),
 ('SH-PB-52'),('SH-PB-60'),('SH-PB-12'),('SH-PB-14'),('SH-PB-16'),('SH-PB-17'),('SH-PB-44'),
 ('SH-PB-46'),('SH-PB-49'),('SH-PB-50'),('SH-PB-54'),('SH-PB-55'),('SH-PB-56'),('SH-PB-57'),
 ('SH-PB-58'),('FL-PB-76'),('FL-PB-79'),('FL-PB-80'),('FL-PB-81'),('FL-PB-84'),('FL-PB-90'),
 ('FL-PB-91'),('FL-PB-92'),('FL-PB-93'),('FL-PB-94'),('FL-PB-95'),('FL-PB-96')
) AS v(code)
WHERE code NOT IN (SELECT part_code FROM store.material_master);
```
Expected: empty. Any row returned = a part code to reconcile with Piyush **before** its mould_parts row is inserted (skip that one row, flag it, keep going).

- [ ] **Step 2: Insert the 15 mould headers**

```sql
INSERT INTO store.moulds (mould_no, description) VALUES
 ('25306','Remote Control Parts'),
 ('25307','Car Top Tarmac'),
 ('25308','Car Top Asphalt'),
 ('25309','Bottom Chassis / Motor Cover'),
 ('25310','Gears'),
 ('25311','Wheels'),
 ('25312','Mould-on-mould: Drift Wheel'),
 ('25313','Mould-on-mould: Grip Wheel & Mirrors'),
 ('25314','Accessories'),
 ('25315','Body Accessories'),
 ('25316','Lights (Transparent & Red)'),
 ('26017','Car Top (Unpainted) — Flare Race'),
 ('26018','Car Top (Unpainted) — Flare Burnout'),
 ('26019','Body Accessories — Flare'),
 ('26020','Lights (Transparent & Red) — Flare')
ON CONFLICT (mould_no) DO NOTHING;
```

- [ ] **Step 3: Insert `mould_parts` (qty_per_shot = 1), deduped, only for existing part codes**

```sql
INSERT INTO store.mould_parts (mould_no, part_code, qty_per_shot) VALUES
 ('25310','D1-PB-04',1),('25310','D1-PB-06',1),('25310','D1-PB-29',1),('25310','D1-PB-03',1),
 ('25310','D1-PB-01',1),('25310','D1-PB-24',1),('25310','D1-PB-25',1),('25310','D1-PB-07',1),
 ('25310','D1-PB-11',1),('25310','D1-PB-22',1),('25310','D1-PB-13',1),('25310','D1-PB-43',1),
 ('25310','D1-PB-23',1),
 ('25308','SH-PB-52',1),
 ('25311','D1-PB-10',1),('25311','D1-PB-02',1),
 ('25306','D1-PB-36',1),('25306','D1-PB-38',1),('25306','D1-PB-21',1),('25306','D1-PB-37',1),
 ('25306','D1-PB-40',1),('25306','D1-PB-39',1),('25306','D1-PB-42',1),('25306','D1-PB-41',1),
 ('25309','D1-PB-08',1),('25309','D1-PB-18',1),('25309','D1-PB-19',1),('25309','D1-PB-31',1),
 ('25309','D1-PB-32',1),('25309','D1-PB-33',1),('25309','D1-PB-15',1),
 ('25313','D1-PB-02',1),('25313','D1-RB-01',1),
 ('25312','D1-PB-11',1),
 ('25307','SH-PB-60',1),
 ('25315','SH-PB-17',1),('25315','SH-PB-16',1),('25315','SH-PB-50',1),('25315','SH-PB-54',1),
 ('25315','SH-PB-12',1),('25315','SH-PB-14',1),('25315','SH-PB-49',1),('25315','SH-PB-58',1),
 ('25315','SH-PB-57',1),
 ('25314','UNV-AU-CONE-SO-01',1),('25314','D1-AU-01',1),('25314','D1-AU-02',1),
 ('25316','SH-PB-44',1),('25316','SH-PB-56',1),('25316','SH-PB-46',1),('25316','SH-PB-55',1),
 ('26019','FL-PB-76',1),('26019','FL-PB-79',1),('26019','FL-PB-80',1),('26019','FL-PB-81',1),
 ('26019','FL-PB-84',1),
 ('26020','FL-PB-90',1),('26020','FL-PB-91',1),('26020','FL-PB-92',1),('26020','FL-PB-93',1),
 ('26020','FL-PB-94',1),('26020','FL-PB-95',1),('26020','FL-PB-96',1)
ON CONFLICT (mould_no, part_code) DO NOTHING;
```
(Note: mould 25315's `SH-PB-54` intentionally appears once though the sheet lists it twice.)

- [ ] **Step 4: Verify counts**

```sql
SELECT m.mould_no, m.description, count(mp.id) AS parts
FROM store.moulds m LEFT JOIN store.mould_parts mp ON mp.mould_no = m.mould_no
GROUP BY 1,2 ORDER BY 1;
```
Expected: 25306→8, 25307→1, 25308→1, 25309→7, 25310→13, 25311→2, 25312→1, 25313→2,
25314→3, 25315→9, 25316→4, 26017→0, 26018→0, 26019→5, 26020→7.

#### Task 2b (deferred data): mint the 2 Flare unpainted-top codes
Blocked on Afshaan/Piyush giving the codes (or approval to mint via `register_product_family`).
Once known: `INSERT INTO store.mould_parts (mould_no, part_code, qty_per_shot) VALUES ('26017', '<race top code>', 1), ('26018', '<burnout top code>', 1);`. Not a build blocker.

---

### Task 3: lotopsproxy — receiving explosion branch (`computeReceivingRowsFromPO`)

**Files:**
- Modify: `01_worker/worker.js` — `computeReceivingRowsFromPO` (currently lines ~832–1032)

- [ ] **Step 1: Add mould detection + batch-load the maps**

Near the top of `computeReceivingRowsFromPO`, after `outstanding` is computed, add mould handling. A mould line = `l.mould_no` set. Batch-load all their part maps + names in two queries (respect 50-subrequest limit):

```js
// ── Mould lines (order-by-mould, receive-by-part) — explode via store.mould_parts.
// A mould line carries mould_no (part_code NULL, item_type 'Mould'); qty_ordered = shots.
const mouldLines = outstanding.filter(l => l.mould_no);
const mouldPartsByMould = {};   // mould_no → [{part_code, qty_per_shot}]
const mouldPartMeta = {};       // part_code → {part_name, product, bag_size}
if (mouldLines.length) {
  const mNos = [...new Set(mouldLines.map(l => l.mould_no))];
  const mpR = await query('mould_parts',
    `?mould_no=in.(${mNos.map(n => `"${n}"`).join(',')})&select=mould_no,part_code,qty_per_shot`);
  if (mpR.ok) for (const r of mpR.data) (mouldPartsByMould[r.mould_no] ||= []).push(r);
  const codes = [...new Set((mpR.ok ? mpR.data : []).map(r => r.part_code))];
  if (codes.length) {
    const mmR = await query('material_current',
      `?part_code=in.(${codes.map(c => `"${c}"`).join(',')})&select=part_code,part_name,product,bag_size`);
    if (mmR.ok) for (const r of mmR.data)
      mouldPartMeta[r.part_code] = { part_name: r.part_name, product: r.product, bag_size: r.bag_size || 50 };
  }
}
```

- [ ] **Step 2: Emit exploded receiving rows for mould lines**

In the `for (const l of outstanding)` loop, add the mould branch **first** (before `isSkdLine`):

```js
if (l.mould_no) {
  const shots = Math.round((Number(l.qty_ordered) || 0) - (Number(l.qty_received) || 0));
  for (const mp of (mouldPartsByMould[l.mould_no] || [])) {
    const qty = Math.round(shots * (Number(mp.qty_per_shot) || 1));
    if (qty <= 0) continue;
    const meta = mouldPartMeta[mp.part_code] || {};
    pending.push({
      part_code: mp.part_code, part_name: meta.part_name || mp.part_code,
      product: meta.product || null, variant: null, color: null,
      line_type: 'parts', component_type: null,
      qty_expected: qty, bags_of: meta.bag_size || 50,
    });
  }
  continue;   // mould line fully handled — skip the SKD/CKD/FBU/part branches
}
```
(The existing loop's first statement becomes `if (l.mould_no) { … continue; } else if (isSkdLine(l)) …` — or a leading `if` with `continue`, whichever reads cleaner against the current `if/else if` chain.)

- [ ] **Step 3: DB-level dry-run verification (before deploy)**

Create a throwaway test PO + a mould line in SQL, then confirm the explosion math by hand (no deploy needed to reason about it), OR verify post-deploy against a real mould PO in Task 7. Minimum: re-read the edited function and confirm a non-mould PO is untouched (mould branch is gated on `l.mould_no`, which is NULL for every existing line).

- [ ] **Step 4: Commit + deploy (⚠ 3-system blast radius — Garage+Redline+Scanner)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/01_worker
git add worker.js && git commit -m "feat(receiving): explode mould PO lines into constituent parts (Snorkel mould procurement)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push && npx wrangler deploy
```
Report the Cloudflare version id. **Gate:** confirm go-ahead before deploy (lotopsproxy takes down 3 systems on a bad deploy). Verify a non-mould shipment still seeds identically after deploy.

---

### Task 4: snorkelops — mould CRUD + PO-line `mould_no` passthrough

**Files:**
- Modify: `05_Throttle/snorkelops-worker/src/index.js`

- [ ] **Step 1: PO-line passthrough (postPO + amendPO)**

In `postPO` (`lineRows` map ~1458) and `amendPO` (`lineRows` map ~1586), add to each mapped row:
```js
mould_no: l.mould_no || null,
```
No other PO logic changes — a mould line arrives as `{ item_type:'Mould', mould_no, qty_ordered:<shots>, unit_price, hsn_code, gst_percent }` with `part_code`/`product` absent.

- [ ] **Step 2: Read actions — `getMoulds` / `getMould`** (gate `canView(P)` = `procurement_view`)

Add GET cases (mirror the existing `getVendors`/`getMaterials` read shape):
```js
case 'getMoulds': {
  if (!canView(P)) return err('No permission', 403);
  const r = await query('moulds', `?order=mould_no.asc`);
  if (!r.ok) return err('Failed to load moulds');
  // attach part counts
  const cR = await query('mould_parts', `?select=mould_no`);
  const counts = {};
  if (cR.ok) for (const x of cR.data) counts[x.mould_no] = (counts[x.mould_no]||0)+1;
  return ok(r.data.map(m => ({ ...m, parts_count: counts[m.mould_no] || 0 })));
}
case 'getMould': {
  if (!canView(P)) return err('No permission', 403);
  const mn = qp.get('mould_no');
  if (!mn) return err('mould_no required');
  const [mR, pR] = await Promise.all([
    query('moulds', `?mould_no=eq.${encodeURIComponent(mn)}&limit=1`),
    query('mould_parts', `?mould_no=eq.${encodeURIComponent(mn)}&select=id,part_code,qty_per_shot&order=part_code.asc`),
  ]);
  if (!mR.ok || !mR.data[0]) return err('Mould not found', 404);
  // enrich parts with material_master names
  const codes = (pR.ok ? pR.data : []).map(x => x.part_code);
  let names = {};
  if (codes.length) {
    const mmR = await query('material_current', `?part_code=in.(${codes.map(c=>`"${c}"`).join(',')})&select=part_code,part_name`);
    if (mmR.ok) for (const x of mmR.data) names[x.part_code] = x.part_name;
  }
  return ok({ ...mR.data[0], parts: (pR.ok?pR.data:[]).map(x => ({ ...x, part_name: names[x.part_code]||x.part_code })) });
}
```
(Confirm the GET dispatcher's query-param handle name — reuse whatever `getPOs`/`getMaterials` use, e.g. `qp`/`url.searchParams`.)

- [ ] **Step 3: Write actions (gate `canRaisePO(P)` = `po_create`)**

Add POST cases:
```js
case 'createMould': {
  if (!canRaisePO(P)) return err('No permission', 403);
  const d = body.data;
  if (!d.mould_no) return err('mould_no required');
  const r = await insert('moulds', {
    mould_no: d.mould_no, description: d.description||null, vendor_code: d.vendor_code||null,
    hsn_code: d.hsn_code||null, gst_percent: d.gst_percent!=null?parseFloat(d.gst_percent):null,
    default_shot_rate: d.default_shot_rate!=null?parseFloat(d.default_shot_rate):null,
    is_active: d.is_active !== false, notes: d.notes||null,
  });
  if (!r.ok) return err('Mould insert failed: '+JSON.stringify(r.data));
  await logActivity(authResult?.fullName||postRole, postRole, 'MOULD_CREATED', 'MOULD', d.mould_no, `Mould ${d.mould_no} created`, {});
  return ok({ mould_no: d.mould_no });
}
case 'updateMould': {
  if (!canRaisePO(P)) return err('No permission', 403);
  const d = body.data;
  if (!d.mould_no) return err('mould_no required');
  const u = { updated_at: new Date().toISOString() };
  ['description','vendor_code','hsn_code','gst_percent','default_shot_rate','is_active','notes']
    .forEach(f => { if (d[f]!==undefined) u[f] = d[f]; });
  await update('moulds', u, `mould_no=eq.${encodeURIComponent(d.mould_no)}`);
  return ok({ mould_no: d.mould_no });
}
case 'setMouldParts': {   // replace the full part map for a mould
  if (!canRaisePO(P)) return err('No permission', 403);
  const d = body.data;
  if (!d.mould_no || !Array.isArray(d.parts)) return err('mould_no and parts[] required');
  await sb(`/rest/v1/mould_parts?mould_no=eq.${encodeURIComponent(d.mould_no)}`, { method: 'DELETE' });
  const rows = d.parts.filter(p => p.part_code).map(p => ({
    mould_no: d.mould_no, part_code: p.part_code, qty_per_shot: parseFloat(p.qty_per_shot)||1,
  }));
  if (rows.length) { const r = await insert('mould_parts', rows); if (!r.ok) return err('parts insert failed: '+JSON.stringify(r.data)); }
  return ok({ mould_no: d.mould_no, count: rows.length });
}
```
(Verify `canRaisePO`/`canView` helper names against the file; reuse whatever `postPO` uses — `canRaisePO(P)`.)

- [ ] **Step 4: Commit + deploy (snorkelops only — 1-system blast radius)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/snorkelops-worker
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add snorkelops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "feat(snorkel): mould CRUD actions + PO-line mould_no passthrough"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push && npx wrangler deploy
```
Verify: `getMoulds` returns the 15 seeded moulds with correct `parts_count`.

---

### Task 5: apps/snorkel — `/moulds` master (list · new · detail)

**Files:**
- Create: `apps/snorkel/src/app/(auth)/moulds/page.js` (list)
- Create: `apps/snorkel/src/app/(auth)/moulds/new/page.js`
- Create: `apps/snorkel/src/app/(auth)/moulds/detail/page.js` (view + part-map editor)
- Create: `apps/snorkel/src/lib/moulds.js` (fetch helpers, mirror `src/lib/sales.js`)
- Modify: `apps/snorkel/src/lib/nav.js` (add a MOULDS entry under the Procurement/Library group, gate `procurement_view`)

Follow the existing **`/assets`** module as the structural template (list + new + detail + settings, KPI tiles, `PageHead`/`Panel`/`.dt` from `src/components/ui.js`). Editing gated on `po_create`; view on `procurement_view`.

- [ ] **Step 1: `lib/moulds.js`** — `listMoulds(session)`, `getMould(mould_no, session)` (GET via `garageFetch`); `createMould`/`updateMould`/`setMouldParts` (POST via `workerFetch`).

- [ ] **Step 2: List page** — table of moulds (mould_no, description, vendor, parts count, active), KPI tiles (active moulds, parts mapped), "＋ New mould" (gated `po_create`), row → detail.

- [ ] **Step 3: New page** — header form: mould_no, description, vendor (`Combobox` from `getVendors`), HSN, GST%, default shot rate, active. On save → `createMould` → redirect to detail.

- [ ] **Step 4: Detail page** — header (inline edit, `po_create`) + **part-map editor**: rows of part `Combobox` (`portal`, server-search via `getMaterials`) + `qty_per_shot` input, add/remove rows, Save → `setMouldParts`. Read-only when lacking `po_create`.

- [ ] **Step 5: Build + commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=snorkel
```
Expected: zero errors. Then commit apps/snorkel (auto-deploys via gh-pages workflow).

---

### Task 6: apps/snorkel — PO form Part|Mould line kind + "Will receive" preview + print

**Files:**
- Modify: the PO new/edit form under `apps/snorkel/src/app/(auth)/procurement/pos/**` (the `postPO`/`amendPO` caller)
- Modify: the PO print/doc view (mould line rendering)

- [ ] **Step 1: Per-line kind toggle** — each PO line gets a **Part | Mould** switch. On **Mould**: replace the part-code cell with a mould `Combobox` (from `listMoulds`), a **shots** qty field; auto-fill `unit_price` from `default_shot_rate`, `hsn_code`/`gst_percent` from the mould (all overridable). The line submits as `{ item_type:'Mould', mould_no, qty_ordered:<shots>, unit_price, hsn_code, gst_percent }`.

- [ ] **Step 2: "Will receive" preview** — under a mould line, show a read-only expansion (from `getMould(mould_no).parts`): each `part_code · part_name × (shots × qty_per_shot)`. Purely informational.

- [ ] **Step 3: Print/doc** — a mould line renders `Mould <mould_no> — <description> × <shots> shots @ <rate>` (reads the line's `description`/`qty_ordered`/`unit_price`; no part expansion on the vendor doc).

- [ ] **Step 4: Build + commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=snorkel
```
Expected: zero errors. Commit + push (auto-deploy).

---

### Task 7: Cleanup the live hack (SHP-116 / D1-PB-40) + sweep aggregate codes

**Files:** SQL via Supabase MCP; snapshot first.

- [ ] **Step 1: Snapshot** the target rows:
```sql
CREATE TABLE store.safety_mould_cutover_2026_07_15_polines AS
  SELECT * FROM store.po_lines WHERE mould_no IS NULL AND (part_code='D1-PB-40' OR description ILIKE '%mold no%' OR description ILIKE '%mould%');
CREATE TABLE store.safety_mould_cutover_2026_07_15_rcv AS
  SELECT rl.* FROM store.receiving_lines rl
  JOIN store.shipments s ON s.shipment_id = rl.shipment_id
  WHERE rl.part_code='D1-PB-40';
```

- [ ] **Step 2: Convert the open mould-25306 PO line** (the one behind SHP-116) to a real mould line: set `mould_no='25306'`, `item_type='Mould'`, `part_code=NULL` on that `po_lines` row; delete the stale `receiving_lines` for the shipment; re-seed via the shipment's `RE-SYNC FROM BOM` button (or re-run `seedReceivingLinesFromPO`) so it explodes into the 8 real remote parts. Verify SHP-116 now shows the 8 part codes (each expected = shots × 1).

- [ ] **Step 3: Sweep + soft-deactivate** any remaining "mould-as-a-part" aggregate codes:
```sql
SELECT part_code, part_name FROM store.material_master
WHERE part_name ILIKE '%mold no%' OR part_name ILIKE '%mould no%';
```
For each confirmed one, deprecate per RULE-004 (`is_active=false`, `deprecated_at=now()`, `change_note`), only after its mould is mapped. Flag each to Afshaan; don't blind-deactivate one still in flight.

---

### Task 8: Docs

- [ ] **Step 1:** Add **RULE-SNORKEL-005** (mould-based procurement) to `systems/snorkel.md` — the order-by-mould/receive-by-part invariant, the tables, the explosion, cost-at-mould-grain, `po_create` gate.
- [ ] **Step 2:** `/schema-sync` to regenerate `reference/db-schema.md` (new tables + `po_lines.mould_no`).
- [ ] **Step 3:** Add a `[snorkel]` BACKLOG entry for the v2 follow-ups: coverage/supply-status mould-awareness; the 2 Flare tops (Task 2b); qty_per_shot confirmation.
- [ ] **Step 4:** `/session-wrap` at end (reconcile, commit/push every dirty repo, clean-state check).

---

## Self-review notes
- **Spec coverage:** data model (T1), mapping home + seed (T2/T2b), PO line (T4 s1), receiving explosion (T3), snorkel CRUD+UI (T4/T5/T6), cleanup (T7), out-of-scope follow-ups flagged (T8 s3). All spec sections mapped.
- **Blast radius:** only T3 (lotopsproxy) is 3-system; explicit deploy gate. T4 (snorkelops) is 1-system.
- **qty_per_shot=1** is the one seed assumption — surfaced to Afshaan; correctable in-UI (T5 s4) with zero code change.
