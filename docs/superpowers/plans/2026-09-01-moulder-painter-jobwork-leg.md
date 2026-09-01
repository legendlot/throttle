# Moulder → Painter Job-Work Leg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unpainted tops real stock, send them to the painter on a Direct Issuance challan, and let the painted-top GRN the store already does close the loop — so "at the painter" and "paint loss" become arithmetic rather than paperwork.

**Architecture:** Direct Issuance gains a `jobwork` purpose with a mandatory vendor. The `DSP_ISSUE` scan debits the unpainted code (existing `executeDirectIssuance`, unchanged). The painter's return is the *existing* receiving → GRN path, which credits the painted code; on a `source='jobwork'` GRN only, `damaged_qty` additionally credits back to the **unpainted** code so rework is an ordinary second challan. A view derives the balance. No new returnable object, no new floor habit except inwarding the moulder's delivery.

**Tech Stack:** Cloudflare Workers (lotopsproxy, ES module format, 24,610-line `worker.js`), Supabase/PostgREST, Next.js 14 static export (Garage), `node:test` for unit tests, `@throttle/ui` `Combobox`.

**Spec:** `05_Throttle/docs/superpowers/specs/2026-09-01-moulder-painter-jobwork-leg-design.md` — read it before Task 1. This plan argues from it.

## Global Constraints

- **lotopsproxy has a 3-system blast radius** (Garage + Redline + Scanner + Depot). Sequence is always: edit → commit → **push (must succeed)** → `cd 01_worker && npx wrangler deploy`. Never `npx --prefix`.
- **Never modify `wrangler.toml` without explicit permission from Afshaan.** Task 9 is the only task that needs it and is deliberately off the critical path.
- **PostgREST returns numeric columns as strings.** Wrap every arithmetic read in `Number()`; wrap integer inserts in `Math.round()`.
- **Never loop `await` per row** — batch via `IN` filters, array inserts or RPCs. (The existing per-part loop in `executeDirectIssuance` is a sanctioned exception: DIs carry <10 part lines.)
- **Every new `store` table needs** `GRANT ALL ON store.<table> TO service_role`, RLS enabled at creation, and **`NOTIFY pgrst, 'reload schema';` in the same migration** — a new table in an already-exposed schema is invisible to PostgREST until the cache reloads, and it fails *silently* (PATTERN-207).
- **Snapshot before any bulk mutation:** `CREATE TABLE store.safety_<name>_2026_09_01 AS SELECT …`
- **`damaged_qty` is counted BESIDE `qty_received`, never inside it** (`worker.js:16900`). Never subtract it.
- **Grep the schema first.** `reference/db-schema.md` before writing SQL; live-verify via `information_schema.columns` before DDL.
- **Cutover date is a single constant** used by both the view and any report. It is set in Task 8, not scattered.

---

## File Structure

| File | Responsibility |
|---|---|
| `01_worker/package.json` | **NEW.** `{"type":"module"}` + a `test` script. lotopsproxy has none today. |
| `01_worker/lib/jobwork.js` | **NEW.** The pure, testable core: pair resolution and the GRN ledger split. No I/O. |
| `01_worker/test/jobwork.test.js` | **NEW.** `node:test` unit tests for the above. |
| `01_worker/worker.js` | **MODIFY.** Import the lib; add `jobwork` purpose validation, `vendor_code` requirement, challan + gate-pass raise on approve, and the job-work GRN credit split. |
| `05_Throttle/apps/garage/src/app/(auth)/direct-issuance/new/page.js` | **MODIFY.** Vendor `Combobox` replaces free-text destination. |
| `05_Throttle/apps/garage/src/app/(auth)/direct-issuance/detail/page.js` | **MODIFY.** Show vendor, challan no, and the job-work return summary. |
| `05_Throttle/apps/garage/src/app/(auth)/jobwork/page.js` | **NEW.** The at-painter balance panel. |
| Supabase migrations | `part_finish_pairs_v1`, `direct_issuance_jobwork_v1`, `jobwork_balance_v1`. |

---

## Task 1: Prove lotopsproxy can carry a testable module

**Why this is first:** `worker.js` is 24,610 lines with **zero imports** and there is **no `package.json`** in `01_worker`. This task introduces the first module and the first test into the highest-blast-radius worker in the fleet. If the bundle breaks, it breaks Garage, Redline, Scanner and Depot together. Prove the mechanism with logic that nothing depends on yet, before anything is built on it.

**Files:**
- Create: `01_worker/package.json`
- Create: `01_worker/lib/jobwork.js`
- Create: `01_worker/test/jobwork.test.js`
- Modify: `01_worker/worker.js` (add one import at the top)

**Interfaces:**
- Consumes: nothing.
- Produces: `resolveFinishPair(pairs, paintedPartCode) → { unpainted_part_code, painted_part_code } | null` and `splitJobworkGrnCredits({ source, partCode, qtyReceived, damagedQty, pair }) → [{ part_code, qty }]`.

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "lotopsproxy",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/"
  }
}
```

`"type": "module"` matches what `worker.js` already is — it ends in `export default { async fetch(request, env, ctx) { … } }`, which is module format. This makes the format explicit rather than inferred.

- [ ] **Step 2: Write the failing test**

Create `01_worker/test/jobwork.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveFinishPair, splitJobworkGrnCredits } from '../lib/jobwork.js';

const PAIRS = [
  { unpainted_part_code: 'SH-PB-51', painted_part_code: 'SH-PB-52', is_active: true },
  { unpainted_part_code: 'SH-PB-99', painted_part_code: 'SH-PB-60', is_active: false },
];

test('resolveFinishPair: finds the active pair for a painted code', () => {
  assert.deepEqual(resolveFinishPair(PAIRS, 'SH-PB-52'),
    { unpainted_part_code: 'SH-PB-51', painted_part_code: 'SH-PB-52', is_active: true });
});

test('resolveFinishPair: ignores inactive pairs', () => {
  assert.equal(resolveFinishPair(PAIRS, 'SH-PB-60'), null);
});

// Degrade, never block: a painted code with no configured pair must still GRN normally.
test('resolveFinishPair: unknown code returns null rather than throwing', () => {
  assert.equal(resolveFinishPair(PAIRS, 'XX-PB-01'), null);
  assert.equal(resolveFinishPair([], 'SH-PB-52'), null);
  assert.equal(resolveFinishPair(PAIRS, null), null);
});

test('splitJobworkGrnCredits: a normal purchase credits only the received part', () => {
  assert.deepEqual(
    splitJobworkGrnCredits({ source: null, partCode: 'SH-PB-52', qtyReceived: 950, damagedQty: 30,
      pair: PAIRS[0] }),
    [{ part_code: 'SH-PB-52', qty: 950 }]);
});

// The whole point of the design: on job-work the damaged material is still LOT's own,
// so it must come back to the ledger on the INPUT code, not vanish.
test('splitJobworkGrnCredits: job-work credits damaged back to the UNPAINTED code', () => {
  assert.deepEqual(
    splitJobworkGrnCredits({ source: 'jobwork', partCode: 'SH-PB-52', qtyReceived: 950,
      damagedQty: 30, pair: PAIRS[0] }),
    [{ part_code: 'SH-PB-52', qty: 950 }, { part_code: 'SH-PB-51', qty: 30 }]);
});

// damaged_qty is counted BESIDE qty_received, never inside it (worker.js:16900).
test('splitJobworkGrnCredits: does not subtract damaged from received', () => {
  const out = splitJobworkGrnCredits({ source: 'jobwork', partCode: 'SH-PB-52', qtyReceived: 950,
    damagedQty: 30, pair: PAIRS[0] });
  assert.equal(out.find(r => r.part_code === 'SH-PB-52').qty, 950);
});

// GRN-092 shape: qty_received=0 with damaged_qty=30 is a real, valid row.
test('splitJobworkGrnCredits: zero received with damage still credits the input code', () => {
  assert.deepEqual(
    splitJobworkGrnCredits({ source: 'jobwork', partCode: 'SH-PB-52', qtyReceived: 0,
      damagedQty: 30, pair: PAIRS[0] }),
    [{ part_code: 'SH-PB-51', qty: 30 }]);
});

test('splitJobworkGrnCredits: job-work with no pair credits only the received part', () => {
  assert.deepEqual(
    splitJobworkGrnCredits({ source: 'jobwork', partCode: 'SH-PB-52', qtyReceived: 950,
      damagedQty: 30, pair: null }),
    [{ part_code: 'SH-PB-52', qty: 950 }]);
});

// PostgREST hands numerics back as strings.
test('splitJobworkGrnCredits: coerces string quantities', () => {
  assert.deepEqual(
    splitJobworkGrnCredits({ source: 'jobwork', partCode: 'SH-PB-52', qtyReceived: '950',
      damagedQty: '30', pair: PAIRS[0] }),
    [{ part_code: 'SH-PB-52', qty: 950 }, { part_code: 'SH-PB-51', qty: 30 }]);
});

test('splitJobworkGrnCredits: zero-qty rows are omitted entirely', () => {
  assert.deepEqual(
    splitJobworkGrnCredits({ source: 'jobwork', partCode: 'SH-PB-52', qtyReceived: 0,
      damagedQty: 0, pair: PAIRS[0] }), []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd 01_worker && node --test test/`
Expected: FAIL — `Cannot find module '.../lib/jobwork.js'`

- [ ] **Step 4: Write the minimal implementation**

Create `01_worker/lib/jobwork.js`:

```js
// Pure job-work helpers for the moulder→painter leg. NO I/O — everything here is
// synchronous and unit-tested, so the parts of this feature that are easy to get
// silently wrong are the parts that are actually covered.
// Spec: docs/superpowers/specs/2026-09-01-moulder-painter-jobwork-leg-design.md

/** Find the ACTIVE unpainted→painted pair for a painted part code. Null when unknown. */
export function resolveFinishPair(pairs, paintedPartCode) {
  if (!paintedPartCode || !Array.isArray(pairs)) return null;
  return pairs.find(p => p && p.is_active && p.painted_part_code === paintedPartCode) || null;
}

/**
 * Ledger credits for one GRN line.
 *
 * Normal purchase  → credit the received part only. Damaged goods are a supplier claim.
 * Job-work return  → ALSO credit `damaged_qty` back to the UNPAINTED code: on job-work the
 *                    material is still LOT's own, so a badly-painted top returns to the input
 *                    state and rework becomes an ordinary second challan.
 *
 * ⚠️ `damagedQty` is counted BESIDE `qtyReceived`, never inside it (worker.js:16900 — rows
 * exist with qty_received=0 alongside damaged_qty=30). Never subtract one from the other.
 */
export function splitJobworkGrnCredits({ source, partCode, qtyReceived, damagedQty, pair }) {
  const out = [];
  const recv = Math.round(Number(qtyReceived) || 0);
  const dmg  = Math.round(Number(damagedQty)  || 0);
  if (recv > 0) out.push({ part_code: partCode, qty: recv });
  if (source === 'jobwork' && dmg > 0 && pair && pair.unpainted_part_code) {
    out.push({ part_code: pair.unpainted_part_code, qty: dmg });
  }
  return out;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd 01_worker && node --test test/`
Expected: PASS — `# pass 9`, `# fail 0`

- [ ] **Step 6: Wire the import into worker.js and prove the bundle still builds**

Add as the first line of `01_worker/worker.js`, above everything else:

```js
import { resolveFinishPair, splitJobworkGrnCredits } from './lib/jobwork.js';
```

Nothing calls these yet — that is deliberate. This step proves the module resolves and bundles.

- [ ] **Step 7: Verify the worker still builds**

Run: `cd 01_worker && npx wrangler deploy --dry-run`
Expected: a successful bundle with no resolution errors.

⛔ **If this fails, STOP and report.** Do not proceed and do not deploy — a broken lotopsproxy bundle takes down four apps. This is exactly what this task exists to find out cheaply.

- [ ] **Step 8: Commit**

```bash
git add 01_worker/package.json 01_worker/lib/jobwork.js 01_worker/test/jobwork.test.js 01_worker/worker.js
git commit -m "S328 [lotops]: first testable module in lotopsproxy — job-work pure helpers

worker.js is 24,610 lines with zero imports and no package.json. This adds
the first module and the first test, deliberately with logic nothing depends
on yet, so the bundle mechanism is proven before the feature is built on it."
```

---

## Task 2: Migrations — pairs, DI columns, returns table

**Files:**
- Supabase migration `part_finish_pairs_v1`
- Supabase migration `direct_issuance_jobwork_v1`

**Interfaces:**
- Consumes: nothing.
- Produces: `store.part_finish_pairs`, `store.direct_issuances.vendor_code` / `.challan_no`, `store.direct_issuance_returns`.

- [ ] **Step 1: Verify the current shape before DDL**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema='store' AND table_name='direct_issuances' ORDER BY ordinal_position;
```

Expected: `vendor_code` and `challan_no` are ABSENT; `expected_return_at`, `returned_at`, `return_note`, `return_grn_ref`, `destination_contact` are PRESENT.

- [ ] **Step 2: Apply `part_finish_pairs_v1`**

```sql
CREATE TABLE store.part_finish_pairs (
  id                  bigserial PRIMARY KEY,
  unpainted_part_code text NOT NULL,
  painted_part_code   text NOT NULL,
  process             text NOT NULL DEFAULT 'paint',
  is_active           bool NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (unpainted_part_code, painted_part_code)
);
ALTER TABLE store.part_finish_pairs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON store.part_finish_pairs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE store.part_finish_pairs_id_seq TO service_role;
CREATE INDEX part_finish_pairs_painted_idx ON store.part_finish_pairs (painted_part_code)
  WHERE is_active;

-- Only Shadow. The Flare targets are an OPEN QUESTION for Piyush (spec §10 Q1) and
-- MUST NOT be guessed from part names — that is the failure mode the S83 screw cohort records.
INSERT INTO store.part_finish_pairs (unpainted_part_code, painted_part_code, notes)
VALUES ('SH-PB-51','SH-PB-52','Shadow Asphalt top. Seeded S328.');

NOTIFY pgrst, 'reload schema';
```

- [ ] **Step 3: Apply `direct_issuance_jobwork_v1`**

```sql
ALTER TABLE store.direct_issuances
  ADD COLUMN vendor_code text,
  ADD COLUMN challan_no  text;

CREATE TABLE store.direct_issuance_returns (
  id           bigserial PRIMARY KEY,
  issuance_id  bigint NOT NULL,
  part_code    text   NOT NULL,
  qty          integer NOT NULL DEFAULT 0,
  scrap_qty    integer NOT NULL DEFAULT 0,
  grn_no       text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  note         text
);
ALTER TABLE store.direct_issuance_returns ENABLE ROW LEVEL SECURITY;
GRANT ALL ON store.direct_issuance_returns TO service_role;
GRANT USAGE, SELECT ON SEQUENCE store.direct_issuance_returns_id_seq TO service_role;
CREATE INDEX direct_issuance_returns_issuance_idx ON store.direct_issuance_returns (issuance_id);

NOTIFY pgrst, 'reload schema';
```

⚠️ **No CHECK constraint on `purpose`.** It is free text today and `gpPurposeValid`'s precedent validates server-side. Adding a CHECK now would reject the 8 existing `office_request` rows only if they disagree — they do not — but it also makes every future purpose a migration. Validate in the worker (Task 4).

- [ ] **Step 4: Verify both tables are visible to PostgREST**

```sql
SELECT count(*) FROM store.part_finish_pairs;
SELECT count(*) FROM store.direct_issuance_returns;
```

Then confirm through the REST layer, because that is what actually failed silently in S239:

Run: `curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$SUPABASE_URL/rest/v1/part_finish_pairs?select=painted_part_code" -H "Accept-Profile: store"`
Expected: a JSON array (one row), **not** `PGRST205 relation does not exist`.

- [ ] **Step 5: Commit**

```bash
git add reference/db-schema.md
git commit -m "S328 [lotops]: migrations for the job-work leg — part_finish_pairs, DI vendor/challan, returns"
```

(Regenerate the schema snapshot with `/schema-sync` if it drifts; otherwise hand-add the three entries.)

---

## Task 3: Create the Office vendor and migrate the 8 existing DIs

**Files:** data only.

**Interfaces:**
- Consumes: `store.direct_issuances.vendor_code` (Task 2).
- Produces: vendor `IN-VND-135`; all existing DIs carry a `vendor_code`.

- [ ] **Step 1: Snapshot first**

```sql
CREATE TABLE store.safety_direct_issuances_2026_09_01 AS
SELECT * FROM store.direct_issuances;
```

- [ ] **Step 2: Verify the next vendor code before minting**

```sql
SELECT vendor_code FROM store.vendors
WHERE vendor_code LIKE 'IN-VND-%' ORDER BY vendor_code DESC LIMIT 1;
```

Expected: `IN-VND-134`. If it is anything else, use `max+1` — do not hardcode 135.

- [ ] **Step 3: Create the Office vendor**

```sql
INSERT INTO store.vendors
  (vendor_code, vendor_name, category, source_country, country_iso, active, created_by, notes)
VALUES
  ('IN-VND-135','LOT Office','Internal','India','IN', true, 'S328',
   'Internal destination for office-request Direct Issuances, not a real supplier. '
   || 'category=Internal is the hook for filtering it out of procurement vendor pickers.');
```

- [ ] **Step 4: Migrate the 8 existing DIs — person moves to `destination_contact`**

```sql
UPDATE store.direct_issuances
SET vendor_code        = 'IN-VND-135',
    destination_contact = COALESCE(NULLIF(destination_contact,''), destination)
WHERE vendor_code IS NULL;
```

⚠️ **`destination` is deliberately NOT cleared.** Keeping it costs nothing and preserves the original text if the `destination_contact` copy is ever questioned.

- [ ] **Step 5: Verify no DI is left without a vendor and no contact was lost**

```sql
SELECT count(*) FILTER (WHERE vendor_code IS NULL)      AS no_vendor,
       count(*) FILTER (WHERE destination_contact IS NULL
                          AND destination IS NOT NULL)  AS lost_contact,
       count(*)                                         AS total
FROM store.direct_issuances;
```

Expected: `no_vendor = 0`, `lost_contact = 0`, `total = 8`.

- [ ] **Step 6: Commit** (documentation only — this task is data)

```bash
git commit --allow-empty -m "S328 [lotops]: Office vendor IN-VND-135 created; 8 existing DIs migrated to it

Snapshot store.safety_direct_issuances_2026_09_01. destination preserved
alongside the destination_contact copy."
```

---

## Task 4: Worker — the `jobwork` purpose and a required vendor

**Files:**
- Modify: `01_worker/worker.js` — the DI create/update handler around line 19421–19460.

**Interfaces:**
- Consumes: Task 2's columns.
- Produces: a DI create/update path that accepts `vendor_code`, `challan_no`, and `purpose='jobwork'`, and refuses a DI with no vendor.

- [ ] **Step 1: Add purpose validation beside the existing gate-pass precedent**

Near `gpPurposeValid` (worker.js ~162–170), add:

```js
// DI purposes. Validated server-side rather than by a CHECK constraint, matching
// gpPurposeValid's precedent — a new purpose is then a deploy, not a migration.
const DI_PURPOSES = ['office_request', 'jobwork'];
const diPurposeValid = p => DI_PURPOSES.includes(p);
```

- [ ] **Step 2: Extend `HEADER_FIELDS` and enforce the vendor**

At worker.js ~19421, change:

```js
const HEADER_FIELDS = ['purpose','destination','destination_contact','requester_notes','expected_return_at','notes'];
```

to:

```js
const HEADER_FIELDS = ['purpose','destination','destination_contact','requester_notes',
                       'expected_return_at','notes','vendor_code','challan_no'];
```

Then in the CREATE branch (~19442), immediately after the existing `purpose required` guard:

```js
if (!headerPatch.purpose) return err('purpose required on create');
if (!diPurposeValid(headerPatch.purpose))
  return err(`Invalid purpose: ${headerPatch.purpose}. Expected one of ${DI_PURPOSES.join(', ')}`);
// Vendor is mandatory — free-text destinations are retired. Office is a vendor (IN-VND-135).
if (!headerPatch.vendor_code) return err('vendor_code required — pick a vendor');
const venR = await query('vendors',
  `?vendor_code=eq.${encodeURIComponent(headerPatch.vendor_code)}&select=vendor_code&limit=1`);
if (!venR.ok || !venR.data?.[0]) return err(`Unknown vendor_code: ${headerPatch.vendor_code}`);
```

- [ ] **Step 3: Sweep every reader of `destination` and `purpose` before shipping**

Run: `grep -n "\.destination\b\|destination\b" 01_worker/worker.js | grep -i "issuance\|\bdi\b"` and `grep -rn "destination" 05_Throttle/apps/garage/src/app/\(auth\)/direct-issuance/`

⛔ **Do not skip this.** A `purpose` value added without checking its readers is the RULE-TAXONOMY-001 `classifyTitles` failure in another file — that one silently coerced a whole product category for weeks. Record what you found in the commit message, even if the answer is "only the two DI pages".

- [ ] **Step 4: Deploy and smoke the guard**

```bash
cd 01_worker && git add worker.js && git commit -m "S328 [lotops]: DI gains jobwork purpose + mandatory vendor_code" && git push && npx wrangler deploy
```

Then verify the refusal path is live:

```bash
curl -s -X POST "$LOTOPS_URL" -H 'content-type: application/json' \
  -d '{"action":"upsertDirectIssuance","data":{"purpose":"jobwork"}}' | head -c 200
```

Expected: an error naming `vendor_code`, **not** a created DI.

- [ ] **Step 5: Commit** (already committed in step 4 — verify the push landed before the deploy)

Run: `cd 01_worker && git status -sb | head -1`
Expected: `## main...origin/main` with no `ahead`. ⛔ Deploying off an unpushed branch silently reverts a parallel session's live change (PATTERN-220).

---

## Task 5: Garage — vendor Combobox replaces the free-text destination

**Files:**
- Modify: `05_Throttle/apps/garage/src/app/(auth)/direct-issuance/new/page.js`
- Modify: `05_Throttle/apps/garage/src/app/(auth)/direct-issuance/detail/page.js:332` (header fields)

**Interfaces:**
- Consumes: Task 4's `vendor_code` requirement.
- Produces: a DI form that cannot submit without a vendor.

- [ ] **Step 1: Add the vendor picker to the new-DI form**

In `new/page.js`, add to the form state (currently `expected_return_at: ''` at line 28):

```js
const [f, setF] = useState({ /* …existing… */ vendor_code: '', challan_no: '', purpose: 'office_request' });
const [vendors, setVendors] = useState([]);
```

Load vendors once:

```js
useEffect(() => {
  let alive = true;
  (async () => {
    const r = await garageFetch('getVendors', { active: true }, session);
    if (alive && Array.isArray(r)) setVendors(r);
  })();
  return () => { alive = false; };
}, [userId]);   // ⚠️ userId, NEVER session — session identity changes on token refresh (~hourly)
```

Render the picker:

```jsx
<Combobox
  portal
  value={f.vendor_code}
  onChange={(v) => setField('vendor_code', v)}
  options={vendors.map(v => ({
    value: v.vendor_code,
    label: v.vendor_name,
    hint:  v.vendor_code,
    search: v.category || '',
  }))}
  placeholder="Search vendor…"
/>
```

⚠️ **`portal` is required.** The DI form renders inside a card, and without it the dropdown is clipped inside the overflow container.

⚠️ **Key the load on `userId`, not `session`.** `onAuthStateChange` re-fires on tab switch and a real token refresh lands ~hourly; keying on `session` re-runs the effect and can unmount a form holding unsaved input.

- [ ] **Step 2: Remove the free-text destination input**

Delete the `destination` text input and replace with a `destination_contact` input labelled "Contact person (optional)". `destination` is no longer written by the UI.

- [ ] **Step 3: Build all twelve apps**

`packages/ui` is a dependency of 12 of 12 apps, and this change imports `Combobox` from it. Even though only Garage changes here, build the full set so a shared-package regression cannot hide:

```bash
cd 05_Throttle
filters=(); for d in apps/*/; do n=$(node -p "require('./$d/package.json').name" 2>/dev/null); [ -n "$n" ] && filters+=("--filter=$n"); done
npx turbo build "${filters[@]}"
```

Expected: **`Tasks: 12 successful, 12 total`**. ⛔ Read the number, not the exit code — a filter matching nothing reports success, and this shell is `zsh`, which does not word-split an unquoted variable.

⚠️ **Read the build output for `Attempted import error`.** That string is a *runtime crash*, not a warning — the build still exits 0 and the page throws the moment the symbol is called. It white-screened three live financial pages for ~8 weeks.

- [ ] **Step 4: Commit, push, and verify the Pages build actually ran**

```bash
git add apps/garage/src/app/\(auth\)/direct-issuance/
git commit -m "S328 [lotops]: DI form takes a vendor via Combobox, retires free-text destination"
git push
```

Then wait on **your own sha**, not the newest run:

```bash
SHA=$(git rev-parse HEAD)
until [ "$(gh run list --workflow='Deploy Garage' --limit 5 --json headSha,status \
           --jq "[.[]|select(.headSha==\"$SHA\")][0].status")" = "completed" ]; do sleep 15; done
gh api repos/legendlot/Stores/pages/builds --jq '.[0:3] | .[] | "\(.status) | \(.created_at) | \(.commit[0:8])"'
```

Expected: the newest Pages row is `built` with a `created_at` later than the run finished. `errored` = re-run; `building` = wait.

- [ ] **Step 5: Smoke it in the browser yourself**

Open Garage → Direct Issuance → New. **In-app browser first**; if it lands on a login page, STOP and ask Afshaan to log in — do not switch surfaces or try to authenticate.

⚠️ **Force a reload before measuring** (`location.reload(true)`) — `navigate` can serve a cached bundle and show you the OLD code seconds after a successful deploy.

Verify: the vendor field is a searchable box, typing `VITBOJ` narrows it, the dropdown is **not clipped** by the card, and submitting with no vendor is refused.

---

## Task 6: Approve raises the challan and the outward gate pass

**Files:**
- Modify: `01_worker/worker.js` — `approveDI`
- Modify: `05_Throttle/apps/garage/src/app/(auth)/direct-issuance/detail/page.js`

**Interfaces:**
- Consumes: Task 4's `vendor_code`, Task 2's `challan_no`.
- Produces: an approved job-work DI carries a `challan_no` and a linked returnable gate pass.

- [ ] **Step 1: On approve of a `jobwork` DI, mint the challan number and raise the gate pass**

In `approveDI`, after the status flip to `approved`:

```js
if (di.purpose === 'jobwork') {
  const challanNo = await nextSeq('jobwork_challan', 'JWC-');
  await update('direct_issuances', { challan_no: challanNo }, `id=eq.${di.id}`);
  // Material physically leaving the premises is a gate pass (RULE-GP-001), and this is the
  // same event as the BACKLOG's "gate-pass send-out on outsourced" item — raised here rather
  // than left as a second thing to remember.
  await insert('gate_passes', [{
    direction: 'outward', purpose: 'jobwork',
    party_name: di.vendor_code, reference_no: challanNo,
    is_returnable: true, expected_return_date: di.expected_return_at || null,
    notes: `Job-work challan for ${di.issue_no}`, created_by: authResult.userId,
  }]);
}
```

⚠️ **Verify `gate_passes` column names against `reference/db-schema.md` before writing this** — `party_name`, `reference_no` and `expected_return_date` are assumed here and the gate-pass table has its own vocabulary. Also confirm `'jobwork'` is valid for `direction='outward'` in `GP_PURPOSES`; if not, add it there in the same commit.

- [ ] **Step 2: Add the sequence row**

```sql
INSERT INTO store.sequences (name, current_val) VALUES ('jobwork_challan', 0)
ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 3: Verify end to end against the live DB**

Create a draft job-work DI on the Shadow pair, approve it, then:

```sql
SELECT d.issue_no, d.challan_no, d.vendor_code, g.reference_no, g.is_returnable, g.direction
FROM store.direct_issuances d
LEFT JOIN store.gate_passes g ON g.reference_no = d.challan_no
WHERE d.purpose='jobwork' ORDER BY d.id DESC LIMIT 1;
```

Expected: one row, `challan_no` like `JWC-001`, gate pass present, `is_returnable=true`, `direction='outward'`.

- [ ] **Step 4: Confirm the send debits unpainted stock — no code change expected**

`executeDirectIssuance` already does the per-part `total_issued += qty` with a `stockShortfallMessage` pre-flight. Scan the DI at a `DSP_ISSUE` station (one device is active) and confirm:

```sql
SELECT part_code, total_issued, closing_stock FROM store.stock_ledger WHERE part_code='SH-PB-51';
```

Expected: `total_issued` increased by the challan qty. ⛔ **If this required a code change, stop — the design assumed it would not, and something else is different.**

- [ ] **Step 5: Commit and deploy** (push must land before the deploy)

```bash
cd 01_worker && git add worker.js && git commit -m "S328 [lotops]: job-work approve mints a challan and raises the returnable gate pass" && git push && npx wrangler deploy
```

---

## Task 7: The job-work GRN credits damage back to the unpainted code

**This is the riskiest task in the plan.** A naive implementation credits damage to the *painted* code and silently inverts the balance while looking correct on screen.

**Files:**
- Modify: `01_worker/worker.js` — the shipment GRN path around line 20444–20460.

**Interfaces:**
- Consumes: `splitJobworkGrnCredits` and `resolveFinishPair` (Task 1); `store.part_finish_pairs` (Task 2).
- Produces: `stock_ledger` credits on both codes for a job-work return.

- [ ] **Step 1: Add the failing test for the wiring shape**

Append to `01_worker/test/jobwork.test.js`:

```js
// The shape the worker must produce for a whole GRN, not just one line: credits are
// aggregated per part_code before hitting bulk_update_stock_received, so a shipment with
// two lines sharing an unpainted code does not issue two competing updates for it.
import { aggregateCredits } from '../lib/jobwork.js';

test('aggregateCredits: sums repeated part codes into one row', () => {
  assert.deepEqual(
    aggregateCredits([
      { part_code: 'SH-PB-52', qty: 950 },
      { part_code: 'SH-PB-51', qty: 30 },
      { part_code: 'SH-PB-51', qty: 20 },
    ]),
    [{ part_code: 'SH-PB-52', qty: 950 }, { part_code: 'SH-PB-51', qty: 50 }]);
});

test('aggregateCredits: drops zero and negative rows', () => {
  assert.deepEqual(aggregateCredits([{ part_code: 'A', qty: 0 }, { part_code: 'B', qty: -5 }]), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd 01_worker && node --test test/`
Expected: FAIL — `aggregateCredits is not a function`

- [ ] **Step 3: Implement `aggregateCredits`**

Append to `01_worker/lib/jobwork.js`:

```js
/** Sum credits per part_code, preserving first-seen order, dropping non-positive rows. */
export function aggregateCredits(rows) {
  const byPart = new Map();
  for (const r of rows || []) {
    if (!r || !r.part_code) continue;
    byPart.set(r.part_code, (byPart.get(r.part_code) || 0) + (Number(r.qty) || 0));
  }
  return [...byPart.entries()]
    .filter(([, qty]) => qty > 0)
    .map(([part_code, qty]) => ({ part_code, qty }));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd 01_worker && node --test test/`
Expected: PASS — `# pass 11`, `# fail 0`

- [ ] **Step 5: Extend the worker.js import**

Task 1 added `import { resolveFinishPair, splitJobworkGrnCredits } from './lib/jobwork.js';`.
`aggregateCredits` is new here, so update that line — it is a single line and easy to miss:

```js
import { resolveFinishPair, splitJobworkGrnCredits, aggregateCredits } from './lib/jobwork.js';
```

⚠️ An un-imported symbol is `undefined` at runtime, and **`Attempted import error` still exits 0** —
the bundle builds and the handler throws the first time a job-work GRN is received.

- [ ] **Step 6: Wire it into the GRN path**

At worker.js ~20452, the GRN rows currently hardcode `qty_rejected: 0` and build `stockUpdates` from `qty_received` alone. Replace the stock-update construction:

```js
// Job-work returns credit damaged material back to the INPUT (unpainted) code — on job-work
// the goods are still LOT's own, so rework is an ordinary second challan rather than a third
// part state. `source` is already set above ('jobwork' when the shipment links an EXT run).
let pairs = [];
if (linkedExt || ship.fbu_kind === 'jobwork') {
  const painted = partsLines.map(l => `"${l.part_code}"`).join(',');
  const pr = await query('part_finish_pairs',
    `?painted_part_code=in.(${painted})&is_active=eq.true&select=unpainted_part_code,painted_part_code,is_active`);
  if (pr.ok) pairs = pr.data || [];
}
const grnSource = linkedExt ? 'jobwork' : (isFbuShip ? 'fbu_purchase' : null);
const stockUpdates = aggregateCredits(
  partsLines.flatMap(l => splitJobworkGrnCredits({
    source:      grnSource,
    partCode:    l.part_code,
    qtyReceived: grnDelta(l),
    damagedQty:  l.damaged_qty || 0,
    pair:        resolveFinishPair(pairs, l.part_code),
  })));
if (stockUpdates.length > 0) await rpc('bulk_update_stock_received', { p_updates: stockUpdates });
```

And stop hardcoding the damaged figure away in the GRN row:

```js
qty_ordered: l.qty_expected||0, qty_received: grnDelta(l), qty_rejected: 0,
damaged_qty: Math.round(Number(l.damaged_qty) || 0),
```

⚠️ **`qty_rejected` stays 0 deliberately.** It is dead across all 7,025 rows; `damaged_qty` is the live field the floor already fills in. Do not switch to it.

⚠️ **One `query` for all pairs, not one per line** — never loop awaits per row.

- [ ] **Step 7: Prove the two-part movement against the live DB**

Record both ledgers, receive a job-work shipment with a damaged qty, then re-read:

```sql
SELECT part_code, total_received, closing_stock FROM store.stock_ledger
WHERE part_code IN ('SH-PB-51','SH-PB-52');
```

Expected: `SH-PB-52.total_received` up by the accepted qty **and** `SH-PB-51.total_received` up by the damaged qty.

⛔ **If `SH-PB-52` moved by accepted + damaged and `SH-PB-51` did not move, the split is inverted** — that is the exact failure this task exists to prevent. Do not ship it.

- [ ] **Step 8: Commit and deploy**

```bash
cd 01_worker && git add worker.js lib/jobwork.js test/jobwork.test.js
git commit -m "S328 [lotops]: job-work GRN credits damaged material back to the unpainted code"
git push && npx wrangler deploy
```

---

## Task 7b: Stamp the challan on a job-work return (ITC-04 link)

**Why this exists:** Task 2 creates `store.direct_issuance_returns` and, without this task, nothing
ever writes to it — which would make it the fourth built-and-unused mechanism in this exact area.
⚠️ **Best-effort by design: this must NEVER gate the GRN.** Gating receipt on paperwork is precisely
how the EXT link reached zero rows.

**Files:**
- Modify: `01_worker/worker.js` — same GRN path as Task 7.

**Interfaces:**
- Consumes: Task 7's resolved `pairs` and `grnSource`.
- Produces: `direct_issuance_returns` rows linking a GRN to the oldest open challan for that pair.

- [ ] **Step 1: After the stock credit, stamp the oldest open challan**

```js
// ITC-04 link, best-effort. Oldest-open-first: a vendor may hold several challans on the same
// pair, and FIFO is the only defensible attribution without asking the receiver to choose.
if (grnSource === 'jobwork' && stockUpdates.length > 0) {
  const paintedCodes = partsLines.map(l => l.part_code);
  for (const line of partsLines) {
    const pair = resolveFinishPair(pairs, line.part_code);
    if (!pair) continue;
    const openR = await query('direct_issuances',
      `?purpose=eq.jobwork&status=eq.issued&returned_at=is.null` +
      `&vendor_code=eq.${encodeURIComponent(ship.vendor_code || '')}` +
      `&order=issued_at.asc&limit=1&select=id`);
    if (!openR.ok || !openR.data?.[0]) continue;   // no open challan — receipt still stands
    await insert('direct_issuance_returns', [{
      issuance_id: openR.data[0].id,
      part_code:   line.part_code,
      qty:         Math.round(Number(grnDelta(line)) || 0),
      scrap_qty:   Math.round(Number(line.damaged_qty) || 0),
      grn_no:      grnNo,
      note:        `Auto-linked from ${shipment_id}`,
    }]);
  }
}
```

⚠️ **Every failure path here is a `continue`, never a `return err(...)`.** A missing pair, a missing
challan or a failed insert must leave the GRN intact — the goods physically arrived.

- [ ] **Step 2: Verify the link is written and the GRN survives its absence**

Receive a job-work shipment with an open challan, then one with none:

```sql
SELECT r.grn_no, r.part_code, r.qty, r.scrap_qty, d.issue_no, d.challan_no
FROM store.direct_issuance_returns r
JOIN store.direct_issuances d ON d.id = r.issuance_id
ORDER BY r.id DESC LIMIT 5;
```

Expected: a row for the first; for the second, **no row and a successful GRN** with stock credited.

- [ ] **Step 3: Commit and deploy**

```bash
cd 01_worker && git add worker.js && git commit -m "S328 [lotops]: best-effort ITC-04 link from job-work GRN to its open challan" && git push && npx wrangler deploy
```

---

## Task 8: The balance view and the Garage panel

**Files:**
- Supabase migration `jobwork_balance_v1`
- Create: `05_Throttle/apps/garage/src/app/(auth)/jobwork/page.js`
- Modify: `01_worker/worker.js` — add a `getJobworkBalance` read

**Interfaces:**
- Consumes: everything above.
- Produces: `store.jobwork_balance`; `getJobworkBalance` returning its rows.

- [ ] **Step 1: Create the view**

```sql
CREATE VIEW store.jobwork_balance AS
WITH cutover AS (SELECT DATE '2026-09-01' AS d),   -- single constant; see Global Constraints
sent AS (
  SELECT di.vendor_code, ii.part_code AS unpainted_part_code, SUM(ii.qty)::int AS sent
  FROM store.direct_issuances di
  JOIN store.direct_issuance_items ii ON ii.issuance_id = di.id
  WHERE di.purpose = 'jobwork' AND di.status = 'issued'
    AND di.issued_at >= (SELECT d FROM cutover)
  GROUP BY 1,2
),
back AS (
  SELECT v.vendor_code, g.part_code AS painted_part_code,
         SUM(g.qty_received)::int AS returned,
         SUM(g.damaged_qty)::int  AS damaged
  FROM store.grn_register g
  JOIN store.vendors v ON v.vendor_name = g.supplier
  WHERE g.grn_date >= (SELECT d FROM cutover)
  GROUP BY 1,2
)
SELECT p.unpainted_part_code, p.painted_part_code,
       COALESCE(s.vendor_code, b.vendor_code)      AS vendor_code,
       COALESCE(s.sent, 0)                          AS sent,
       COALESCE(b.returned, 0)                      AS returned,
       COALESCE(b.damaged, 0)                       AS damaged,
       COALESCE(s.sent,0) - COALESCE(b.returned,0) - COALESCE(b.damaged,0) AS remainder
FROM store.part_finish_pairs p
LEFT JOIN sent s ON s.unpainted_part_code = p.unpainted_part_code
LEFT JOIN back b ON b.painted_part_code   = p.painted_part_code
                AND (s.vendor_code IS NULL OR b.vendor_code = s.vendor_code)
WHERE p.is_active;

GRANT SELECT ON store.jobwork_balance TO service_role;
NOTIFY pgrst, 'reload schema';
```

⚠️ **`remainder` is ONE column, deliberately.** While a challan is open it means *goods still at the vendor*; once closed it means *paint loss*. Same arithmetic, different reading. **Do not add a second column computing the same expression** — that invites one being read as an independent measurement.

⚠️ **`grn_register.supplier` is free text**, so the join to `vendors.vendor_name` is a string match. Verify it resolves for all three painters before trusting the view:

```sql
SELECT DISTINCT g.supplier, v.vendor_code
FROM store.grn_register g LEFT JOIN store.vendors v ON v.vendor_name = g.supplier
WHERE g.part_code IN ('SH-PB-52','SH-PB-60');
```

Expected: `VITBOJ POLYCOATINGS`, `Mudra Innovation` and `SG VENTURES` all resolve to a `vendor_code`. **`Line Flush` will not resolve — that is correct and is how the internal repack flush is excluded** (703 units across these codes). If a real painter fails to resolve, fix the vendor name rather than loosening the join.

- [ ] **Step 2: Assert the cutover anchor holds**

```sql
SELECT * FROM store.jobwork_balance;
```

Expected on day one, before any job-work DI exists: every row reads `sent=0`, `returned=0`, `remainder=0`. ⛔ **A large negative `remainder` means the cutover is not applied** — there are already 18,129 painted tops GRN'd from VITBOJ against zero sends, and without the anchor the view reads catastrophically negative and nobody trusts it again.

- [ ] **Step 3: Add the worker read**

```js
if (action === 'getJobworkBalance') {
  if (!canViewProd(P)) return err('No permission', 403);
  const r = await query('jobwork_balance', '?order=remainder.desc&limit=2000');
  if (!r.ok) return err('Balance read failed: ' + JSON.stringify(r.data));
  return ok(r.data);
}
```

⚠️ **`limit=2000`, not the default.** PostgREST caps every response at `db-max-rows` (5,000) regardless, and a low explicit cap is the "silent truncation that reads as a successful answer" class this workspace keeps recording.

- [ ] **Step 4: Build the Garage panel**

Create `apps/garage/src/app/(auth)/jobwork/page.js`:

```jsx
'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';

export default function JobWorkPage() {
  const { session, userId } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await garageFetch('getJobworkBalance', {}, session);
      if (!alive) return;
      setRows(Array.isArray(r) ? r : []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [userId]);   // userId, never session — see Task 5 Step 1

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Job work — at the vendor</h1>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 16 }}>
        Sent minus returned minus damaged, since cutover. While a challan is open this is material
        still at the vendor; once it is closed the same number is paint loss.
      </p>
      {/* Wide tables must scroll inside their own container, never the page body. */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
          <thead>
            <tr>
              {['Vendor','Unpainted','Painted','Sent','Returned','Damaged','Remainder'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12,
                                     borderBottom: '1px solid var(--line)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 16, fontSize: 13, color: 'var(--t2)' }}>
                Nothing out at a vendor.
              </td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={td}>{r.vendor_code || '—'}</td>
                <td style={{ ...td, fontFamily: 'var(--mono)' }}>{r.unpainted_part_code}</td>
                <td style={{ ...td, fontFamily: 'var(--mono)' }}>{r.painted_part_code}</td>
                <td style={td}>{Number(r.sent)}</td>
                <td style={td}>{Number(r.returned)}</td>
                <td style={td}>{Number(r.damaged)}</td>
                <td style={{ ...td, fontWeight: 600 }}>{Number(r.remainder)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const td = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid var(--line)' };
```

Then add the nav entry in `apps/garage/src/lib/nav.js` alongside the Direct Issuance group, gated on
the same permission `getJobworkBalance` checks. ⚠️ **A `PERM_DEFS` key with zero worker readers is
dead UI** — use the key the handler actually enforces.

- [ ] **Step 5: Build all twelve and verify the count**

```bash
cd 05_Throttle
filters=(); for d in apps/*/; do n=$(node -p "require('./$d/package.json').name" 2>/dev/null); [ -n "$n" ] && filters+=("--filter=$n"); done
npx turbo build "${filters[@]}"
```

Expected: `Tasks: 12 successful, 12 total`.

- [ ] **Step 6: Commit, push, verify the Pages build, and smoke it**

Same sha-anchored wait and forced reload as Task 5 Step 4–5.

---

## Task 9 (OFF CRITICAL PATH): inline vendor-create bridge

⛔ **Blocked on Afshaan's permission — do not start without it.** A Worker cannot `fetch()` another Worker on the same `workers.dev` zone (Cloudflare error 1042, surfacing as a **404**), so lotopsproxy → snorkelops needs a `[[services]]` binding, i.e. an edit to `01_worker/wrangler.toml`. The repo rule is **never modify `wrangler.toml` without explicit permission.**

**Until this ships, the "+ Add vendor" affordance stays hidden and an unknown painter is added in Snorkel first — degraded, not blocked.** Do not let this hold Tasks 1–8.

**Files:**
- Modify: `01_worker/wrangler.toml` (⚠️ permission required), `01_worker/worker.js`, `05_Throttle/snorkelops-worker/src/index.js`, the Garage DI form.

- [ ] **Step 1: Get explicit permission from Afshaan for the `wrangler.toml` services binding.** Stop here until given.
- [ ] **Step 2: Add the binding**, modelled on `csops-worker/wrangler.toml`'s existing `[[services]]` block.
- [ ] **Step 3: Add a token-authed, scope-limited vendor-create endpoint to snorkelops**, mirroring the `POST /bridge/ignition` + `IGNITION_BRIDGE_TOKEN` pattern. ⭐ **It must call the existing `postVendor` minting logic, not reimplement it** — two code paths minting vendor codes is the duplicate-path class that keeps biting this codebase, and the existing one derives max+1 from live data specifically because bulk imports bypass the counter.
- [ ] **Step 4: Add the lotopsproxy proxy handler**, gated on `canRequestDirectIssuance` (the challan raiser's own permission), which then calls the bridge.
- [ ] **Step 5: Show the "+ Add vendor" affordance** in the Garage Combobox when the search returns nothing.
- [ ] **Step 6: Verify** a user holding `direct_issuance_request` but **no** Snorkel permission can create a vendor through the bridge, and a user with neither cannot.

---

## Post-implementation

- [ ] Update `reference/db-schema.md` (`/schema-sync`) — three new tables/views and two new columns.
- [ ] Move the BACKLOG items: `[lotops] [build] [MED]` moulder→painter and `[lotops] [build] [LOW]` gate-pass send-out, with their narrative, to `archive/BACKLOG_ARCHIVE.md` **in the same commit**.
- [ ] Update `systems/lotops.md` with the job-work leg as shipped state.
- [ ] Amend RULE-DSP-001's `⏳ Unenforced` marker — it currently says "a design, not a description; nothing is built".
- [ ] Run `/hostile-review` over this session's own diff and DB writes.
- [ ] ⏳ Chase Piyush for the Flare painted counterparts (spec §10 Q1) and add the pairs.
- [ ] ⏳ Raise `category='Internal'` picker filtering with the Snorkel lane (spec §10 Q4).
- [ ] ⚠️ **Repoint `store.mould_parts` at the unpainted codes** (spec §8 step 6). ⛔ **Deliberately LAST and never a side effect** — it feeds `seedReceivingLinesFromPO` (worker.js ~929), so it changes what a mould PO explodes into at receiving. Verify against a real mould PO before and after.
- [ ] ⏳ **Procurement change (spec §8 step 7), not a code task:** moulder POs move to unpainted codes, and painter POs become **service** POs for the painting charge rather than goods POs on painted codes. Without this the store has no unpainted PO to receive against, so **the loop cannot actually start** — raise it with Piyush/procurement as the real go-live gate.
- [ ] ⚠️ **Tell the floor.** Inwarding the moulder's unpainted delivery is a visible change to the store's day — a `#bugs` note tagged to the station owner, same session.
