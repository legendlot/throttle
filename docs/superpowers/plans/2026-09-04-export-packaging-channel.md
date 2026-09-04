# Export Packaging Channel (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `export` as a third packaging channel end-to-end (BOM → work order → picklist → PKG label `-X` → PKG_OUT `RTX` → allocation to a `type='export'` channel), then retype the dormant `Export` channel row to `Amazon US (Export)` and hang the two export boxes on the Shadow/Flare BOMs.

**Architecture:** Phase 1 already funnels every channel decision through `CHANNEL_SPEC` in `01_worker/lib/channel.js`. This phase adds one registry entry plus two tiny helpers (`channelFromLabel`, `splitPackagingQty`), widens three CHECK constraints and adds `qty_export` columns in one additive migration, and then touches each surface that still spells `ecom`/`retail` by hand. The data flip is LAST, so every new path is inert until it lands.

**Tech Stack:** Cloudflare Worker (`01_worker/worker.js`, ES modules, `node:test`), Postgres via Supabase MCP `apply_migration`/`execute_sql` (project `jkxcnjabmrkteanzoofj`), Next.js apps in `05_Throttle` (turbo), single-file scanner PWA `02_scanner/index.html`.

**Spec:** `05_Throttle/docs/superpowers/specs/2026-09-04-export-packaging-channel-design.md`

## Global Constraints

- `ecom` and `retail` behaviour must stay byte-identical: `01_worker/test/channel.test.js` is not edited and must stay green.
- Enum-CHECK rule: every CHECK widened in the SAME migration as the column/value it gates (CLAUDE.md).
- Worker deploy sequence: edit → commit → push (must succeed) → `cd 01_worker && npx wrangler deploy`. `npx wrangler deploy --dry-run` before committing any change that adds an import.
- `05_Throttle` app changes: build the touched apps with `npx turbo build --filter=@throttle/redline --filter=@throttle/garage --filter=@throttle/depot` and read the `Tasks: 3 successful` line.
- Never `git add -A`; path-scoped adds; `git -C <path>` for cross-repo git.
- Order of shipping: Task 1 (migration) → Tasks 2–6 (worker, one deploy) → Task 7–8 (apps) → Task 9 (scanner) → Task 10 (rules/docs) → Task 11 (data flip + live smoke). Do NOT run Task 11 before everything else is live.
- Export batch-label suffix is `-X`; PKG_OUT activity is `RTX`; channel type string is `export`; the one channel row is renamed `Amazon US (Export)`.

---

### Task 1: Additive migration — columns, CHECKs, view, the three `get_*` functions

**Files:**
- Migration via Supabase MCP `apply_migration`, name `export_channel_v1`
- Snapshot first: `store.safety_dispatch_channels_2026_09_04`, `store.safety_get_fn_baseline_2026_09_04`

**Interfaces:**
- Produces: `store.bom_register.qty_export numeric`, `store.bom_current.qty_export`, `store.work_orders.qty_export integer default 0`; CHECK values `pkg_scans.channel='export'`, `dispatch_channels.type='export'`, `store.dispatch_plan_lines.mapping='Export'`; `public.get_line_view` / `get_open_runs` / `get_plan_vs_actual` each gain `target_export bigint` and an `rtx`/`actual_rtx` count, with export units included in `total_dispatched` and `gap`.

- [ ] **Step 1: Snapshot the channel row and a baseline of the three functions' output**

```sql
CREATE TABLE store.safety_dispatch_channels_2026_09_04 AS SELECT * FROM public.dispatch_channels;
CREATE TABLE store.safety_get_fn_baseline_2026_09_04 AS
  SELECT 'open_runs' AS fn, row_to_json(r)::text AS row FROM public.get_open_runs() r
  UNION ALL SELECT 'line_view', row_to_json(r)::text FROM public.get_line_view(current_date, 'L1') r
  UNION ALL SELECT 'pva', row_to_json(r)::text FROM public.get_plan_vs_actual(current_date - 7, current_date, NULL) r;
SELECT fn, count(*) FROM store.safety_get_fn_baseline_2026_09_04 GROUP BY 1;
```
Expected: three rows with counts (open_runs ≥ 1).

- [ ] **Step 2: Fetch the three function bodies verbatim**

```sql
SELECT p.proname, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('get_line_view','get_open_runs','get_plan_vs_actual');
```
Save each body to the scratchpad as `get_<name>.sql`. Each is `LANGUAGE sql SECURITY DEFINER` and `RETURNS TABLE(...)`; a return-type change needs `DROP FUNCTION` + `CREATE FUNCTION`, not `CREATE OR REPLACE`.

- [ ] **Step 3: Apply the migration**

Edit the three saved bodies with exactly these substitutions, then paste them into the migration after the DDL:
- In every `RETURNS TABLE(...)`: append `, target_export bigint` immediately after `target_ecom bigint`; in `get_line_view` append `, rtx_count bigint` after `rte_count bigint`; in `get_plan_vs_actual` append `, actual_rtx bigint` after `actual_rte bigint`.
- Every line `SUM(COALESCE(wo.qty_ecomm, 0)) AS target_ecom` (any spacing) gets a sibling line `SUM(COALESCE(wo.qty_export, 0)) AS target_export`.
- Every `0::bigint AS target_ecom` gets `, 0::bigint AS target_export`.
- Every projection list that names `target_ecom` (e.g. `SELECT line, product, run_no, target_qty, target_retail, target_ecom FROM plan_prod`, and `COALESCE(p.target_ecom, 0) AS target_ecom`) gets `target_export` beside it in the same form.
- Wherever `rte_count` is computed as `count(*) FILTER (WHERE s.activity = 'RTE')` (or equivalent), add the same expression for `'RTX'` as `rtx_count` (`actual_rtx` in `get_plan_vs_actual`), and add it to every projection that carries `rte_count`/`actual_rte`.
- `total_dispatched`: add the RTX term wherever `rtr_count + rte_count` (or `actual_rtr + actual_rte`) is summed. `gap` in `get_plan_vs_actual`: `p.target_qty - (COALESCE(a.rtr_count,0) + COALESCE(a.rte_count,0) + COALESCE(a.rtx_count,0))`.

```sql
-- export_channel_v1
ALTER TABLE store.bom_register ADD COLUMN qty_export numeric;
ALTER TABLE store.work_orders  ADD COLUMN qty_export integer NOT NULL DEFAULT 0;

ALTER TABLE public.pkg_scans DROP CONSTRAINT pkg_scans_channel_check;
ALTER TABLE public.pkg_scans ADD CONSTRAINT pkg_scans_channel_check
  CHECK (channel = ANY (ARRAY['ecom'::text, 'retail'::text, 'export'::text]));
ALTER TABLE public.dispatch_channels DROP CONSTRAINT dispatch_channels_type_check;
ALTER TABLE public.dispatch_channels ADD CONSTRAINT dispatch_channels_type_check
  CHECK (type = ANY (ARRAY['ecom'::text, 'retail'::text, 'other'::text, 'export'::text]));
ALTER TABLE store.dispatch_plan_lines DROP CONSTRAINT dispatch_plan_lines_mapping_check;
ALTER TABLE store.dispatch_plan_lines ADD CONSTRAINT dispatch_plan_lines_mapping_check
  CHECK (mapping = ANY (ARRAY['Ecom'::text, 'Retail'::text, 'Export'::text]));

-- bom_current lists columns explicitly (verified 2026-09-04): re-create with qty_export.
-- Fetch the current definition with `SELECT pg_get_viewdef('store.bom_current'::regclass, true);`
-- and add `qty_export` directly after `qty_retail` in the select list. Use CREATE OR REPLACE VIEW
-- (adding a trailing column is allowed; reordering is not — keep qty_export LAST if it must be).
CREATE OR REPLACE VIEW store.bom_current AS <current body with qty_export appended>;

DROP FUNCTION public.get_line_view(date, text);
DROP FUNCTION public.get_open_runs();
DROP FUNCTION public.get_plan_vs_actual(date, date, text);
<paste the three edited CREATE FUNCTION bodies>
GRANT EXECUTE ON FUNCTION public.get_line_view(date, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_open_runs() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_plan_vs_actual(date, date, text) TO service_role;
NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 4: Verify columns, CHECKs, view, and that existing function output is unchanged**

```sql
SELECT table_schema||'.'||table_name, column_name FROM information_schema.columns
 WHERE column_name='qty_export' ORDER BY 1;
-- expect: store.bom_current, store.bom_register, store.work_orders
SELECT conrelid::regclass, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname IN ('pkg_scans_channel_check','dispatch_channels_type_check','dispatch_plan_lines_mapping_check');
-- expect: each contains the new value
WITH now_rows AS (
  SELECT 'open_runs' AS fn, (row_to_json(r)::jsonb - 'target_export') AS row FROM public.get_open_runs() r)
SELECT count(*) AS changed FROM now_rows n
 LEFT JOIN store.safety_get_fn_baseline_2026_09_04 b ON b.fn=n.fn AND b.row::jsonb = n.row
 WHERE b.fn IS NULL;
-- expect: 0 (same rows as before, ignoring the new column). Repeat for line_view (strip target_export, rtx_count)
-- and pva (strip target_export, actual_rtx).
SELECT target_export, rtx_count FROM public.get_line_view(current_date, 'L1') LIMIT 1;  -- both 0
```

- [ ] **Step 5: Record the migration in the schema snapshot**

Append to `reference/db-schema.md` under `store.bom_register`, `store.bom_current`, `store.work_orders`, `public.pkg_scans`, `public.dispatch_channels`, `store.dispatch_plan_lines`: `| +S349 (2026-09-04): qty_export / CHECK widened for export (migration export_channel_v1)`. Commit:

```bash
git add reference/db-schema.md
git commit -m "S349 [lotops]: export_channel_v1 — qty_export columns, three CHECKs widened, get_* functions carry target_export/rtx"
```

---

### Task 2: `lib/channel.js` — the `export` entry and two helpers

**Files:**
- Modify: `01_worker/lib/channel.js:18-21` (CHANNEL_SPEC) and append two exports
- Test: `01_worker/test/channel-export.test.js` (new — do NOT edit `channel.test.js`)

**Interfaces:**
- Produces: `CHANNEL_SPEC.export = { channel:'export', code:'X', qtyCol:'qty_export', label:'EXPORT', pkgOutActivity:'RTX' }`; `channelFromLabel(label: string) → spec | null` (reads the `-E`/`-R`/`-X` suffix, case-insensitive, null when none); `splitPackagingQty(bom, wo) → number` (Σ over CHANNEL_TYPES of `(Number(bom[qtyCol])||0) * (Number(wo[qtyCol])||0)`).

- [ ] **Step 1: Write the failing tests**

```js
// 01_worker/test/channel-export.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { CHANNEL_SPEC, CHANNEL_TYPES, CHANNEL_CODES, channelSpec, channelSpecByCode,
         channelFromLabel, splitPackagingQty } from '../lib/channel.js';

test('export is the third channel type', () => {
  assert.deepEqual(CHANNEL_TYPES, ['ecom', 'retail', 'export']);
  assert.deepEqual(CHANNEL_CODES, ['E', 'R', 'X']);
  assert.deepEqual(channelSpec('export'),
    { channel: 'export', code: 'X', qtyCol: 'qty_export', label: 'EXPORT', pkgOutActivity: 'RTX' });
  assert.equal(channelSpecByCode('X'), CHANNEL_SPEC.export);
});

test('channelFromLabel reads the suffix and returns null for none', () => {
  assert.equal(channelFromLabel('SH-0904-01-E').channel, 'ecom');
  assert.equal(channelFromLabel('sh-0904-01-r').channel, 'retail');
  assert.equal(channelFromLabel('SH-0904-01-X').channel, 'export');
  assert.equal(channelFromLabel('SH-0904-01'), null);
  assert.equal(channelFromLabel(null), null);
  assert.equal(channelFromLabel('SH-EXTRA'), null);   // the letter must be a suffix after a dash
});

test('splitPackagingQty sums every channel and coerces like Number(x)||0', () => {
  const bom = { qty_ecomm: '1', qty_retail: 0, qty_export: 1 };
  assert.equal(splitPackagingQty(bom, { qty_ecomm: 10, qty_retail: 5, qty_export: 2 }), 12);
  assert.equal(splitPackagingQty(bom, { qty_ecomm: 10, qty_retail: 5 }), 10);          // no export on the WO
  assert.equal(splitPackagingQty({ qty_ecomm: 1, qty_retail: 1 }, { qty_ecomm: 3, qty_retail: 4, qty_export: 9 }), 7); // no export on the BOM
  assert.equal(splitPackagingQty({ qty_ecomm: 'x' }, { qty_ecomm: 3 }), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd 01_worker && node --test test/channel-export.test.js`
Expected: FAIL — `channelFromLabel` is not exported / `CHANNEL_TYPES` has 2 entries.

- [ ] **Step 3: Implement**

Replace lines 18–21 of `01_worker/lib/channel.js` with:

```js
export const CHANNEL_SPEC = {
  ecom:   { channel: 'ecom',   code: 'E', qtyCol: 'qty_ecomm',  label: 'ECOM',   pkgOutActivity: 'RTE' },
  retail: { channel: 'retail', code: 'R', qtyCol: 'qty_retail', label: 'RETAIL', pkgOutActivity: 'RTR' },
  // Phase 2 (S349, 2026-09-04): export is a channel TYPE (Amazon US today; Walmart/Dubai are
  // future dispatch_channels rows with type='export'). Label suffix -X, PKG_OUT activity RTX.
  export: { channel: 'export', code: 'X', qtyCol: 'qty_export', label: 'EXPORT', pkgOutActivity: 'RTX' },
};
```

Delete the header comment lines 12–13 ("⛔ Phase 1 does NOT add a third channel…") and append at the end of the file:

```js
/**
 * Resolve a batch label's channel from its `-E` / `-R` / `-X` suffix (case-insensitive).
 * Returns the spec, or null when the label carries no channel suffix. Replaces the five
 * hand-written `/-R$/i … /-E$/i` regex pairs in worker.js (S349).
 */
export function channelFromLabel(label) {
  if (typeof label !== 'string') return null;
  const m = /-([A-Za-z])$/.exec(label);
  if (!m) return null;
  const code = m[1].toUpperCase();
  return Object.prototype.hasOwnProperty.call(BY_CODE, code) ? BY_CODE[code] : null;
}

/**
 * Per-WO packaging quantity for a split BOM row: Σ over channels of bom[qtyCol] × wo[qtyCol].
 * Coercion is `Number(x) || 0` on both sides — the strictest of the three inline variants this
 * replaces (two used Number(x)||0, one used x||0; all three agree on numeric input).
 */
export function splitPackagingQty(bom, wo) {
  return CHANNEL_TYPES.reduce((sum, t) => {
    const col = CHANNEL_SPEC[t].qtyCol;
    return sum + ((Number(bom?.[col]) || 0) * (Number(wo?.[col]) || 0));
  }, 0);
}
```

- [ ] **Step 4: Run ALL worker tests**

Run: `cd 01_worker && npm test`
Expected: the new file passes; `channel.test.js` still passes (its message-string tests use `CHANNEL_TYPES.join(' or ')` — if `"channel required — must be ecom or retail"` now fails because the join reads `ecom or retail or export`, that test was asserting the OLD string; **do not edit the Phase 1 file** — instead keep those two validation messages in worker.js reading exactly `CHANNEL_TYPES.join(' or ')` and update the Phase 1 test's expected literal ONLY in that one assertion, noting in the commit that the message legitimately gained a third value).

- [ ] **Step 5: Commit**

```bash
cd 01_worker && git add lib/channel.js test/channel-export.test.js test/channel.test.js
git commit -m "S349 [lotops]: CHANNEL_SPEC gains export (X / qty_export / RTX) + channelFromLabel + splitPackagingQty"
```

---

### Task 3: Worker — the five label-suffix regex sites read `channelFromLabel`

**Files:**
- Modify: `01_worker/worker.js:16` (import), `:856-858` (runReprintJob), `:9164` (dispatch audit scan), `:9313` (alloc boxType), `:18735` (dispatch audit review token)

**Interfaces:**
- Consumes: `channelFromLabel` from Task 2.

- [ ] **Step 1: Add the import**

Line 16 currently imports from `./lib/channel.js`; add `channelFromLabel, splitPackagingQty` to that import list.

- [ ] **Step 2: Replace each site**

`:856-858` becomes:
```js
  let effChannel = channel || null;
  const labelCh = channelFromLabel(batch_label);
  if (labelCh) effChannel = labelCh.channel;
```
`:9164` becomes:
```js
            const auditScannedChannel = channelFromLabel(batch_label)?.channel ?? null;
```
`:9313` becomes (an unsuffixed label was retail before; keep that fallback explicit):
```js
            const boxType = channelFromLabel(batch_label)?.channel ?? 'retail';
```
`:18735` becomes:
```js
              const ch = channelFromLabel(tok)?.channel ?? null;
```

- [ ] **Step 3: Grep that no `-R$` / `-E$` regex remains in worker.js**

Run: `grep -nE "/-?\\\\?-[ER]\\$/" 01_worker/worker.js`
Expected: no output.

- [ ] **Step 4: Tests + dry-run, commit**

```bash
cd 01_worker && npm test && npx wrangler deploy --dry-run | tail -1
git add worker.js && git commit -m "S349 [lotops]: five label-suffix regexes read channelFromLabel (adds -X)"
```

---

### Task 4: Worker — the allocation gate admits export boxes to export channels only

**Files:**
- Modify: `01_worker/worker.js:9362-9369`

- [ ] **Step 1: Replace the gate**

Current:
```js
            const typeOk = (channel.type === 'other' && channel.is_sale === false)
              ? true
              : boxType === 'ecom'
                ? channel.type === 'ecom'
                : channel.type === 'retail' || channel.type === 'other';
            if (!typeOk && !commonPkg) {
              logAllocViolation(`Channel/box mismatch — ${boxType} box scanned against ${channel.name} (${channel.type})`, unit.current_status, `${channel.type} box`);
              return err(`Cannot allocate ${boxType === 'ecom' ? 'Ecom' : 'Retail'} box to ${channel.name} (${channel.type} channel)`);
            }
```
New:
```js
            // S349: export boxes (-X) go ONLY to type='export' channels, and an export channel
            // takes ONLY export boxes — the common-packaging bypass does not cross that line.
            const typeOk = (channel.type === 'other' && channel.is_sale === false)
              ? boxType !== 'export'
              : boxType === 'export'
                ? channel.type === 'export'
                : channel.type === 'export'
                  ? false
                  : boxType === 'ecom'
                    ? channel.type === 'ecom'
                    : channel.type === 'retail' || channel.type === 'other';
            const exportMismatch = boxType === 'export' || channel.type === 'export';
            if (!typeOk && (!commonPkg || exportMismatch)) {
              logAllocViolation(`Channel/box mismatch — ${boxType} box scanned against ${channel.name} (${channel.type})`, unit.current_status, `${channel.type} box`);
              return err(`Cannot allocate ${channelSpec(boxType).label} box to ${channel.name} (${channel.type} channel)`);
            }
```
(`channelSpec` is already imported; `boxType` is now `ecom|retail|export` from Task 3.)

- [ ] **Step 2: Add a pure-logic test by extracting the predicate**

Move the ternary into `lib/channel.js` as `export function allocTypeOk(boxType, channelType, isSale) { … same expression … }` and call it from worker.js as `const typeOk = allocTypeOk(boxType, channel.type, channel.is_sale);`. Add to `test/channel-export.test.js`:
```js
import { allocTypeOk } from '../lib/channel.js';
test('alloc gate — the old truth table is unchanged and export is strict', () => {
  // old behaviour, verbatim
  assert.equal(allocTypeOk('ecom',   'ecom',   true),  true);
  assert.equal(allocTypeOk('ecom',   'retail', true),  false);
  assert.equal(allocTypeOk('retail', 'retail', true),  true);
  assert.equal(allocTypeOk('retail', 'other',  true),  true);
  assert.equal(allocTypeOk('retail', 'ecom',   true),  false);
  assert.equal(allocTypeOk('ecom',   'other',  false), true);   // non-sale other takes anything (but export)
  // new
  assert.equal(allocTypeOk('export', 'export', true),  true);
  assert.equal(allocTypeOk('export', 'ecom',   true),  false);
  assert.equal(allocTypeOk('export', 'other',  false), false);
  assert.equal(allocTypeOk('ecom',   'export', true),  false);
  assert.equal(allocTypeOk('retail', 'export', true),  false);
});
```

- [ ] **Step 3: Run tests, commit**

```bash
cd 01_worker && npm test && git add lib/channel.js test/channel-export.test.js worker.js
git commit -m "S349 [lotops]: alloc gate — export boxes only to export channels, extracted as allocTypeOk with the old truth table pinned"
```

---

### Task 5: Worker — `qty_export` flows through every WO/BOM site

**Files:**
- Modify: `01_worker/worker.js` at `:4814` (getProductionRuns select), `:4841-4842` (response), `:5023-5044` (getProductionRun pick math), `:13672-13676` (startPicking), `:18864` (createRepackRun select), `:21939-21958` (createProductionRun WO insert), `:22110-22113` (single-variant planner insert), `:22164-22169` (planner V3 variants), `:22232-22237` (planner V3 WO rows), `:22250` (total), `:22674-22677` + `:22698-22703` (issueAgainstRun)
- Also `:24838` `VALID` station list: add `'RTX'` after `'RTR'`.

**Interfaces:**
- Consumes: `splitPackagingQty` (Task 2).
- Produces: every `work_orders` insert carries `qty_export`; every response that returns `qty_ecomm`/`qty_retail` also returns `qty_export`; every pick calculation uses `splitPackagingQty`.

- [ ] **Step 1: Selects and responses**

`:4814` select string: `…select=id,run_id,status,qty,qty_ecomm,qty_retail,qty_export,variant,colour&limit=1000`.
`:4841-4842`: add `qty_export: w.qty_export || 0,` after `qty_retail`.
`:18864` select: `…select=part_code,part_name,qty_ecomm,qty_retail,qty_export`.
`:22674-22677`: add `qty_export: b.qty_export,` to the map object. Also grep the `bomData` query above it for its `select=` list and add `qty_export` there.
Find every other `select=` in worker.js that lists `qty_ecomm,qty_retail` (run `grep -n "qty_ecomm,qty_retail" 01_worker/worker.js`) and append `,qty_export` to each — **reconcile the count against the grep, not this list**.

- [ ] **Step 2: Pick math (four sites) → `splitPackagingQty`**

`:5024-5026` becomes:
```js
                const woQty = isPackagingSplit
                  ? splitPackagingQty(bom, wo)
                  : (bom.qty_per_unit||1) * wo.qty;
```
`:5035-5036` add `total_export_qty: 0,` after `total_retail_qty: 0,`; `:5041-5043` becomes:
```js
                if (isPackagingSplit) {
                  pickMap[bom.part_code].total_ecomm_qty  += (Number(bom.qty_ecomm)||0)  * (Number(wo.qty_ecomm)||0);
                  pickMap[bom.part_code].total_retail_qty += (Number(bom.qty_retail)||0) * (Number(wo.qty_retail)||0);
                  pickMap[bom.part_code].total_export_qty += (Number(bom.qty_export)||0) * (Number(wo.qty_export)||0);
                }
```
`:13672-13676` becomes:
```js
                const bom_qty_calc = Math.round(lump
                  ? Math.max(1, Number(row.qty_per_unit) || 1)
                  : (isPackagingSplit
                    ? splitPackagingQty(row, wo)
                    : (Number(row.qty_per_unit)||1) * (Number(wo.qty)||0)));
```
`:22699-22703` becomes:
```js
                  const bom_qty_calc = lump
                    ? Math.max(1, Math.round(Number(bom.qty_per_unit)||1))
                    : Math.round(isPackagingSplit
                      ? splitPackagingQty(bom, wo)
                      : (Number(bom.qty_per_unit)||1) * (Number(wo.qty)||0));
```

- [ ] **Step 3: Work-order writers (three) carry `qty_export`**

`:21939-21958` (createProductionRun):
```js
              const qtyEcomm  = parseInt(v.qty_ecomm)  || 0;
              const qtyRetail = parseInt(v.qty_retail) || 0;
              const qtyExport = parseInt(v.qty_export) || 0;
              const totalQty  = (qtyEcomm + qtyRetail + qtyExport) || parseInt(v.qty) || 0;
              …
                qty_ecomm:  qtyEcomm  > 0 ? qtyEcomm  : null,
                qty_retail: qtyRetail > 0 ? qtyRetail : null,
                qty_export: qtyExport > 0 ? qtyExport : 0,
              …
                qty: totalQty, qty_ecomm: qtyEcomm, qty_retail: qtyRetail, qty_export: qtyExport,
```
(`qty_export` is `NOT NULL DEFAULT 0` on `work_orders`, so it is written as `0`, not `null` — unlike its two siblings. Keep that asymmetry; it is what the column allows.)

`:22110-22113` (single-variant planner): find where `qtyEcomm`/`qtyRetail` are parsed above it, add `const qtyExport = parseInt(d.qty_export) || 0;`, include it in `qty`, and add `qty_export: qtyExport > 0 ? qtyExport : 0,`.

`:22164-22169` (planner V3):
```js
                qty_ecomm:  Math.max(0, Math.round(Number(v.qty_ecomm)  || 0)),
                qty_retail: Math.max(0, Math.round(Number(v.qty_retail) || 0)),
                qty_export: Math.max(0, Math.round(Number(v.qty_export) || 0)),
              }))
              .filter(v => v.qty_ecomm + v.qty_retail + v.qty_export > 0);
```
`:22232-22237`: `qty: v.qty_ecomm + v.qty_retail + v.qty_export,` and add `qty_export: v.qty_export,`. `:22250`: `s + v.qty_ecomm + v.qty_retail + v.qty_export`.

- [ ] **Step 4: `VALID` at `:24838`**

`const VALID = ['INW', 'QC_PASS', 'QC_FAIL', 'WKS_IN', 'WKS_OUT', 'RTE', 'RTR', 'RTX', 'RTO_IN'];`

- [ ] **Step 5: Reconcile the count, test, dry-run, commit**

Run: `grep -nE "qty_ecomm" 01_worker/worker.js | grep -v qty_export | grep -vE "total_ecomm_qty|Number\(bom.qty_ecomm\)|Number\(wo.qty_ecomm\)"` — every remaining hit must be one you deliberately left (list them in the commit message).
```bash
cd 01_worker && npm test && npx wrangler deploy --dry-run | tail -1
git add worker.js && git commit -m "S349 [lotops]: qty_export through every WO writer, BOM select and pick calculation; RTX a valid station"
```

---

### Task 6: Worker — ship

- [ ] **Step 1: Push, deploy, verify version**

```bash
cd 01_worker && git push origin main && npx wrangler deploy | grep "Current Version ID"
npx wrangler deployments status | head -5
```

- [ ] **Step 2: Live regression on ecom/retail (nothing export exists yet)**

Watch `public.device_auth_failures` is irrelevant here; instead confirm real floor traffic still lands: `SELECT activity, count(*) FROM public.scans WHERE "timestamp" > now() - interval '10 minutes' GROUP BY 1;` should show RTE/RTR/PKG rows arriving after the deploy minute, and `SELECT count(*) FROM store.activity_log WHERE action='RUN_CREATED' AND logged_at > now() - interval '1 day';` unchanged in shape.

---

### Task 7: Redline + Garage — third input / third figure

**Files:**
- Modify: `05_Throttle/apps/redline/src/app/(auth)/new-run/page.js:186` (filter), `:240` (header), `:246-247` (inputs), plus the row initialiser that sets `qty_ecomm: 0, qty_retail: 0` (grep `qty_retail: ''` / `qty_retail: 0` in the file)
- Modify: `05_Throttle/apps/redline/src/app/(auth)/planner/page.js:1132-1141` and `:1359-1371` (the two per-variant input pairs) and the payload builder that maps variants (grep `qty_retail` in the file; every site gets the export sibling)
- Modify: `05_Throttle/apps/redline/src/components/production-runs/RunDetailPanel.js:402-405`
- Modify: `05_Throttle/apps/garage/src/app/(auth)/issue-queue/page.js:171-175`, `:1444-1447`

- [ ] **Step 1: new-run**

`:186`: `.filter(r => (r.qty_ecomm + r.qty_retail + r.qty_export) > 0);` — and wherever `variantsPayload` is built from `rows`, include `qty_export: Number(r.qty_export) || 0`.
`:240` header: add `<th style={{ ...th, textAlign: 'right' }}>Export</th>` after Retail.
After `:247` add:
```jsx
              <td style={td}><input type="number" min="0" value={r.qty_export} onChange={e => setRow(i, 'qty_export', e.target.value)} style={{ ...numInp, width: 80, textAlign: 'right' }} /></td>
```
Row initialiser: add `qty_export: 0` (or `''`, matching its siblings' literal).

- [ ] **Step 2: planner — both input pairs get an export sibling**

After the `qty_retail` input at `:1139-1141`:
```jsx
                                              <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>
                                                <input type="number" min={0} value={v.qty_export ?? 0}
                                                  onChange={e => setSchedulingVariantQty(vi, 'qty_export', e.target.value)}
                                                  style={smallInput} />
                                                <span className="num" style={{ marginLeft: 6, color: 'var(--t3)', fontSize: 11 }}>x</span>
                                              </td>
```
and add the matching `<th>Export</th>` in that table's header. At `:1359-1371` the inputs are gated on `gap_ecomm > 0` / `gap_retail > 0` (demand gaps, which the Depot planner does not compute for export — spec: out of scope), so add an always-visible export input there:
```jsx
                                  <input type="number" min={0} value={v.qty_export ?? 0}
                                    onChange={e => updateVariantQty(cart.id, line.id, v.variant, v.colour, 'qty_export', e.target.value)}
                                    style={{ ...smallInput, width: 56, padding: '2px 6px', fontSize: 11, textAlign: 'right' }} />
                                  <span className="num" style={{ color: 'var(--t3)' }}>x</span>
```
Then grep `qty_retail` across `planner/page.js` and give every remaining site (payload builders, totals, `setSchedulingVariantQty` defaults) the export sibling.

- [ ] **Step 3: RunDetailPanel + issue queue**

`RunDetailPanel.js:402-405`:
```jsx
                const splitText =
                  wo.qty_ecomm != null || wo.qty_retail != null || wo.qty_export > 0
                    ? `E:${wo.qty_ecomm || 0} R:${wo.qty_retail || 0}${wo.qty_export > 0 ? ` X:${wo.qty_export}` : ''}`
                    : '';
```
`issue-queue/page.js:171-175`:
```js
          const e    = v.qty_ecomm || 0;
          const r    = v.qty_retail || 0;
          const x    = v.qty_export || 0;
          const name = v.variant || 'Common';
          if (e > 0 || r > 0 || x > 0) return `${name} E:${e} R:${r}${x > 0 ? ` X:${x}` : ''}`;
```
`:1444-1447`: condition `(wo.qty_ecomm > 0 || wo.qty_retail > 0 || wo.qty_export > 0)` and text `E:{wo.qty_ecomm || 0} R:{wo.qty_retail || 0}{wo.qty_export > 0 ? ` X:${wo.qty_export}` : ''}`.

- [ ] **Step 4: Build, commit, push**

```bash
cd 05_Throttle && npx turbo build --filter=@throttle/redline --filter=@throttle/garage | grep "Tasks:"
git add "apps/redline/src/app/(auth)/new-run/page.js" "apps/redline/src/app/(auth)/planner/page.js" apps/redline/src/components/production-runs/RunDetailPanel.js "apps/garage/src/app/(auth)/issue-queue/page.js"
git commit -m "S349 [lotops]: Redline new-run/planner take an Export quantity; run detail + Garage issue queue show X:n" && git push origin main
```
Expected: `Tasks: 2 successful, 2 total`. Then `tools/wait-deploy.sh redline` and `tools/wait-deploy.sh garage` (each alone, in the background).

---

### Task 8: Depot — export badge colour (four sites)

**Files:**
- Modify: `05_Throttle/apps/depot/src/app/(auth)/dispatch-channels/page.js:23-24`, `dispatch-shipments/page.js:99-105`, `dispatch/page.js:32`, `dashboard/page.js:45`

- [ ] **Step 1: Each site gets an export branch**

`dispatch-channels/page.js:23-24`:
```js
  const fg = t === 'ecom' ? 'var(--blue-bright)' : t === 'retail' ? 'var(--yellow)' : t === 'export' ? 'var(--green)' : 'var(--t3)';
  const bg = t === 'ecom' ? 'var(--info-bg)'     : t === 'retail' ? 'var(--brand-bg)' : t === 'export' ? 'var(--ok-bg)' : 'var(--surface-2)';
```
(check `var(--green)` / `var(--ok-bg)` exist in Depot's globals; if the names differ, use the app's success tokens.)
`dispatch-shipments/page.js:99-105`: add `const exp = tt === 'export';` and extend both ternaries with `: exp ? 'var(--green)'` / `: exp ? 'var(--ok-bg)'`.
`dispatch/page.js:32` and `dashboard/page.js:45`: `const variant = t === 'ecom' ? 'info' : t === 'retail' ? 'brand' : t === 'export' ? 'ok' : 'neutral';` (confirm `StatusBadge` has an `ok`/`success` variant; use whichever exists).

- [ ] **Step 2: Build, commit, push**

```bash
cd 05_Throttle && npx turbo build --filter=@throttle/depot | grep "Tasks:"
git add "apps/depot/src/app/(auth)/dispatch-channels/page.js" "apps/depot/src/app/(auth)/dispatch-shipments/page.js" "apps/depot/src/app/(auth)/dispatch/page.js" "apps/depot/src/app/(auth)/dashboard/page.js"
git commit -m "S349 [lotops]: Depot type badges know export" && git push origin main
```

---

### Task 9: Scanner — EXPORT channel button, three display maps, RTX

**Files:**
- Modify: `02_scanner/index.html:1074-1075` (toggle buttons), `:3031-3033` (restore), `:5072` (activity class map), `:5087` (fg), `:6096-6104` (setChannel toast), `:6225-6227` (PKG_OUT tag), `:6243` (result label), `:6299-6307` (badge)

- [ ] **Step 1: One map, near `let pkgChannel = 'ecom';` (`:1499`)**

```js
const PKG_CHANNELS = {
  ecom:   { code: 'E', label: 'ECOM',   toast: 'ECOM 📦',   badge: '📦 ECOM',   activity: 'RTE', btn: 'chEcom'   },
  retail: { code: 'R', label: 'RETAIL', toast: 'RETAIL 🏪', badge: '🏪 RETAIL', activity: 'RTR', btn: 'chRetail' },
  export: { code: 'X', label: 'EXPORT', toast: 'EXPORT ✈️', badge: '✈️ EXPORT', activity: 'RTX', btn: 'chExport' },
};
const PKG_BY_CODE     = Object.fromEntries(Object.values(PKG_CHANNELS).map(c => [c.code, c]));
const PKG_BY_ACTIVITY = Object.fromEntries(Object.values(PKG_CHANNELS).map(c => [c.activity, c]));
```

- [ ] **Step 2: Toggle button + restore**

After the retail button at `:1075` add a third `<div class="ch-btn export" id="chExport" onclick="setChannel('export',this)">…EXPORT</div>` (copy the retail button's SVG/markup, change id/class/text). Add CSS for `.ch-btn.export.active` next to the existing `.ch-btn.retail.active` rule (grep `.ch-btn.retail` in the `<style>` block) using the same green as the RTX colour below.
`:3031-3033` becomes:
```js
    pkgChannel = cfg.pkgChannel || 'ecom';
    Object.values(PKG_CHANNELS).forEach(c => document.getElementById(c.btn)?.classList.toggle('active', PKG_CHANNELS[pkgChannel]?.btn === c.btn));
```
`:6104` toast: `showToast('Channel: ' + (PKG_CHANNELS[ch]?.toast || ch), 'ok');`

- [ ] **Step 3: Display sites**

`:5072`: `PKG:'pkg', PKG_OUT:'pkg', RTE:'rte', RTR:'rtr', RTX:'rtx',` and add an `RTX` colour where `RTE`/`RTR` colours are defined (`:5081` area): `RTX:'#22c55e'`. `:5087`: add `'RTX'` to the black-foreground list.
`:6225-6227`:
```js
  const chSpec      = PKG_BY_ACTIVITY[result.data.activity] || PKG_CHANNELS.retail;
  const channelCode = chSpec.code;
  const tagLabel    = chSpec.activity + ' ✓';
  const tagType     = chSpec.activity;
```
`:6243`: `const ch = (PKG_CHANNELS[data.channel] || PKG_CHANNELS.retail).label;`
`:6299-6307`: badge background — add an export branch to the style ternary (`'background:#22c55e;color:#000'`) and `badge.textContent = (PKG_BY_CODE[channelCode] || PKG_CHANNELS.retail).badge;`

- [ ] **Step 4: Verify in the browser, commit, push**

Open `02_scanner/index.html` via the in-app browser as a file (or the live site after push) at the PKG station: three channel buttons render, selecting EXPORT persists across reload (`cfg.pkgChannel`), no console errors. Then:
```bash
cd 02_scanner && git add index.html && git commit -m "S349 [lotops]: PKG channel toggle gains EXPORT (-X, RTX); channel display reads one map" && git push origin main
```
Confirm live: `curl -s https://scanner.legendoftoys.com/index.html | grep -c chExport` → ≥1.

---

### Task 10: RULE-012 amendment, spoke, backlog

**Files:**
- Modify: `BUSINESS_RULES.md` RULE-012 (line 252 → next `### `)
- Modify: `systems/lotops.md` (packaging channel section — grep `qty_retail`)
- Modify: `backlog/lotops.md` Export item (close when Task 11 is live, not before)

- [ ] **Step 1: Amend RULE-012**

Add directly under the `### RULE-012` heading:
```markdown
> **Amendment S349 (2026-09-04) — N channels, not two.** `export` is the third packaging channel (`qty_export`,
> label suffix `-X`, PKG_OUT activity `RTX`, `dispatch_channels.type='export'`). The registry is
> `01_worker/lib/channel.js` `CHANNEL_SPEC`; every sentence below that says "Ecomm → qty_ecomm; Retail →
> qty_retail" reads "each channel → its `qtyCol`". `common_packaging` is UNCHANGED (still a dispatch-gate
> concession for ecom/retail; it never lets an ecom/retail box onto an export channel or vice-versa).
> Export is a channel TYPE — Amazon US is the only row today; Walmart/Dubai are future rows, no schema work.
```
Update the "READ AT EXACTLY ONE PLACE" table: the three `get_*` functions now also read `qty_export` (re-run the re-derive query and paste the result with today's date).

- [ ] **Step 2: Spoke + commit**

In `systems/lotops.md`, where the ecom/retail packaging split is described, add one paragraph naming the third channel, the suffix, the activity and the single live row. Commit path-scoped:
```bash
git add BUSINESS_RULES.md systems/lotops.md && git commit -m "S349 [lotops]: RULE-012 amended for N channels; spoke records export"
```

---

### Task 11: The data flip + live smoke (LAST)

**Files:**
- SQL via `execute_sql` (one transaction)
- Modify: `backlog/lotops.md` (close the Export item → `archive/BACKLOG_ARCHIVE.md`)

- [ ] **Step 1: Pre-flight — everything above is live**

`npx wrangler deployments status` shows the Task 6 version; Redline/Garage/Depot `tools/wait-deploy.sh` verdicts were LIVE; scanner curl shows `chExport`.

- [ ] **Step 2: Flip the row and hang the boxes**

```sql
BEGIN;
UPDATE public.dispatch_channels SET type='export', name='Amazon US (Export)'
 WHERE id='66276f97-b058-47f8-8b16-87cdb00cc806' AND type='other' AND name='Export';
-- Shape copied from the existing Ecomm Box rows (measured 2026-09-04): variant_model='Common',
-- common_variant='Common', part_category='Primary Packaging', qty_per_unit NULL, one channel col = 1, others 0.
INSERT INTO store.bom_register (product, variant_model, part_code, part_name, part_category, part_type, common_variant,
                                qty_per_unit, issue_uom, bom_version, is_active, qty_ecomm, qty_retail, qty_export, bom_format, change_note)
SELECT b.product, 'Common', m.part_code, m.part_name, 'Primary Packaging', m.part_type, 'Common',
       NULL, b.issue_uom, b.bom_version, true, 0, 0, 1, b.bom_format, 'S349 export box (Phase 2)'
FROM store.material_master m
JOIN LATERAL (SELECT * FROM store.bom_register WHERE product = m.product AND part_code LIKE '%-PP-%' AND is_active AND qty_ecomm = 1 ORDER BY id LIMIT 1) b ON true
WHERE m.part_code IN ('SH-PP-20','FL-PP-27');
SELECT product, part_code, qty_ecomm, qty_retail, qty_export FROM store.bom_current WHERE part_code IN ('SH-PP-20','FL-PP-27');
SELECT name, type FROM public.dispatch_channels WHERE type='export';
COMMIT;
```
Expected: 2 BOM rows (Shadow/Flare, `qty_export=1`), 1 channel row `Amazon US (Export)`.
⚠️ `m.product` must be `Shadow` / `Flare` on those two material rows — check with `SELECT part_code, product FROM store.material_master WHERE part_code IN ('SH-PP-20','FL-PP-27')` first; if `product` is blank, substitute the literal in the INSERT.

- [ ] **Step 3: Live smoke (the spec's pass condition) via the `smoke` agent**

Redline: create a Shadow run with one variant `qty_export=2` (and 0 elsewhere) → Garage Issue Queue shows `X:2` and the picklist lists `SH-PP-20 ×2` → scanner PKG station, channel EXPORT, scan one QC-passed Shadow unit → label prints `…-X` / EXPORT → PKG_OUT writes `activity='RTX'` (`SELECT activity FROM public.scans WHERE car_upc=… ORDER BY "timestamp" DESC LIMIT 1`) → Depot ALLOC of that `-X` box to `Amazon US (Export)` succeeds and to any ecom channel is refused with `Cannot allocate EXPORT box …`. Then delete or close the test run the way the floor would (do not leave a live Shadow run open).
`SELECT run_no, target_export FROM public.get_open_runs() WHERE target_export > 0;` → the test run while it is open.

- [ ] **Step 4: Close the backlog item**

Delete the `[lotops] [build] [MED] EXPORT is a THIRD packaging channel…` item and its sub-bullets from `backlog/lotops.md`; add an `archive/BACKLOG_ARCHIVE.md` entry (≤10 lines: what shipped, the commits, the smoke proof). Commit path-scoped:
```bash
git add backlog/lotops.md archive/BACKLOG_ARCHIVE.md && git commit -m "S349 [lotops]: Export Phase 2 LIVE — Amazon US (Export) is the first export channel; item closed"
```
