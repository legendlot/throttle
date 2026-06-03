# Garage Dashboard — PCB & FBU/SKD Unit Sections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two at-a-glance sections to the top of the Garage Dashboard — PCB stock (car/remote per product) and FBU/SKD unit stock (car/remote per product) — and move the existing Reorder Flags + Producible grid below them.

**Architecture:** One additive read-only lotopsproxy GET action (`getDashboardUnits`) computes both datasets server-side and returns `{ pcb, units }`. The Garage dashboard page gains a loader, two render sections, and a collapsible-row interaction (reusing existing styles/patterns). No new tables, no migration.

**Tech Stack:** Cloudflare Worker (`01_worker/worker.js`, vanilla JS), Next.js static-export React (`05_Throttle/apps/garage`), Supabase/PostgREST via the worker's `query()` helper.

**No test framework exists in this repo.** Verification is: (a) SQL sanity checks run against Supabase that mirror the endpoint's logic, (b) `npx turbo build --filter=garage` (zero errors required), and (c) live browser observation after deploy. There are no unit tests to write.

**Conventions (from CLAUDE.md):**
- PostgREST returns numeric columns as **strings** → wrap every numeric with `Number()`.
- 50-subrequest limit → batch via `IN` filters, never loop awaits.
- Worker: edit → commit → push → `cd 01_worker && npx wrangler deploy`. Never deploy without committing.
- Garage auto-deploys on push to `main` in `05_Throttle`.
- Cross-repo git: always `git -C <path>`, never `cd <dir> && git`.

**Reference numbers (live data, 2026-06-03) — the endpoint should reproduce these:**
- PCB section (17 products). Spot-check rows: `Bumble {car:65, remote:166}`, `Dash {car:null, remote:950}`, `Fang {car:261, remote:-69}`, `Flare {car:707, remote:990}`, `Knox {car:7800, remote:8120}`, `Shadow {car:6362, remote:5906}`, `Apex {car:0, remote:0}`, `McCloud {car:0, remote:null}`, `Ellie {car:0, remote:null}`, `Nitro {car:null, remote:-650}`.
- FBU/SKD section: `Flare {formats:[SKD], car:500, remote:500}`, `Mac {formats:[FBU], car:1000, remote:null}` (Black 500 + Red 500), `Nitro {formats:[FBU], car:-600, remote:null}` (Race·Blue -95 + Tarmac·Black -505), `Rift {car:0}`, `Rumble {car:114}`.

---

## File Structure

- **`01_worker/worker.js`** — add one `case 'getDashboardUnits'` inside the authenticated GET `switch`, placed immediately after `case 'getFbuStock'` (line ~1216). Self-contained; owns all PCB/FBU/SKD identification logic.
- **`05_Throttle/apps/garage/src/app/(auth)/dashboard/page.js`** — add a `loadUnits` loader (mirrors `loadProducible`), `units`/`unitsLoading`/`expandedUnitIndex` state, wire into `loadAll`, and render two new `<section>`s + move the existing Reorder/Producible grid below them.

---

## Task 1: Add the `getDashboardUnits` worker endpoint

**Files:**
- Modify: `01_worker/worker.js` — insert a new `case` after `case 'getFbuStock'` (ends ~line 1216, before `case 'getProductReceiveFormats'`).

- [ ] **Step 1: Pull and locate the insertion point**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude && git -C 01_worker pull
grep -n "case 'getFbuStock'\|case 'getProductReceiveFormats'" 01_worker/worker.js
```
Expected: two line numbers; insert the new case between them (after `getFbuStock`'s closing `}` and before `case 'getProductReceiveFormats': {`).

- [ ] **Step 2: Insert the new case**

Insert this block immediately after the `getFbuStock` case's closing brace:

```javascript
          case 'getDashboardUnits': {
            // Two at-a-glance dashboard datasets (read-only):
            //   pcb[]   — Car PCB + Remote PCB live stock per product
            //   units[] — FBU + SKD car/remote unit stock per product (collapsible variants)
            // PCB = a -EL- coded, active bom_register part whose name contains "PCB"
            // (the -EL- guard excludes BM-PB-38 "PCB Cover"). Car vs Remote splits on
            // part_category ('Remote' => remote; anything else => car). SKD car =
            // "Half Built Chassis", remote = "Built Up Remote"; other SKD bundle rows
            // (bag, tops, screws, cable) are NOT counted toward the unit totals.
            const [bomR, fbuR] = await Promise.all([
              query('bom_register',
                '?is_active=eq.true&select=part_code,part_name,product,part_category,variant_model,bom_format&limit=5000'),
              query('fbu_stock', '?select=product,variant,color,component_type,qty_on_hand'),
            ]);
            if (!bomR.ok) return err(bomR.data);
            const bomRows = bomR.data || [];

            const isEl  = (r) => /-EL-/i.test(r.part_code || '');
            const isPcb = (r) => isEl(r) && /pcb/i.test(r.part_name || '');
            const isSkd = (r) => (r.bom_format || '') === 'SKD';
            const skdName = (r) => (r.part_name || '').toLowerCase();
            const isChassis = (r) => skdName(r).includes('half built chassis');
            const isBuiltRemote = (r) => skdName(r).includes('built up remote');

            // Stock only for the parts we actually display (one IN query).
            const wantCodes = [...new Set(
              bomRows
                .filter(r => isPcb(r) || (isSkd(r) && (isChassis(r) || isBuiltRemote(r))))
                .map(r => r.part_code)
                .filter(Boolean)
            )];
            const stockMap = {};
            if (wantCodes.length) {
              const inList = wantCodes.map(encodeURIComponent).join(',');
              const slR = await query('stock_ledger',
                `?part_code=in.(${inList})&select=part_code,closing_stock`);
              if (slR.ok) slR.data.forEach(r => { stockMap[r.part_code] = Number(r.closing_stock) || 0; });
            }

            // ---- PCBs ----
            const pcbMap = {};
            bomRows.filter(isPcb).forEach(r => {
              const p = pcbMap[r.product] || (pcbMap[r.product] = {
                product: r.product, car_stock: null, remote_stock: null, car_code: null, remote_code: null,
              });
              const stock = stockMap[r.part_code] ?? 0;
              if ((r.part_category || '').toLowerCase() === 'remote') {
                p.remote_stock = (p.remote_stock || 0) + stock;
                if (!p.remote_code) p.remote_code = r.part_code;
              } else {
                p.car_stock = (p.car_stock || 0) + stock;
                if (!p.car_code) p.car_code = r.part_code;
              }
            });
            const pcb = Object.values(pcbMap).sort((a, b) => a.product.localeCompare(b.product));

            // ---- FBU + SKD units ----
            const uMap = {};
            const getU = (product) => uMap[product] || (uMap[product] = {
              product, formats: new Set(), car: [], remote: [],
            });

            (fbuR.ok ? fbuR.data : []).forEach(r => {
              const u = getU(r.product);
              u.formats.add('FBU');
              const label = [r.variant, r.color].filter(Boolean).join(' · ') || '—';
              const qty = Number(r.qty_on_hand) || 0;
              if ((r.component_type || '').toLowerCase() === 'remote') u.remote.push({ label, qty });
              else u.car.push({ label, qty });
            });

            bomRows.filter(isSkd).forEach(r => {
              const chassis = isChassis(r), builtRemote = isBuiltRemote(r);
              if (!chassis && !builtRemote) return; // loose bundle parts not counted
              const u = getU(r.product);
              u.formats.add('SKD');
              const label = r.variant_model || '—';
              const qty = stockMap[r.part_code] ?? 0;
              if (builtRemote) u.remote.push({ label, qty });
              else u.car.push({ label, qty });
            });

            const sum = (arr) => arr.reduce((s, x) => s + x.qty, 0);
            const units = Object.values(uMap).map(u => {
              const labels = [...new Set([...u.car.map(x => x.label), ...u.remote.map(x => x.label)])];
              const variants = labels.map(label => {
                const carLines = u.car.filter(x => x.label === label);
                const remLines = u.remote.filter(x => x.label === label);
                return {
                  label,
                  car:    carLines.length ? sum(carLines) : null,
                  remote: remLines.length ? sum(remLines) : null,
                };
              });
              return {
                product: u.product,
                formats: [...u.formats],
                car_total:    u.car.length    ? sum(u.car)    : null,
                remote_total: u.remote.length ? sum(u.remote) : null,
                variants,
              };
            }).sort((a, b) => a.product.localeCompare(b.product));

            return ok({ pcb, units });
          }
```

- [ ] **Step 3: Lint-check the file parses**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude && node --check 01_worker/worker.js
```
Expected: no output (exit 0). If it errors, fix the syntax before continuing.

- [ ] **Step 4: Commit, push, deploy**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude
git -C 01_worker add worker.js
git -C 01_worker commit -m "feat(lotopsproxy): getDashboardUnits — PCB + FBU/SKD dashboard datasets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git -C 01_worker push
cd 01_worker && npx wrangler deploy
```
Expected: push succeeds; wrangler prints a new version ID. Record the version ID.

- [ ] **Step 5: Verify the endpoint logic via SQL (mirrors the worker)**

Run this in Supabase (project `jkxcnjabmrkteanzoofj`) and confirm it matches the reference numbers in the plan header:
```sql
-- PCB dataset
WITH pcb AS (
  SELECT b.product,
         CASE WHEN lower(b.part_category)='remote' THEN 'remote' ELSE 'car' END AS side,
         COALESCE(sl.closing_stock,0) AS stock
  FROM store.bom_register b
  LEFT JOIN store.stock_ledger sl ON sl.part_code=b.part_code
  WHERE b.is_active=true AND b.part_code ~* '-EL-' AND b.part_name ~* 'pcb'
)
SELECT product,
       SUM(stock) FILTER (WHERE side='car')    AS car,
       SUM(stock) FILTER (WHERE side='remote') AS remote
FROM pcb GROUP BY product ORDER BY product;
```
Expected: 17 rows; `Bumble car 65 / remote 166`, `Flare car 707 / remote 990`, `Knox 7800 / 8120`, etc. (per header). A `car`/`remote` of NULL renders `—` client-side.

```sql
-- SKD units (chassis=car, built-up-remote=remote)
SELECT b.product,
       SUM(COALESCE(sl.closing_stock,0)) FILTER (WHERE lower(b.part_name) LIKE '%half built chassis%') AS car,
       SUM(COALESCE(sl.closing_stock,0)) FILTER (WHERE lower(b.part_name) LIKE '%built up remote%')   AS remote
FROM store.bom_register b
LEFT JOIN store.stock_ledger sl ON sl.part_code=b.part_code
WHERE b.is_active=true AND b.bom_format='SKD'
GROUP BY b.product ORDER BY b.product;
```
Expected: `Flare car 500 / remote 500`.

```sql
-- FBU units
SELECT product, component_type, SUM(qty_on_hand) AS qty
FROM store.fbu_stock GROUP BY product, component_type ORDER BY product;
```
Expected: `Mac car 1000`, `Nitro car -600`, `Rift car 0`, `Rumble car 114` (all car; no remote rows yet).

---

## Task 2: Dashboard loader + state

**Files:**
- Modify: `05_Throttle/apps/garage/src/app/(auth)/dashboard/page.js`

- [ ] **Step 1: Pull**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude && git -C 05_Throttle pull
```

- [ ] **Step 2: Add the `loadUnits` loader function**

Insert this function immediately after `loadProducible` (ends ~line 117, before `loadActivity`):

```javascript
async function loadUnits(session, setUnits, setUnitsLoading) {
  setUnitsLoading(true);
  try {
    const data = await garageFetch('getDashboardUnits', {}, session);
    setUnits({ pcb: data?.pcb || [], units: data?.units || [] });
  } catch (e) {
    setUnits({ pcb: [], units: [] });
  } finally {
    setUnitsLoading(false);
  }
}
```

- [ ] **Step 3: Add state + wire into `loadAll`**

In `DashboardPage`, after the `producible`/`prodLoading` state declarations (~line 196), add:
```javascript
  const [units, setUnits] = useState({ pcb: [], units: [] });
  const [unitsLoading, setUnitsLoading] = useState(true);
  const [expandedUnitIndex, setExpandedUnitIndex] = useState(null);
```

Then in the `loadAll` function (~line 201-206), add the new loader call alongside the others:
```javascript
  function loadAll() {
    if (!session || productsLoading) return;
    loadMain(session, setKpis, setSections, setMainLoading, setMainError, setRefreshing);
    loadProducible(session, PRODUCTS, setProducible, setProdLoading);
    loadUnits(session, setUnits, setUnitsLoading);
    loadActivity(session, setActivity, setActLoading);
  }
```

- [ ] **Step 4: Build to confirm it compiles (no render yet)**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=garage
```
Expected: build completes with zero errors. (The new state/loader are unused so far — that's fine; Next.js won't error on unused locals.)

- [ ] **Step 5: Commit**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git -C 05_Throttle add apps/garage/src/app/\(auth\)/dashboard/page.js
git -C 05_Throttle commit -m "feat(garage): dashboard getDashboardUnits loader + state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Render the PCB + FBU/SKD sections and move the existing grid below

**Files:**
- Modify: `05_Throttle/apps/garage/src/app/(auth)/dashboard/page.js`

- [ ] **Step 1: Insert the two new sections before the existing Reorder/Producible grid**

The existing Reorder Flags + Producible grid begins at `<div style={twoColStyle}>` right after the KPI-cards block closes (~line 313, the first `<div style={twoColStyle}>`). Insert the following JSX **immediately before** that `<div style={twoColStyle}>` opening tag (i.e. between the KPI cards closing `)}` and the Reorder grid):

```jsx
      <div style={twoColStyle}>
        {/* ---- PCBs ---- */}
        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>PCBs — Car &amp; Remote</span>
            <span style={{ color: 'var(--t3)' }}>{units.pcb.length} products</span>
          </header>
          <div>
            {unitsLoading ? (
              <div style={{ padding: 16, textAlign: 'center' }}><Spinner size="sm" /></div>
            ) : units.pcb.length === 0 ? (
              <EmptyState message="No PCB parts found" />
            ) : (
              units.pcb.map((r, i) => (
                <div key={r.product} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 16px',
                  borderBottom: i === units.pcb.length - 1 ? 'none' : '1px solid var(--border)',
                }}>
                  <div style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 14 }}>{r.product}</div>
                  <div style={{ display: 'flex', gap: 28, textAlign: 'right' }}>
                    <UnitStat label="Car" value={r.car_stock} />
                    <UnitStat label="Remote" value={r.remote_stock} />
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ---- FBU & SKD units ---- */}
        <section style={panelStyle}>
          <header style={panelHeaderStyle}>
            <span>FBU &amp; SKD Units</span>
            <span style={{ color: 'var(--t3)' }}>{units.units.length} products</span>
          </header>
          <div>
            {unitsLoading ? (
              <div style={{ padding: 16, textAlign: 'center' }}><Spinner size="sm" /></div>
            ) : units.units.length === 0 ? (
              <EmptyState message="No FBU or SKD stock" />
            ) : (
              units.units.map((r, i) => {
                const isOpen = expandedUnitIndex === i;
                const isLast = i === units.units.length - 1;
                const hasVariants = (r.variants || []).length > 1;
                return (
                  <div key={r.product} style={{
                    padding: '10px 16px',
                    borderBottom: isLast ? 'none' : '1px solid var(--border)',
                  }}>
                    <div
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: hasVariants ? 'pointer' : 'default' }}
                      onClick={() => hasVariants && setExpandedUnitIndex(isOpen ? null : i)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 14 }}>{r.product}</span>
                        {(r.formats || []).map(f => (
                          <StatusBadge key={f} label={f} tone={f === 'SKD' ? 'orange' : 'blue'} />
                        ))}
                        {hasVariants && (
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
                            {isOpen ? '▼' : '▶'}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 28, textAlign: 'right' }}>
                        <UnitStat label="Car" value={r.car_total} />
                        <UnitStat label="Remote" value={r.remote_total} />
                      </div>
                    </div>
                    {isOpen && hasVariants && (
                      <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3 }}>
                        {r.variants.map((v, j) => (
                          <div key={j} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '3px 0', fontSize: 12,
                            borderBottom: j < r.variants.length - 1 ? '1px solid rgba(42,42,42,.4)' : 'none',
                          }}>
                            <span style={{ color: 'var(--t2)' }}>{v.label}</span>
                            <div style={{ display: 'flex', gap: 24, textAlign: 'right' }}>
                              <UnitStat label="Car" value={v.car} small />
                              <UnitStat label="Remote" value={v.remote} small />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

```

- [ ] **Step 2: Add the `UnitStat` helper component**

Insert this component right after the `StatusBadge` function definition (~line 163, after `StatusBadge`'s closing `}`):

```jsx
// Compact car/remote stat: caption + mono number. null => em-dash; negative => red.
function UnitStat({ label, value, small = false }) {
  const isNull = value === null || value === undefined;
  const display = isNull ? '—' : Number(value).toLocaleString();
  const color = isNull
    ? 'var(--t3)'
    : (Number(value) < 0 ? 'var(--state-error-fg)' : 'var(--t1)');
  return (
    <div style={{ minWidth: 56 }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: small ? 13 : 18, color }}>{display}</div>
      <div style={{ fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
    </div>
  );
}
```

- [ ] **Step 3: Build**

Run:
```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npx turbo build --filter=garage
```
Expected: zero errors. If `StatusBadge`/`Spinner`/`EmptyState`/`panelStyle`/`twoColStyle` are reported undefined, confirm the new sections sit inside the component's `return` and the helper is at module scope — all referenced names already exist in this file.

- [ ] **Step 4: Verify the existing grid is now below the new sections**

Run:
```bash
grep -n "PCBs — Car\|FBU &amp; SKD Units\|🔴 Reorder Flags\|Producible Units by Product" \
  "05_Throttle/apps/garage/src/app/(auth)/dashboard/page.js"
```
Expected: the two new headers (`PCBs — Car`, `FBU &amp; SKD Units`) appear at **lower line numbers** than `🔴 Reorder Flags` and `Producible Units by Product` — i.e. they render first.

- [ ] **Step 5: Commit and push (triggers Garage auto-deploy)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git -C 05_Throttle add apps/garage/src/app/\(auth\)/dashboard/page.js
git -C 05_Throttle commit -m "feat(garage): dashboard PCB + FBU/SKD unit sections above reorder/producible

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git -C 05_Throttle push
```
Expected: push succeeds; GitHub Actions builds + deploys Garage (~3-4 min).

---

## Task 4: Live verification

- [ ] **Step 1: Confirm deploy finished**

Wait ~4 min after the Task 3 push, then hard-refresh `https://garage.legendoftoys.com` (dashboard).

- [ ] **Step 2: Visual check against reference numbers**

Confirm, directly below the metric cards:
- **PCBs** panel (left): one row per product; e.g. `Flare` shows `CAR 707 / REMOTE 990`, `Knox 7800 / 8120`, `Fang 261 / -69` (the -69 in red), `Dash —/950`, `McCloud 0 / —`.
- **FBU & SKD Units** panel (right): `Flare [SKD] 500 / 500`, `Mac [FBU] 1000 / —` (click → `Base · Black 500`, `Base · Red 500`), `Nitro [FBU] -600 / —` (in red), `Rumble 114 / —`.
- The **Reorder Flags** + **Producible Units by Product** grid now sits **below** these two sections, unchanged.
- The rest of the dashboard (Recent Shipments, GRNs, Planned/Ad Hoc Issues, Returns, Activity) is unchanged.

- [ ] **Step 3: Confirm collapsible behavior**

Click a multi-variant FBU/SKD row (e.g. `Mac`): it expands to show the per-colour breakdown; click again to collapse. Single-variant rows (e.g. `Rift`) are not clickable (no chevron).

---

## Self-review notes (for the executor)

- The endpoint is **additive** — it does not touch any existing `case`. If `node --check` fails after insertion, the most likely cause is a misplaced brace from the surrounding switch; re-locate the insertion point between `getFbuStock` and `getProductReceiveFormats`.
- Flare intentionally appears in **both** sections (it has CKD PCB parts *and* SKD bundles) — not a bug.
- All numerics are `Number()`-wrapped (PostgREST string-numerics). `closing_stock` can be negative — the UI shows negatives in red, which is intended.
- No permission gate (matches Reorder Flags / Producible). No migration. No changes to how stock is recorded.
