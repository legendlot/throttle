# Depot Dispatch Stock Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a governed, self-correcting dispatch stock-audit module in Depot — the floor scans held cars, the system shows a per-product variance with the exact missing box labels, and after a second person reviews, it corrects unit statuses.

**Architecture:** Self-contained (approach B). New `store.dispatch_audit*` tables own the whole flow (scans, frozen variance, correction record) — no coupling to `stock_adjustments`/L1-L2. Reads/writes via the shared `lotopsproxy` worker; a new `STOCK_AUDIT` scanner station captures scans; a Depot `/dispatch-audits` page is the register + review surface. Counter ≠ reviewer single-review governance reusing existing `cycle_count_record` / `cycle_count_approve_l1` permissions.

**Tech Stack:** Supabase Postgres (`store` schema, RLS), Cloudflare Worker `lotopsproxy` (`01_worker/worker.js`), Scanner PWA (`02_scanner/index.html`), Next.js static-export Depot app (`05_Throttle/apps/depot`), `@throttle/db` (`garageFetch` GET / `workerFetch` POST).

**Reference spec:** `docs/superpowers/specs/2026-06-17-depot-stock-audit-design.md`

**Blast radius warning:** `lotopsproxy` serves Garage + Redline + Scanner + Depot. A bad deploy takes down four systems. Always: edit → commit → push → `cd 01_worker && npx wrangler deploy`. Never deploy uncommitted; never run wrangler from the workspace root.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| Supabase migration `dispatch_stock_audit_v1` | 3 new `store` tables + RLS + grants + `store.sequences` key | apply via MCP |
| `01_worker/worker.js` | GET `getDispatchAudits`/`getDispatchAudit`; POST `createDispatchAudit`/`addAuditScansBulk`/`submitDispatchAudit`/`reviewDispatchAudit`/`cancelDispatchAudit`; SCANNER_ACTION `postStockAudit`; held-units + variance helpers; register `STOCK_AUDIT` in `OPERATOR_GATE_STATIONS` + `postStockAudit` in `SCANNER_ACTIONS` | modify |
| `02_scanner/index.html` | New Dispatch → Stock Audit station (`STOCK_AUDIT`) | modify |
| `05_Throttle/apps/depot/src/lib/nav.js` | Add **Stock Audit** under the Floor group | modify |
| `05_Throttle/apps/depot/src/app/(auth)/dispatch-audits/page.js` | Register list + detail/review UI | create |
| `CORE.md` / `BUSINESS_RULES.md` / `systems/depot.md` / `BACKLOG.md` | RULE-AUDIT-001 + shipped-state | modify (session-end) |

---

## Task 1: Database migration

**Files:**
- Apply migration `dispatch_stock_audit_v1` (Supabase MCP `apply_migration`).

- [ ] **Step 1: Verify the held-status assumption against live data**

Run (MCP `execute_sql`):
```sql
SELECT current_status, component_type, COUNT(*)
FROM public.units
WHERE current_status IN ('handed_over','allocated','pending_rtd','shipped')
GROUP BY 1,2 ORDER BY 1,2;
```
Expected: non-zero `car` rows for `handed_over` and `allocated`. Confirms the held filter `component_type='car' AND current_status IN ('handed_over','allocated')` is populated.

- [ ] **Step 2: Confirm the `store.sequences` shape**

Run:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='store' AND table_name='sequences' ORDER BY ordinal_position;
SELECT name, current_val FROM store.sequences WHERE name IN ('lot','docket_task') LIMIT 5;
```
Expected: columns `name` (text) + `current_val` (int/bigint). This is the table the new `dispatch_audit` key is seeded into.

- [ ] **Step 3: Apply the migration**

MCP `apply_migration`, name `dispatch_stock_audit_v1`:
```sql
create table if not exists store.dispatch_audits (
  id              bigint generated always as identity primary key,
  audit_no        text unique not null,
  status          text not null default 'open' check (status in ('open','in_review','completed','cancelled')),
  area            text,
  notes           text,
  opened_by       uuid not null,
  opened_at       timestamptz not null default now(),
  submitted_by    uuid,
  submitted_at    timestamptz,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  present_count   int,
  missing_count   int,
  extra_count     int,
  corrected_count int,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists store.dispatch_audit_scans (
  id           bigint generated always as identity primary key,
  audit_id     bigint not null references store.dispatch_audits(id) on delete cascade,
  car_upc      text not null,
  batch_label  text,
  product      text,
  model        text,
  color        text,
  scanned_by   uuid,
  device_code  text,
  scanned_at   timestamptz not null default now(),
  unique (audit_id, car_upc)
);
create index if not exists dispatch_audit_scans_audit_idx on store.dispatch_audit_scans(audit_id);

create table if not exists store.dispatch_audit_lines (
  id                  bigint generated always as identity primary key,
  audit_id            bigint not null references store.dispatch_audits(id) on delete cascade,
  car_upc             text not null,
  batch_label         text,
  product             text,
  model               text,
  color               text,
  result              text not null check (result in ('present','missing','extra')),
  expected_status     text,
  found_status        text,
  correction          text not null default 'none' check (correction in ('none','write_off','restore','skip')),
  corrected_to_status text,
  reviewed            boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists dispatch_audit_lines_audit_idx on store.dispatch_audit_lines(audit_id);

alter table store.dispatch_audits      enable row level security;
alter table store.dispatch_audit_scans enable row level security;
alter table store.dispatch_audit_lines enable row level security;

grant all on store.dispatch_audits      to service_role;
grant all on store.dispatch_audit_scans to service_role;
grant all on store.dispatch_audit_lines to service_role;

insert into store.sequences (name, current_val) values ('dispatch_audit', 0)
on conflict (name) do nothing;
```

- [ ] **Step 4: Verify the migration + advisors are clean**

Run:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='store' AND table_name LIKE 'dispatch_audit%' ORDER BY 1;
SELECT name, current_val FROM store.sequences WHERE name='dispatch_audit';
```
Expected: three tables listed; `dispatch_audit` seq present at 0.
Then run MCP `get_advisors` (type `security`) — expect NO new advisory naming `dispatch_audit*` (RLS is enabled, so none expected). If any appears, RLS wasn't applied — re-check Step 3.

---

## Task 2: Worker — held-units + variance helpers

These pure helpers are reused by `getDispatchAudit`, `submitDispatchAudit`, and `postStockAudit`. Add them near the other dispatch reads (around `getDispatchPipeline`, `worker.js:~3674`). Use the worker's existing Supabase query helpers (e.g. `queryPublic`/`queryStore` / `sbFetch` — match what `getDispatchPipeline` and `createUnitCount` use). Paginate any `units` read in pages of 1000 to respect the 50-subrequest limit (mirror the `handed_over` pagination already in `getDispatchPipeline`).

**Files:**
- Modify: `01_worker/worker.js`

- [ ] **Step 1: Add `HELD_STATUSES` + `fetchHeldCars(products)`**

```js
// Stock-audit: a car is physically held by dispatch when handed_over or allocated.
// (packed is a box state, not a unit status — packed units are 'allocated'.)
const AUDIT_HELD_STATUSES = ['handed_over', 'allocated'];

// Returns held cars, optionally restricted to a set of products (open-scope reporting).
// [{ upc, product, model, color, current_status, batch_label }]
async function fetchHeldCars(env, products /* array|null */) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    // mirror getDispatchPipeline's paginated select on public.units
    let q = sbSelect('public', 'units',
      'upc,product,model,color,current_status',
      { component_type: 'eq.car', current_status: `in.(${AUDIT_HELD_STATUSES.join(',')})` },
      { range: [from, from + PAGE - 1] });
    if (products && products.length) q = withFilter(q, 'product', `in.(${products.map(csvQuote).join(',')})`);
    const page = await q;
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  // attach batch_label from pkg_scans (LOT-<upc>-E/R), fallback dispatch_allocations
  const labels = await fetchBatchLabels(env, rows.map(r => r.upc));
  for (const r of rows) r.batch_label = labels[r.upc] || null;
  return rows;
}
```
> NOTE for implementer: `sbSelect`/`withFilter`/`csvQuote` are placeholders for the worker's real query helpers — replace with the exact ones used by `getDispatchPipeline` (read that handler first and mirror its select/pagination idiom). Do NOT introduce a new HTTP client.

- [ ] **Step 2: Add `fetchBatchLabels(upcs)`**

```js
// Map car_upc -> batch_label. Source pkg_scans (covers handed_over+allocated), fallback allocations.
async function fetchBatchLabels(env, upcs) {
  const out = {};
  for (let i = 0; i < upcs.length; i += 200) {            // batch IN-filters
    const chunk = upcs.slice(i, i + 200);
    const pk = await sbSelect('public', 'pkg_scans', 'car_upc,batch_label',
      { car_upc: `in.(${chunk.map(csvQuote).join(',')})` });
    for (const r of pk) if (r.batch_label && !out[r.car_upc]) out[r.car_upc] = r.batch_label;
    const missing = chunk.filter(u => !out[u]);
    if (missing.length) {
      const al = await sbSelect('public', 'dispatch_allocations', 'car_upc,batch_label',
        { car_upc: `in.(${missing.map(csvQuote).join(',')})` });
      for (const r of al) if (r.batch_label && !out[r.car_upc]) out[r.car_upc] = r.batch_label;
    }
  }
  return out;
}
```

- [ ] **Step 3: Add `computeAuditVariance(scans, heldCars)`**

```js
// scans: [{ car_upc, batch_label, product, model, color, current_status? }]
// heldCars: output of fetchHeldCars (already scoped to scanned products by caller)
// Returns { byProduct:[{product,model,color,held,scanned,missing,extra}],
//           missingLines:[...], extraLines:[...], present, missing, extra }
function computeAuditVariance(scans, heldCars) {
  const scannedSet = new Set(scans.map(s => s.car_upc));
  const heldByUpc  = new Map(heldCars.map(h => [h.upc, h]));
  const variantKey = r => `${r.product}|||${r.model || ''}|||${r.color || ''}`;

  const present = [], missing = [], extra = [];
  // missing = held, not scanned
  for (const h of heldCars) if (!scannedSet.has(h.upc)) missing.push(h);
  // present/extra from scans
  for (const s of scans) {
    if (heldByUpc.has(s.car_upc)) present.push(s);
    else extra.push(s);
  }

  // roll up per variant (only products represented in scans = open scope is enforced by caller
  // restricting heldCars to scanned products)
  const agg = new Map();
  const bump = (r, field) => {
    const k = variantKey(r);
    if (!agg.has(k)) agg.set(k, { product: r.product, model: r.model || null, color: r.color || null,
                                  held: 0, scanned: 0, missing: 0, extra: 0 });
    agg.get(k)[field]++;
  };
  for (const h of heldCars) bump(h, 'held');
  for (const s of present) bump(s, 'scanned');
  for (const s of extra)   { bump(s, 'scanned'); bump(s, 'extra'); }
  for (const m of missing) bump(m, 'missing');

  return {
    byProduct: [...agg.values()].sort((a,b)=> (a.product||'').localeCompare(b.product||'')),
    missingLines: missing.map(m => ({ car_upc: m.upc, batch_label: m.batch_label,
      product: m.product, model: m.model, color: m.color, result: 'missing', expected_status: m.current_status })),
    extraLines: extra.map(s => ({ car_upc: s.car_upc, batch_label: s.batch_label,
      product: s.product, model: s.model, color: s.color, result: 'extra', found_status: s.current_status || null })),
    present: present.length, missing: missing.length, extra: extra.length,
  };
}
```

- [ ] **Step 4: Add the scanned-products helper**

```js
// distinct products among an audit's scans, for open-scope held-car fetching
function scannedProducts(scans) {
  return [...new Set(scans.map(s => s.product).filter(Boolean))];
}
```

- [ ] **Step 5: Commit (no behaviour change yet — helpers only)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/01_worker
git add worker.js
git commit -m "depot stock-audit: held-cars + variance helpers"
```

---

## Task 3: Worker — read + lifecycle handlers (JWT)

Add these to the JWT-authenticated GET routing and POST switch. Mirror permission helpers from the cycle/unit-count handlers: `canCountRecord(permissions)` and `canCountApproveL1(permissions)` already exist (used by `createUnitCount`/`approveStockAdjustment`). Mint `AUD-NNNN` exactly like `createUnitCount` mints `UCN-NNN` (read `worker.js:~13351` and reuse that sequence idiom against key `dispatch_audit`).

**Files:**
- Modify: `01_worker/worker.js`

- [ ] **Step 1: `getDispatchAudits` (GET, register list)**

```js
// GET getDispatchAudits?status=&limit=
if (action === 'getDispatchAudits') {
  if (!canCountRecord(perm)) return forbid();
  const status = url.searchParams.get('status');
  let q = sbSelect('store', 'dispatch_audits',
    'id,audit_no,status,area,opened_by,opened_at,submitted_by,submitted_at,reviewed_by,reviewed_at,present_count,missing_count,extra_count,corrected_count',
    status && status !== 'all' ? { status: `eq.${status}` } : {},
    { order: 'opened_at.desc', limit: 200 });
  const rows = await q;
  return json({ audits: rows });
}
```

- [ ] **Step 2: `getDispatchAudit` (GET, detail + variance)**

```js
// GET getDispatchAudit?audit_no=AUD-0001
if (action === 'getDispatchAudit') {
  if (!canCountRecord(perm)) return forbid();
  const auditNo = url.searchParams.get('audit_no');
  const [audit] = await sbSelect('store','dispatch_audits','*',{ audit_no: `eq.${auditNo}` });
  if (!audit) return json({ error: 'not found' }, 404);
  const scans = await sbSelect('store','dispatch_audit_scans',
    'car_upc,batch_label,product,model,color,scanned_at',{ audit_id: `eq.${audit.id}` },{ limit: 20000 });

  if (audit.status === 'open') {
    // live variance: held cars restricted to scanned products (open scope)
    const prods = scannedProducts(scans);
    const held = prods.length ? await fetchHeldCars(env, prods) : [];
    // annotate scans with current_status so extras can show found_status
    const statusByUpc = new Map(held.map(h => [h.upc, h.current_status]));
    const scans2 = scans.map(s => ({ ...s, current_status: statusByUpc.get(s.car_upc) || null }));
    const v = computeAuditVariance(scans2, held);
    return json({ audit, scans_count: scans.length, variance: v, frozen: false });
  }
  // submitted/completed/cancelled: return frozen lines
  const lines = await sbSelect('store','dispatch_audit_lines','*',{ audit_id: `eq.${audit.id}` },{ limit: 20000 });
  return json({ audit, scans_count: scans.length, lines, frozen: true });
}
```

- [ ] **Step 3: `createDispatchAudit` (POST, one-open-at-a-time guard)**

```js
case 'createDispatchAudit': {
  if (!canCountRecord(perm)) return forbid();
  const existing = await sbSelect('store','dispatch_audits','id,audit_no',{ status: 'eq.open' });
  if (existing.length) return json({ error: `An audit is already open (${existing[0].audit_no}). Submit or cancel it first.` }, 409);
  const auditNo = await mintSeq('dispatch_audit', 'AUD');   // mirror UCN mint -> "AUD-0001"
  const [row] = await sbInsert('store','dispatch_audits',
    { audit_no: auditNo, status: 'open', area: data.area || null, notes: data.notes || null, opened_by: userId });
  return json({ audit: row });
}
```

- [ ] **Step 4: `addAuditScansBulk` (POST, desk paste)**

```js
case 'addAuditScansBulk': {
  if (!canCountRecord(perm)) return forbid();
  const [audit] = await sbSelect('store','dispatch_audits','id,status',{ audit_no: `eq.${data.audit_no}` });
  if (!audit || audit.status !== 'open') return json({ error: 'audit not open' }, 409);
  const tokens = [...new Set((data.codes || []).map(String).map(s=>s.trim()).filter(Boolean))];
  const resolved = await resolveAuditUnits(env, tokens);   // see Task 4 Step 2 (shared resolver)
  if (resolved.length) {
    await sbUpsert('store','dispatch_audit_scans',
      resolved.map(u => ({ audit_id: audit.id, car_upc: u.upc, batch_label: u.batch_label,
        product: u.product, model: u.model, color: u.color, device_code: 'DESK-AUDIT' })),
      { onConflict: 'audit_id,car_upc', ignoreDuplicates: true });
  }
  const cnt = await sbCount('store','dispatch_audit_scans',{ audit_id: `eq.${audit.id}` });
  return json({ added: resolved.length, total_scanned: cnt });
}
```

- [ ] **Step 5: `submitDispatchAudit` (POST, freeze variance → lines)**

```js
case 'submitDispatchAudit': {
  if (!canCountRecord(perm)) return forbid();
  const [audit] = await sbSelect('store','dispatch_audits','*',{ audit_no: `eq.${data.audit_no}` });
  if (!audit || audit.status !== 'open') return json({ error: 'audit not open' }, 409);
  const scans = await sbSelect('store','dispatch_audit_scans','car_upc,batch_label,product,model,color',{ audit_id: `eq.${audit.id}` },{ limit: 20000 });
  const prods = scannedProducts(scans);
  const held = prods.length ? await fetchHeldCars(env, prods) : [];
  const statusByUpc = new Map(held.map(h => [h.upc, h.current_status]));
  const scans2 = scans.map(s => ({ ...s, current_status: statusByUpc.get(s.car_upc) || null }));
  const v = computeAuditVariance(scans2, held);

  // write discrepancy lines (missing + extra) with default corrections
  const lines = [
    ...v.missingLines.map(l => ({ audit_id: audit.id, ...l, correction: 'write_off' })),
    ...v.extraLines.map(l => ({ audit_id: audit.id, ...l, correction: 'restore' })),
  ];
  if (lines.length) await sbInsert('store','dispatch_audit_lines', lines);
  await sbUpdate('store','dispatch_audits',{ id: `eq.${audit.id}` },
    { status: 'in_review', submitted_by: userId, submitted_at: nowIso(),
      present_count: v.present, missing_count: v.missing, extra_count: v.extra, updated_at: nowIso() });
  return json({ status: 'in_review', present: v.present, missing: v.missing, extra: v.extra });
}
```

- [ ] **Step 6: `reviewDispatchAudit` (POST, approve + correct; counter ≠ reviewer)**

```js
case 'reviewDispatchAudit': {
  if (!canCountApproveL1(perm)) return forbid();
  const [audit] = await sbSelect('store','dispatch_audits','*',{ audit_no: `eq.${data.audit_no}` });
  if (!audit || audit.status !== 'in_review') return json({ error: 'audit not in review' }, 409);
  // check-and-balance: approver must differ from opener AND submitter
  if (userId === audit.opened_by || userId === audit.submitted_by)
    return json({ error: 'The person who opened or submitted the audit cannot approve it.' }, 403);

  const skipIds = new Set((data.skip_line_ids || []).map(Number));
  const lines = await sbSelect('store','dispatch_audit_lines','*',{ audit_id: `eq.${audit.id}` },{ limit: 20000 });
  let corrected = 0;
  for (const ln of lines) {
    if (skipIds.has(ln.id)) { await sbUpdate('store','dispatch_audit_lines',{ id:`eq.${ln.id}` },{ correction:'skip', reviewed:true }); continue; }
    // re-validate the unit's CURRENT status before correcting (it may have moved since submit)
    const [u] = await sbSelect('public','units','upc,current_status',{ upc: `eq.${ln.car_upc}` });
    if (!u) { await sbUpdate('store','dispatch_audit_lines',{ id:`eq.${ln.id}` },{ reviewed:true }); continue; }
    let target = null;
    if (ln.result === 'missing' && ln.correction === 'write_off'
        && AUDIT_HELD_STATUSES.includes(u.current_status)) target = 'lost';
    if (ln.result === 'extra' && ln.correction === 'restore'
        && !AUDIT_HELD_STATUSES.includes(u.current_status)
        && u.current_status !== 'lost' === false /* allow restoring lost */) {} // see note
    if (ln.result === 'extra' && ln.correction === 'restore'
        && !AUDIT_HELD_STATUSES.includes(u.current_status)) target = 'handed_over';
    if (target) {
      await sbUpdate('public','units',{ upc:`eq.${ln.car_upc}` },{ current_status: target, updated_at: nowIso() });
      await sbUpdate('store','dispatch_audit_lines',{ id:`eq.${ln.id}` },{ corrected_to_status: target, reviewed:true });
      corrected++;
    } else {
      await sbUpdate('store','dispatch_audit_lines',{ id:`eq.${ln.id}` },{ reviewed:true });
    }
  }
  await sbUpdate('store','dispatch_audits',{ id:`eq.${audit.id}` },
    { status:'completed', reviewed_by:userId, reviewed_at:nowIso(), corrected_count:corrected, updated_at:nowIso() });
  return json({ status:'completed', corrected });
}
```
> NOTE: drop the dead `=== false` placeholder line above — extras restore from ANY non-held status (including `lost`); the single clean rule is `if extra & restore & current_status NOT IN held → handed_over`. Keep only that branch.

- [ ] **Step 7: `cancelDispatchAudit` (POST)**

```js
case 'cancelDispatchAudit': {
  if (!canCountRecord(perm) && !canCountApproveL1(perm)) return forbid();
  const [audit] = await sbSelect('store','dispatch_audits','id,status',{ audit_no: `eq.${data.audit_no}` });
  if (!audit || audit.status === 'completed') return json({ error: 'cannot cancel' }, 409);
  await sbUpdate('store','dispatch_audits',{ id:`eq.${audit.id}` },{ status:'cancelled', notes: data.reason || audit.notes, updated_at: nowIso() });
  return json({ status:'cancelled' });
}
```
> `sbSelect/sbInsert/sbUpdate/sbUpsert/sbCount/mintSeq/json/forbid/nowIso/perm/userId/data` are placeholders — wire each to the worker's real helpers and the surrounding handler's destructuring (read a neighboring POST case, e.g. `createUnitCount`/`completeUnitCount`, and match it exactly).

- [ ] **Step 8: Commit + deploy + smoke**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/01_worker
git add worker.js && git commit -m "depot stock-audit: register + lifecycle handlers" && git push
npx wrangler deploy
```
Then smoke with a JWT (or via the Depot UI in Task 6). Minimum curl smoke (replace URL/JWT):
```bash
curl -s "$LOTOPS/?action=getDispatchAudits" -H "Authorization: Bearer $JWT" | head
```
Expected: `{"audits":[]}` (200), no 500.

---

## Task 4: Worker — `postStockAudit` scanner action

**Files:**
- Modify: `01_worker/worker.js` — `SCANNER_ACTIONS` (`~4803`), `OPERATOR_GATE_STATIONS` (`~8442`), new SCANNER_ACTIONS handler block.

- [ ] **Step 1: Register the action + station**

In `SCANNER_ACTIONS` array add `'postStockAudit'`. In `OPERATOR_GATE_STATIONS` set add `'STOCK_AUDIT'`.

- [ ] **Step 2: Shared resolver `resolveAuditUnits(tokens)`**

Resolve scanned labels/UPCs → unit rows. A scan value is a box label `LOT-<upc>-E/R`; strip the trailing `-E`/`-R` to get the UPC, and also accept a bare UPC. Then fetch the unit. (Mirror how `postDtk` resolves a `batch_label` to a unit, `worker.js:~6297`.)
```js
async function resolveAuditUnits(env, tokens) {
  const upcs = [...new Set(tokens.map(t => String(t).replace(/-(E|R)$/i, '').trim()).filter(Boolean))];
  const out = [];
  for (let i = 0; i < upcs.length; i += 200) {
    const chunk = upcs.slice(i, i + 200);
    const rows = await sbSelect('public','units','upc,product,model,color,current_status',
      { upc: `in.(${chunk.map(csvQuote).join(',')})`, component_type: 'eq.car' });
    out.push(...rows.map(r => ({ ...r })));
  }
  const labels = await fetchBatchLabels(env, out.map(r => r.upc));
  for (const r of out) r.batch_label = labels[r.upc] || null;
  return out;
}
```

- [ ] **Step 3: The `postStockAudit` handler (inside the SCANNER_ACTIONS block)**

```js
if (body.action === 'postStockAudit') {
  const { batch_label, device_id, operator_id, audit_id } = body.data || body;
  // resolve the single OPEN audit (or the one passed)
  let audit;
  if (audit_id) [audit] = await sbSelect('store','dispatch_audits','id,audit_no,status',{ id: `eq.${audit_id}` });
  else [audit] = await sbSelect('store','dispatch_audits','id,audit_no,status',{ status: 'eq.open' });
  if (!audit || audit.status !== 'open')
    return json({ ok:false, message:'No open audit. Open one in Depot.' }, 200); // soft, never hard-block

  const [u] = await resolveAuditUnits(env, [batch_label]);
  if (!u) return json({ ok:false, message:'Unknown label', batch_label }, 200);

  await sbUpsert('store','dispatch_audit_scans',
    [{ audit_id: audit.id, car_upc: u.upc, batch_label: u.batch_label || batch_label,
       product: u.product, model: u.model, color: u.color, scanned_by: operator_id || null, device_code: null }],
    { onConflict: 'audit_id,car_upc', ignoreDuplicates: true });

  const total = await sbCount('store','dispatch_audit_scans',{ audit_id: `eq.${audit.id}` });
  const held = AUDIT_HELD_STATUSES.includes(u.current_status);
  return json({ ok:true, audit_no: audit.audit_no, car_upc: u.upc,
    product: u.product, model: u.model, color: u.color, held, total_scanned: total }, 200);
}
```
> It NEVER hard-rejects: an unknown label or not-currently-held unit returns `ok:false`/`held:false` but the scanner stays green (this is an audit, every scan is data). This is the deliberate soft-policy exception to RULE-SCAN-001's hard-reject default — note it in the rule.

- [ ] **Step 4: Commit + deploy + smoke**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/01_worker
git add worker.js && git commit -m "depot stock-audit: postStockAudit scanner action + STOCK_AUDIT gate" && git push
npx wrangler deploy
```
Smoke: create an audit via the UI/curl, then POST a known `LOT-…-E` label to `postStockAudit` and confirm `total_scanned` increments and a second identical POST does NOT increment (dedup).

---

## Task 5: Scanner — Stock Audit station

**Files:**
- Modify: `02_scanner/index.html` — Dispatch department categories (`~2178`), station line-type map (`~2189`), station config (`~2064`), scan handler (`~4800+`).

- [ ] **Step 1: Add the category under Dispatch**

In the `dispatch` department `categories` array, add:
```js
{ key: 'stock_audit', label: 'Stock Audit', stations: ['STOCK_AUDIT'] },
```

- [ ] **Step 2: Line type + station config**

Add `STOCK_AUDIT: 'D'` to the station→line-type map. Add a station config entry:
```js
STOCK_AUDIT: { label: 'Stock Audit', activity: 'STOCK_AUDIT',
  hint: 'Scan every car box label you physically hold. Re-scans are ignored. Open the audit in Depot first.' },
```

- [ ] **Step 3: Scan submit + open-audit resolution**

On entering the station, fetch the open audit (`getDispatchAudits?status=open` via the scanner's GET helper) and show its `audit_no` (or "No open audit — open one in Depot" and disable scanning). On each scan:
```js
if (act === 'STOCK_AUDIT') {
  const res = await workerPost('postStockAudit', {
    batch_label: barcode,
    device_id:   cfg.deviceId || null,
    operator_id: operatorUUID || currentOperator?.id || null,
    audit_id:    openAuditId || null,
  });
  if (res.ok) showOk(`${res.product} ${res.color||''} · ${res.total_scanned} scanned${res.held?'':' ⚠ not currently held'}`);
  else        showWarn(res.message || 'not recorded');   // soft, stay on station
}
```

- [ ] **Step 4: Commit + deploy**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/02_scanner
git add index.html && git commit -m "scanner: Dispatch Stock Audit station (STOCK_AUDIT)" && git push
npx wrangler deploy   # if the scanner is wrangler-deployed; else its gh-pages/CI path
```
> CONFIRM the scanner's deploy mechanism first (`02_scanner` is `legendlot/production`). If it deploys via CI on push, the push IS the deploy — don't run wrangler. Verify in the repo's workflow.

---

## Task 6: Depot UI — register + review page

**Files:**
- Modify: `05_Throttle/apps/depot/src/lib/nav.js`
- Create: `05_Throttle/apps/depot/src/app/(auth)/dispatch-audits/page.js`

- [ ] **Step 1: Nav entry under Floor**

In `nav.js`, add to the **Floor** group: `{ label: 'Stock Audit', route: '/dispatch-audits', icon: <ClipboardCheck-or-similar> }` (match the existing Floor items' object shape exactly — read the file first).

- [ ] **Step 2: Build the page (`dispatch-audits/page.js`)**

Mirror an existing Depot list+detail page (e.g. `dispatch-counts/page.js` or `restock/page.js`) for layout, the Depot kit imports (Panel/FilterChip/ToneBadge/Icon), and the `garageFetch`/`workerFetch` usage. Implement:
- **List**: `garageFetch('getDispatchAudits', { status })` → table (audit_no, status badge, opened by/at, present/missing/extra, corrected). Status filter chips. "Open new audit" → `workerFetch('createDispatchAudit', { area, notes })` (handle the 409 "already open" with a toast).
- **Detail** (`getDispatchAudit?audit_no=`):
  - *open*: variance table from `variance.byProduct`; missing-labels drilldown (`variance.missingLines` → list of `batch_label`); extra list; a "Add scans (paste)" textarea → `workerFetch('addAuditScansBulk', { audit_no, codes })`; **Submit for review** → `workerFetch('submitDispatchAudit', { audit_no })`.
  - *in_review*: frozen `lines`; per-line skip checkboxes; **Approve & correct** → `workerFetch('reviewDispatchAudit', { audit_no, skip_line_ids })`. Button hidden if `me.id === audit.submitted_by || me.id === audit.opened_by` (server enforces too). Gate the button on the `cycle_count_approve_l1` permission via `hasPermission`.
  - *completed/cancelled*: read-only lines + what was corrected.

- [ ] **Step 3: Build green**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle
npx turbo build --filter=@throttle/depot
```
Expected: build succeeds; route count increases by 1 (new `/dispatch-audits`).

- [ ] **Step 4: Commit + push (CI deploys Depot)**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/depot/src/lib/nav.js apps/depot/src/app/\(auth\)/dispatch-audits/page.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "depot: Stock Audit register + review page"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
```

---

## Task 7: End-to-end verification (signed-in, on a non-prod-affecting audit)

- [ ] **Step 1: Full happy path**

In Depot: open an audit → in the scanner Stock Audit station, scan a few real held box labels → in Depot watch the variance populate (held vs scanned per product) → deliberately leave one held unit un-scanned → confirm it shows as **missing with its batch label** → submit → sign in as a *different* approver → confirm the counter cannot approve (button hidden + server 403 if forced) → approve → confirm the missing unit's `current_status` flipped to `lost`:
```sql
SELECT upc, current_status FROM public.units WHERE upc = '<the missing upc>';
SELECT audit_no, status, present_count, missing_count, extra_count, corrected_count
FROM store.dispatch_audits ORDER BY id DESC LIMIT 1;
```

- [ ] **Step 2: Extra path**

Scan a unit currently `shipped` into a fresh audit → confirm it lists as **extra** → approve → confirm it flipped to `handed_over`.

- [ ] **Step 3: Dedup + one-open guard**

Re-scan the same label twice → `total_scanned` unchanged. Try `createDispatchAudit` while one is open → 409.

- [ ] **Step 4: Reverse the test write-offs (cleanup)**

Restore any units you flipped during testing to their prior status via SQL (record their original status before testing), so the floor data is untouched.

---

## Task 8: Knowledge files (session-end)

- [ ] Add **RULE-AUDIT-001** to `BUSINESS_RULES.md` (full-scan, open-scope, dedup, counter≠reviewer single-review, missing→lost / extra→handed_over, self-contained `store.dispatch_audit*`, soft-scan exception to RULE-SCAN-001).
- [ ] Note the new schema bullet (3 `store.dispatch_audit*` tables + `dispatch_audit` sequence) and the `STOCK_AUDIT` station in `CORE.md`.
- [ ] Update `systems/depot.md`: new **Stock Audit** screen under Floor + the scanner station; move it out of "Later phases".
- [ ] `BACKLOG.md`: this was a fresh request (no prior backlog line); add any v2 follow-ups (scheduling/reminders, concurrent D1/D2 audits, stock_adjustments unification) under `[depot]`.
- [ ] Bump `Last updated` on each changed knowledge file; commit + push the workspace root.

---

## Self-review notes (author)

- **Spec coverage:** held filter (T1/T2), dedup scan (T4/T1 unique), open-scope variance (T2 `scannedProducts`+T3 detail), missing batch labels (T2 `fetchBatchLabels`+T6 drilldown), submit-freeze (T3.5), counter≠reviewer (T3.6 guard + T6 button), missing→lost / extra→handed_over (T3.6), register (T3.1+T6), scanner station (T4/T5), permissions reuse (T3), one-open guard (T3.3). All covered.
- **Re-validation at post:** corrections re-check live `current_status` (T3.6) — handles units that moved between submit and approve.
- **Soft scan:** `postStockAudit` never hard-blocks — explicit RULE-SCAN-001 exception to document (T8).
- **Placeholder helpers:** `sbSelect`/`workerPost`/etc. are named placeholders deliberately flagged for the implementer to bind to the worker's real helpers by reading neighboring handlers — NOT left vague on behaviour.
- **Dead-line fix:** the `=== false` placeholder in T3.6 Step 6 is explicitly called out to delete; the single clean extra-restore rule is stated.
