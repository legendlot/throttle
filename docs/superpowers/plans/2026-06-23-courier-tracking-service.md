# Courier Tracking Service (`courierops`) — V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically keep each outbound Delhivery dispatch shipment's stage, expected/actual delivery dates, and full scan timeline fresh — surfaced as a timeline + current stage in Depot (floor) and read-only in Snorkel.

**Architecture:** A new headless Cloudflare worker `courierops` (`service_role`, cron-driven, no inbound auth) bulk-pulls Delhivery tracking by AWB, normalizes it behind a courier-agnostic `TrackResult` interface, and writes back onto `public.dispatch_shipments` via one `apply_courier_tracking(jsonb)` RPC (single subrequest). UIs render the already-served columns — no consumer worker changes.

**Tech Stack:** Cloudflare Workers (ESM, plain JS), Supabase Postgres (migrations via MCP `apply_migration`), Next.js static-export apps (`apps/depot`, `apps/snorkel`). Node built-in test runner (`node --test`) for the one pure-function unit (the normalizer). Project id `jkxcnjabmrkteanzoofj`.

**Spec:** `docs/superpowers/specs/2026-06-23-courier-tracking-service-design.md`.

**Conventions (must follow):** PostgREST returns numerics as strings → wrap `Number()`; integer inserts → `Math.round()`. 50-subrequest limit → the cron does ≤20 bulk pulls + 1 RPC write per run. Cross-repo git = `git -C <path>`. Worker deploy = edit → commit → push → `cd <dir> && npx wrangler deploy` (workers are NOT auto-deployed by CI; only the apps are). Delhivery auth header is the literal `Authorization: Token <token>` (NOT `Bearer`). Delhivery timestamps are ISO-8601 without timezone = **IST** → normalize to UTC. Never modify any `wrangler.toml` of an existing worker; creating `courierops`'s own is fine (new file).

---

## File structure

```
05_Throttle/courierops-worker/
├── wrangler.toml                 name=courierops, cron trigger, workers_dev
├── package.json                  type=module + a test script
├── src/
│   ├── index.js                  scheduled() cron driver + db helpers (sbPublic, RPC call)
│   ├── normalize.js              TrackResult shape, stage enum, normalizeDelhivery() — PURE, unit-tested
│   └── adapters/delhivery.js     trackBulk(awbs, token) → TrackResult[]
└── test/
    └── normalize.test.mjs        node --test against the brief's sample JSON

apps/depot/src/app/(auth)/dispatch-shipments/page.js   courier dropdown + timeline (modify)
apps/snorkel/src/app/(auth)/sales/orders/detail/page.js  read-only timeline (modify)
```

---

## Phase A — Database migration

### Task A1: Columns + apply RPC

**Files:** migration `courier_tracking_v1` (MCP `apply_migration`).

- [ ] **Step 1: Verify current columns** — run via `execute_sql`:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='dispatch_shipments'
  AND column_name IN ('tracking_status','tracking_stage_label','tracking_checkpoints','tracking_synced_at');
```
Expected: 0 rows (none exist yet).

- [ ] **Step 2: Apply the migration** (`apply_migration`, name `courier_tracking_v1`):
```sql
ALTER TABLE public.dispatch_shipments
  ADD COLUMN IF NOT EXISTS tracking_status      text,
  ADD COLUMN IF NOT EXISTS tracking_stage_label text,
  ADD COLUMN IF NOT EXISTS tracking_checkpoints jsonb,
  ADD COLUMN IF NOT EXISTS tracking_synced_at   timestamptz;

COMMENT ON COLUMN public.dispatch_shipments.tracking_status IS
  'Normalized courier stage (courierops): manifested/in_transit/out_for_delivery/delivered/undelivered/rto_in_transit/rto_delivered/cancelled/lost/unknown.';

CREATE OR REPLACE FUNCTION public.apply_courier_tracking(updates jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.dispatch_shipments s SET
    tracking_status        = u.tracking_status,
    tracking_stage_label   = u.tracking_stage_label,
    tracking_checkpoints   = u.tracking_checkpoints,
    tracking_synced_at     = now(),
    expected_delivery_date = COALESCE(u.expected_delivery_date, s.expected_delivery_date),
    delivery_date          = COALESCE(u.delivery_date, s.delivery_date)  -- never null out a manually-set date
  FROM jsonb_to_recordset(updates) AS u(
    id uuid,
    tracking_status text,
    tracking_stage_label text,
    tracking_checkpoints jsonb,
    expected_delivery_date date,
    delivery_date date
  )
  WHERE s.id = u.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION public.apply_courier_tracking(jsonb) TO service_role;
```

- [ ] **Step 3: Verify columns** — re-run Step 1 query; expect 4 rows.

- [ ] **Step 4: Verify RPC + advisor** — `get_advisors` (security) shows no new `rls_disabled_in_public` (dispatch_shipments RLS already on). Then smoke the RPC with an empty batch:
```sql
SELECT public.apply_courier_tracking('[]'::jsonb);  -- expect 0
```

---

## Phase B — `courierops` worker

### Task B1: Scaffold the worker (wrangler + package.json)

**Files:** Create `courierops-worker/wrangler.toml`, `courierops-worker/package.json`.

- [ ] **Step 1: Create `courierops-worker/wrangler.toml`**:
```toml
name = "courierops"
main = "src/index.js"
compatibility_date = "2026-05-28"
workers_dev = true

# courierops — LOT courier-tracking service. Headless: cron-driven only, no inbound HTTP auth.
# service_role on the SAME Supabase project as lotopsproxy. Polls Delhivery by AWB and writes
# tracking back onto public.dispatch_shipments (tracking_status/_stage_label/_checkpoints/_synced_at
# + keeps expected_delivery_date/delivery_date fresh) via the apply_courier_tracking RPC.
# V1 = Delhivery, forward shipments only. Shiprocket + webhooks + returns = V2.

# Every 30 min: sweep open Delhivery shipments and refresh tracking.
[triggers]
crons = ["*/30 * * * *"]

# Secrets set via `wrangler secret put` — never stored in this file:
#   SUPABASE_SERVICE_KEY   (Supabase service_role sb_secret key — same project as lotopsproxy)
#   DELHIVERY_API_TOKEN    (production token — Delhivery One → Settings → API Setup; header is `Token <t>`, not Bearer)
```

- [ ] **Step 2: Create `courierops-worker/package.json`**:
```json
{
  "name": "courierops-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 3: Commit**:
```bash
git -C 05_Throttle add courierops-worker/wrangler.toml courierops-worker/package.json
git -C 05_Throttle commit -m "courierops: scaffold worker (wrangler cron + package.json)"
```

### Task B2: Normalizer (TDD — write the test first)

**Files:** Create `courierops-worker/test/normalize.test.mjs`, then `courierops-worker/src/normalize.js`.

- [ ] **Step 1: Write the failing test** — `courierops-worker/test/normalize.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDelhivery, TERMINAL_STAGES, istToUtc } from '../src/normalize.js';

// Delivered shipment (trimmed from the research brief, IST timestamps, microseconds).
const DELIVERED = {
  Scans: [
    { ScanDetail: { ScanDateTime: '2023-02-05T23:15:12.713000', ScanType: 'UD',
      Scan: 'Manifested', ScannedLocation: 'Chennai_Guindy_C (Tamil Nadu)',
      Instructions: 'Shipment details manifested', StatusCode: 'X-UCI' } },
    { ScanDetail: { ScanDateTime: '2023-02-15T12:18:25.002000', ScanType: 'DL',
      Scan: 'Delivered', ScannedLocation: 'Imphal_MnprUnvrsty_D (Manipur)',
      Instructions: 'Delivered to consignee', StatusCode: 'EOD-38' } },
  ],
  Status: { Status: 'Delivered', StatusLocation: 'Imphal_MnprUnvrsty_D (Manipur)',
    StatusDateTime: '2023-02-15T12:18:25.002000', StatusType: 'DL', StatusCode: 'EOD-38' },
  DeliveryDate: '2023-02-15T12:18:25.002000',
  ExpectedDeliveryDate: '2023-02-16T23:59:59',
  AWB: 'TESTAWB1',
};

test('istToUtc converts IST (no tz, microseconds) to UTC ISO', () => {
  // 12:18:25 IST == 06:48:25 UTC
  assert.equal(istToUtc('2023-02-15T12:18:25.002000'), '2023-02-15T06:48:25.002Z');
  assert.equal(istToUtc(null), null);
  assert.equal(istToUtc('garbage'), null);
});

test('delivered shipment → delivered stage, delivered_at, EDD, full timeline', () => {
  const r = normalizeDelhivery(DELIVERED);
  assert.equal(r.awb, 'TESTAWB1');
  assert.equal(r.stage, 'delivered');
  assert.equal(r.stage_label, 'Delivered');
  assert.equal(r.expected_delivery_date, '2023-02-16');
  assert.equal(r.delivered_at, '2023-02-15T06:48:25.002Z');
  assert.equal(r.checkpoints.length, 2);
  // newest-first
  assert.equal(r.checkpoints[0].stage, 'delivered');
  assert.equal(r.checkpoints[0].status_code, 'EOD-38');
  assert.equal(r.checkpoints[0].location, 'Imphal_MnprUnvrsty_D (Manipur)');
  assert.equal(r.checkpoints[1].stage, 'manifested');
});

test('in-transit (UD) shipment is non-terminal with no delivered_at', () => {
  const r = normalizeDelhivery({
    Scans: [{ ScanDetail: { ScanDateTime: '2023-02-06T14:35:08', ScanType: 'UD',
      Scan: 'In Transit', ScannedLocation: 'Gurgaon_Bilaspur_HB (Haryana)',
      Instructions: 'Shipment in transit', StatusCode: 'X-UCI' } }],
    Status: { Status: 'In Transit', StatusDateTime: '2023-02-06T14:35:08',
      StatusType: 'UD', StatusCode: 'X-UCI' },
    ExpectedDeliveryDate: '2023-02-16T23:59:59', AWB: 'TESTAWB2',
  });
  assert.equal(r.stage, 'in_transit');
  assert.equal(r.delivered_at, null);
  assert.ok(!TERMINAL_STAGES.includes(r.stage));
});
```

- [ ] **Step 2: Run the test, verify it fails**:
```bash
cd 05_Throttle/courierops-worker && node --test
```
Expected: FAIL (`Cannot find module '../src/normalize.js'`).

- [ ] **Step 3: Implement `courierops-worker/src/normalize.js`**:
```js
// Courier-agnostic tracking model + the Delhivery normalizer. PURE (no I/O) so it is unit-tested
// and reused by future couriers/returns. Delhivery quirks handled here: map on StatusType+StatusCode
// (not the free-text status) for terminal decisions; IST→UTC on every timestamp; preserve raw codes.

export const TERMINAL_STAGES = ['delivered', 'rto_delivered', 'cancelled', 'lost'];

// Delhivery timestamps are ISO-8601 WITHOUT timezone = IST; may carry microseconds. → UTC ISO (ms).
export function istToUtc(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const ms = (m[3] || '').slice(0, 3).padEnd(3, '0');
  const d = new Date(`${m[1]}T${m[2]}.${ms}+05:30`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// EDD is an IST end-of-day stamp; we only want the calendar date.
function toDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// StatusType + StatusCode → normalized stage. text only refines the non-terminal UD bucket display.
function mapStage(statusType, statusCode, statusText) {
  const t = (statusType || '').toUpperCase();
  const c = (statusCode || '').toUpperCase();
  const txt = (statusText || '').toLowerCase();
  if (t === 'DL') return c.startsWith('DTO') ? 'rto_delivered' : 'delivered';
  if (t === 'CN') return 'cancelled';
  if (t === 'RT' || c.startsWith('RTO')) return c.startsWith('DTO') ? 'rto_delivered' : 'rto_in_transit';
  if (t === 'PU' || t === 'PP') return 'rto_in_transit';            // reverse-pickup legs (returns, V2)
  if (t === 'UD') {
    if (txt.includes('manifest')) return 'manifested';
    if (txt.includes('out for delivery') || txt.includes('out-for-delivery') || txt.includes('dispatched for delivery')) return 'out_for_delivery';
    if (txt.includes('undelivered') || txt.includes('not delivered') || txt.includes('ndr')) return 'undelivered';
    return 'in_transit';
  }
  return 'unknown';
}

function checkpoint(detail) {
  return {
    timestamp: istToUtc(detail.ScanDateTime),
    stage: mapStage(detail.ScanType, detail.StatusCode, detail.Scan),
    label: detail.Scan || null,
    status_code: detail.StatusCode || null,   // raw — never whitelisted, so new codes never break ingestion
    location: detail.ScannedLocation || null,
    description: detail.Instructions || null,
  };
}

// shipment = one ShipmentData[].Shipment object (pull API). Returns a TrackResult, or null if no AWB.
export function normalizeDelhivery(shipment) {
  if (!shipment) return null;
  const st = shipment.Status || {};
  const stage = mapStage(st.StatusType, st.StatusCode, st.Status);
  const checkpoints = (shipment.Scans || [])
    .map(s => checkpoint(s.ScanDetail || {}))
    .filter(c => c.timestamp)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));   // newest-first
  const delivered_at = stage === 'delivered'
    ? istToUtc(shipment.DeliveryDate || st.StatusDateTime)
    : null;
  return {
    courier: 'delhivery',
    awb: shipment.AWB || shipment.Waybill || null,
    stage,
    stage_label: st.Status || null,
    expected_delivery_date: toDate(shipment.ExpectedDeliveryDate),
    delivered_at,
    checkpoints,
    fetched_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**:
```bash
cd 05_Throttle/courierops-worker && node --test
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**:
```bash
git -C 05_Throttle add courierops-worker/src/normalize.js courierops-worker/test/normalize.test.mjs
git -C 05_Throttle commit -m "courierops: Delhivery normalizer (pure) + unit tests (stage map, IST→UTC, timeline)"
```

### Task B3: Delhivery adapter

**Files:** Create `courierops-worker/src/adapters/delhivery.js`.

- [ ] **Step 1: Implement `trackBulk`**:
```js
import { normalizeDelhivery } from '../normalize.js';

const HOST = 'https://track.delhivery.com';     // production (staging host = staging-express.delhivery.com, V2)
const BATCH = 30;                                // Delhivery bulk cap = 30 AWBs/call

// Pull tracking for many AWBs. token → `Authorization: Token <token>` (NOT Bearer). verbose=2 required
// for the full scan timeline. Returns TrackResult[]; a failed batch is logged and skipped (others proceed).
export async function trackBulk(awbs, token) {
  const out = [];
  for (let i = 0; i < awbs.length; i += BATCH) {
    const batch = awbs.slice(i, i + BATCH);
    const url = `${HOST}/api/v1/packages/json/?verbose=2&waybill=${batch.map(encodeURIComponent).join(',')}`;
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } });
    } catch (e) { console.error('delhivery fetch failed:', e?.message || e); continue; }
    if (!res.ok) { console.error(`delhivery ${res.status} for batch ${i}..${i + BATCH}`); continue; }
    let data;
    try { data = await res.json(); } catch { console.error('delhivery: non-JSON body'); continue; }
    for (const sd of (data.ShipmentData || [])) {
      const r = normalizeDelhivery(sd.Shipment);
      if (r && r.awb) out.push(r);
    }
  }
  return out;
}
```

- [ ] **Step 2: Commit**:
```bash
git -C 05_Throttle add courierops-worker/src/adapters/delhivery.js
git -C 05_Throttle commit -m "courierops: Delhivery adapter — bulk track-by-AWB (30/call, verbose=2, Token auth)"
```

### Task B4: Cron driver (`index.js`)

**Files:** Create `courierops-worker/src/index.js`.

- [ ] **Step 1: Implement the scheduled handler + db helpers**:
```js
import { trackBulk } from './adapters/delhivery.js';
import { TERMINAL_STAGES } from './normalize.js';

const SUPABASE_URL = 'https://jkxcnjabmrkteanzoofj.supabase.co';
const MAX_AWBS = 600;   // ≤20 bulk pulls + 1 RPC write per run — well under the 50-subrequest limit

// service-role: sb_secret key sent as BOTH apikey and Authorization (not a JWT). public schema = no profile.
async function sbPublic(key, path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: opts.prefer || '',
    ...opts.headers,
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...opts, headers });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// UTC ISO timestamp → IST calendar date (delivery_date is a date col; a 23:30 IST delivery is the IST day).
function istDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function sweep(env) {
  const key = env.SUPABASE_SERVICE_KEY;
  const token = env.DELHIVERY_API_TOKEN;
  if (!key || !token) { console.error('courierops: missing SUPABASE_SERVICE_KEY or DELHIVERY_API_TOKEN'); return; }

  // Open Delhivery shipments that carry an AWB and are not in a terminal stage, < 30 days old.
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
  const terminal = TERMINAL_STAGES.join(',');     // unquoted: values have no special chars
  const q = `?select=id,tracking_number&courier_partner=eq.Delhivery&tracking_number=not.is.null`
    + `&or=(tracking_status.is.null,tracking_status.not.in.(${terminal}))`
    + `&created_at=gte.${cutoff}&limit=${MAX_AWBS}`;
  const r = await sbPublic(key, `/rest/v1/dispatch_shipments${q}`);
  if (!r.ok) { console.error('courierops: shipment query failed', r.status, r.data); return; }

  const rows = Array.isArray(r.data) ? r.data : [];
  if (!rows.length) { console.log('courierops: no open Delhivery shipments'); return; }

  // AWB → shipment id (last one wins if an AWB somehow repeats; realistically 1:1).
  const byAwb = {};
  for (const row of rows) byAwb[String(row.tracking_number).trim()] = row.id;
  const awbs = Object.keys(byAwb);

  const results = await trackBulk(awbs, token);
  const updates = results.map(res => {
    const id = byAwb[String(res.awb).trim()];
    if (!id) return null;
    return {
      id,
      tracking_status: res.stage,
      tracking_stage_label: res.stage_label,
      tracking_checkpoints: res.checkpoints,
      expected_delivery_date: res.expected_delivery_date,
      delivery_date: istDate(res.delivered_at),   // null unless terminal-delivered; RPC COALESCEs so manual stays
    };
  }).filter(Boolean);

  if (!updates.length) { console.log('courierops: nothing to update'); return; }
  const w = await sbPublic(key, '/rest/v1/rpc/apply_courier_tracking',
    { method: 'POST', body: JSON.stringify({ updates }) });
  if (!w.ok) console.error('courierops: apply RPC failed', w.status, w.data);
  else console.log(`courierops: updated ${w.data} of ${updates.length} (${rows.length} open)`);
}

export default {
  async scheduled(event, env, ctx) {
    try { await sweep(env); }
    catch (e) { console.error('courierops cron failed:', e?.message || e); }
  },
};
```

- [ ] **Step 2: Re-run the unit test** to confirm the imports still resolve (index.js is not imported by the test, but normalize/adapters must stay valid):
```bash
cd 05_Throttle/courierops-worker && node --test
```
Expected: PASS (3 tests).

- [ ] **Step 3: Dry-run the worker bundle locally** (no live calls — just confirms it bundles + the cron handler is wired):
```bash
cd 05_Throttle/courierops-worker && npx wrangler deploy --dry-run --outdir=/tmp/courierops-dry
```
Expected: bundles with no errors; output notes the `*/30 * * * *` cron trigger.

- [ ] **Step 4: Commit**:
```bash
git -C 05_Throttle add courierops-worker/src/index.js
git -C 05_Throttle commit -m "courierops: cron sweep — select open Delhivery shipments, bulk-track, apply via RPC"
```

---

## Phase C — Depot UI (courier dropdown + timeline)

> File: `apps/depot/src/app/(auth)/dispatch-shipments/page.js`. Kit: `Icon`/`ToneBadge` from `../../../components/kit/index.js`. The Tracking panel + `trk` state already exist (E3, S165). Build: `npx turbo build --filter=@throttle/depot`.

### Task C1: Courier field → known-set dropdown

**Files:** Modify `apps/depot/src/app/(auth)/dispatch-shipments/page.js`.

- [ ] **Step 1: Add the courier constant** near the top-level styles (after the `trkInput` const):
```js
// Known couriers for the dropdown (decision #6) — canonical values the poller matches on
// (courierops polls courier_partner = 'Delhivery'). "Other" reveals a free-text field.
const COURIERS = ['Delhivery', 'Shiprocket', 'Other'];
```

- [ ] **Step 2: Replace the Courier free-text input** in the Tracking panel. Find:
```jsx
                      <div>
                        <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Courier</span>
                        <input style={trkInput} value={trk.courier_partner}
                          onChange={e => setTrk(t => ({ ...t, courier_partner: e.target.value }))} placeholder="e.g. Delhivery" />
                      </div>
```
Replace with (a dropdown; "Other" reveals a free-text input):
```jsx
                      <div>
                        <span className="eyebrow" style={{ display: 'block', marginBottom: 5 }}>Courier</span>
                        <select style={trkInput}
                          value={COURIERS.includes(trk.courier_partner) ? trk.courier_partner : (trk.courier_partner ? 'Other' : '')}
                          onChange={e => setTrk(t => ({ ...t, courier_partner: e.target.value === 'Other' ? '' : e.target.value }))}>
                          <option value="">Select courier…</option>
                          {COURIERS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        {!['Delhivery', 'Shiprocket', ''].includes(trk.courier_partner) && (
                          <input style={{ ...trkInput, marginTop: 6 }} value={trk.courier_partner}
                            onChange={e => setTrk(t => ({ ...t, courier_partner: e.target.value }))} placeholder="Courier name" />
                        )}
                        {trk.courier_partner === 'Delhivery' && (
                          <span style={{ display: 'block', marginTop: 4, fontSize: 10.5, color: 'var(--t3)' }}>
                            Auto-tracked every 30 min once an AWB is set.
                          </span>
                        )}
                      </div>
```
*(Note the dropdown's displayed value resolves "Other" when the stored string is a custom courier; selecting Delhivery/Shiprocket writes the canonical value courierops matches.)*

- [ ] **Step 3: Build**:
```bash
cd 05_Throttle && npx turbo build --filter=@throttle/depot
```
Expected: 1 successful.

- [ ] **Step 4: Commit**:
```bash
git -C 05_Throttle add apps/depot/src/app/\(auth\)/dispatch-shipments/page.js
git -C 05_Throttle commit -m "depot: courier field → known-set dropdown (Delhivery/Shiprocket/Other) for deterministic auto-tracking"
```

### Task C2: Tracking timeline in the detail drawer

**Files:** Modify `apps/depot/src/app/(auth)/dispatch-shipments/page.js`.

- [ ] **Step 1: Add stage presentation helpers** near `STATUS_TONE` (top of file):
```js
// Normalized courier stage → kit tone + human label (courierops tracking_status).
const STAGE_TONE = {
  manifested: 'info', in_transit: 'brand', out_for_delivery: 'warn', delivered: 'ok',
  undelivered: 'bad', rto_in_transit: 'warn', rto_delivered: 'mute', cancelled: 'bad', lost: 'bad', unknown: 'mute',
};
const STAGE_LABEL = {
  manifested: 'Manifested', in_transit: 'In transit', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', undelivered: 'Undelivered', rto_in_transit: 'RTO in transit',
  rto_delivered: 'RTO delivered', cancelled: 'Cancelled', lost: 'Lost', unknown: 'Unknown',
};
function relTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
```

- [ ] **Step 2: Render the timeline** immediately AFTER the Tracking panel's closing `)}` (right after the `</div>` that ends the `detailShipment.status !== 'cancelled' && trk && (...)` block, before the Manifest `<div className="label">…Manifest`):
```jsx
                {/* Courier tracking timeline (courierops). Read-only; current stage + full scan history. */}
                {Array.isArray(detailShipment.tracking_checkpoints) && detailShipment.tracking_checkpoints.length > 0 && (
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span className="label" style={{ fontSize: 11, color: 'var(--t2)' }}>Courier timeline</span>
                      {detailShipment.tracking_status && (
                        <ToneBadge tone={STAGE_TONE[detailShipment.tracking_status] || 'mute'}>
                          {STAGE_LABEL[detailShipment.tracking_status] || detailShipment.tracking_status}
                        </ToneBadge>
                      )}
                      <div style={{ flex: 1 }} />
                      {detailShipment.tracking_synced_at && (
                        <span className="num" style={{ fontSize: 10.5, color: 'var(--t3)' }}>updated {relTime(detailShipment.tracking_synced_at)}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                      {detailShipment.tracking_checkpoints.map((c, i) => (
                        <div key={i} style={{ display: 'flex', gap: 10, paddingBottom: 12 }}>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                            <span style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 4,
                              background: i === 0 ? 'var(--ok-fg)' : 'var(--border-2)' }} />
                            {i < detailShipment.tracking_checkpoints.length - 1 &&
                              <span style={{ width: 1, flex: 1, background: 'var(--border)', marginTop: 2 }} />}
                          </div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--t1)' }}>
                              {c.label || STAGE_LABEL[c.stage] || c.stage}
                            </div>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t3)' }}>
                              {c.location || '—'}{c.timestamp ? ` · ${formatDateTime(c.timestamp)}` : ''}
                            </div>
                            {c.description && (
                              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--t4)', marginTop: 1 }}>{c.description}</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
```

- [ ] **Step 3: Build**:
```bash
cd 05_Throttle && npx turbo build --filter=@throttle/depot
```
Expected: 1 successful.

- [ ] **Step 4: Commit**:
```bash
git -C 05_Throttle add apps/depot/src/app/\(auth\)/dispatch-shipments/page.js
git -C 05_Throttle commit -m "depot: courier tracking timeline in shipment drawer (stage badge + scan history + updated-ago)"
```

---

## Phase D — Snorkel UI (read-only timeline on the SO)

> File: `apps/snorkel/src/app/(auth)/sales/orders/detail/page.js`. The SO detail already maps `o.shipments[]` (lines ~177-189) showing courier/AWB/link/ETA/delivered. Build: `npx turbo build --filter=@throttle/snorkel`.
>
> **Prereq:** snorkelops `loadFulfilment` selects shipment columns explicitly (NOT `select=*`), so the new tracking columns must be added to that select first (Task D0) or `o.shipments[]` will never carry them.

### Task D0: snorkelops — surface the tracking columns on the SO read

**Files:** Modify `05_Throttle/snorkelops-worker/src/index.js` (the `loadFulfilment` shipment select, line ~290).

- [ ] **Step 1: Extend the shipment select.** Find:
```js
      `?fulfilment_request_id=in.(${reqIds.map(encodeURIComponent).join(',')})&select=id,shipment_no,status,scheduled_date,shipped_at,delivery_date,expected_delivery_date,courier_partner,tracking_number,tracking_link,fulfilment_request_id`);
```
Replace with (adds the four tracking cols):
```js
      `?fulfilment_request_id=in.(${reqIds.map(encodeURIComponent).join(',')})&select=id,shipment_no,status,scheduled_date,shipped_at,delivery_date,expected_delivery_date,courier_partner,tracking_number,tracking_link,tracking_status,tracking_stage_label,tracking_checkpoints,tracking_synced_at,fulfilment_request_id`);
```

- [ ] **Step 2: Commit + deploy** (snorkelops is single-system blast radius):
```bash
git -C 05_Throttle add snorkelops-worker/src/index.js
git -C 05_Throttle commit -m "snorkel: surface courier tracking cols (status/stage_label/checkpoints/synced_at) on the SO read"
git -C 05_Throttle push origin main
cd 05_Throttle/snorkelops-worker && npx wrangler deploy
```
Expected: deploys snorkelops; report the version id.

### Task D1: Per-shipment stage badge + timeline

**Files:** Modify `apps/snorkel/src/app/(auth)/sales/orders/detail/page.js`.

- [ ] **Step 1: Add stage label/tone helpers** near the top of the file (after imports, module scope):
```js
// Normalized courier stage (from courierops tracking_status) → label + colour for the SO timeline.
const STAGE_LABEL = {
  manifested: 'Manifested', in_transit: 'In transit', out_for_delivery: 'Out for delivery',
  delivered: 'Delivered', undelivered: 'Undelivered', rto_in_transit: 'RTO in transit',
  rto_delivered: 'RTO delivered', cancelled: 'Cancelled', lost: 'Lost', unknown: 'Unknown',
};
const STAGE_COLOR = {
  delivered: 'var(--green-fg, #2faa5a)', out_for_delivery: '#d98a00', in_transit: '#6af',
  undelivered: '#e2574c', rto_in_transit: '#d98a00', rto_delivered: '#9aa', cancelled: '#e2574c',
  lost: '#e2574c', manifested: '#6af', unknown: '#9aa',
};
```

- [ ] **Step 2: Render the timeline per shipment.** Find the per-shipment block that renders courier/AWB/etc (the `o.shipments.map(s => (...))` body around line 181-189) and append, right after the line that shows `delivered` (`{s.delivery_date && <span>delivered {fmtDate(s.delivery_date)}</span>}`) and before that row's closing tag, add the stage badge + collapsible timeline:
```jsx
                    {s.tracking_status && (
                      <span style={{ padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                        color: '#fff', background: STAGE_COLOR[s.tracking_status] || '#9aa' }}>
                        {STAGE_LABEL[s.tracking_status] || s.tracking_status}
                      </span>
                    )}
```
Then, immediately after that shipment row's container closes, add the timeline list:
```jsx
                    {Array.isArray(s.tracking_checkpoints) && s.tracking_checkpoints.length > 0 && (
                      <div style={{ margin: '6px 0 4px 4px', borderLeft: '1px solid var(--border, #2a2a2a)', paddingLeft: 12 }}>
                        {s.tracking_checkpoints.map((c, i) => (
                          <div key={i} style={{ marginBottom: 7 }}>
                            <div style={{ fontSize: 12, color: 'var(--text-1, #eee)' }}>{c.label || STAGE_LABEL[c.stage] || c.stage}</div>
                            <div style={{ fontSize: 10.5, color: 'var(--text-3, #999)' }}>
                              {(c.location || '—')}{c.timestamp ? ` · ${fmtDate(c.timestamp)}` : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
```
*(Match the file's actual JSX nesting when placing these — the first snippet goes inside the per-shipment flex row alongside the existing spans; the timeline goes just below that row, still inside the `.map`.)*

- [ ] **Step 3: Build**:
```bash
cd 05_Throttle && npx turbo build --filter=@throttle/snorkel
```
Expected: 1 successful.

- [ ] **Step 4: Commit**:
```bash
git -C 05_Throttle add apps/snorkel/src/app/\(auth\)/sales/orders/detail/page.js
git -C 05_Throttle commit -m "snorkel: read-only courier stage badge + tracking timeline on the sales-order shipments panel"
```

---

## Phase E — Deploy, secrets, smoke, knowledge files

### Task E1: Set secrets + deploy courierops

- [ ] **Step 1: Push the monorepo** (apps auto-deploy; the worker does not):
```bash
git -C 05_Throttle push origin main
```

- [ ] **Step 2: Set secrets** (interactive — paste when prompted):
```bash
cd 05_Throttle/courierops-worker
npx wrangler secret put SUPABASE_SERVICE_KEY   # same sb_secret service key as lotopsproxy/odoops
npx wrangler secret put DELHIVERY_API_TOKEN    # Delhivery One → Settings → API Setup (production)
```
*(These prompt for input — they are NOT in wrangler.toml. The `wrangler secret put` action is the one thing in this plan that requires the operator; flag it to Afshaan.)*

- [ ] **Step 3: Deploy the worker**:
```bash
cd 05_Throttle/courierops-worker && npx wrangler deploy
```
Expected: deploys `courierops`, registers the `*/30 * * * *` cron; report the version id.

### Task E2: Live data-path smoke (needs ≥1 real in-flight Delhivery AWB)

- [ ] **Step 1: Confirm a target exists** — a `dispatch_shipments` row with `courier_partner='Delhivery'` and a real `tracking_number` (set one via the Depot drawer if needed). Verify via `execute_sql`:
```sql
SELECT id, shipment_no, tracking_number, tracking_status, tracking_synced_at
FROM public.dispatch_shipments WHERE courier_partner='Delhivery' AND tracking_number IS NOT NULL;
```

- [ ] **Step 2: Trigger the cron on demand**:
```bash
cd 05_Throttle/courierops-worker && npx wrangler dev --test-scheduled
# then in another shell: curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
```
(Or wait for the next :00/:30 tick.) Watch `npx wrangler tail courierops` for the `updated N of M` log.

- [ ] **Step 3: Assert the write** — re-run the Step 1 query; expect `tracking_status`, `tracking_synced_at`, and (for an in-transit AWB) `expected_delivery_date` populated, and `tracking_checkpoints` non-empty:
```sql
SELECT tracking_status, tracking_stage_label, tracking_synced_at, expected_delivery_date,
       jsonb_array_length(tracking_checkpoints) AS checkpoints
FROM public.dispatch_shipments WHERE tracking_number = '<the AWB>';
```

- [ ] **Step 4: Browser check** — open the shipment in Depot → the Courier timeline shows the stage + scans; open the linked SO in Snorkel → the read-only timeline + stage badge render.

- [ ] **Step 5: Regression** — confirm a shipment with a manually-set `delivery_date` and a non-Delhivery courier is untouched after a sweep (its `tracking_synced_at` stays null).

### Task E3: Knowledge files (workspace root repo)

- [ ] **Step 1: `CORE.md`** — add `courierops` to the Workers table-of-record (root CLAUDE.md lists workers; CORE has the schema map) and note the new `dispatch_shipments` tracking cols + `apply_courier_tracking` RPC.

- [ ] **Step 2: `systems/depot.md`** — add a "Courier tracking (courierops, S16x)" subsection: the worker, the 30-min poll, the courier dropdown, the timeline UI; cross-link the spec.

- [ ] **Step 3: `systems/snorkel.md`** — one line under the fulfilment flow: the SO shipments panel now shows the live courier stage + timeline (auto-filled by courierops).

- [ ] **Step 4: `BACKLOG.md`** — add the courierops V1 item as done-pending-smoke; add the V2 follow-on (webhooks + Shiprocket + Pitstop/returns).

- [ ] **Step 5: Update the root CLAUDE.md Workers table** — add the `courierops` row (`05_Throttle/courierops-worker/src/index.js` → courier tracking).

- [ ] **Step 6: Commit + push the root repo**:
```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add -A && git commit -m "knowledge: courierops courier-tracking service (V1, Delhivery polling + timeline)" && git push
```

---

## Self-review notes (coverage vs spec)
- §3 architecture (worker, headless, adapter/normalize split, secrets) → B1/B2/B3/B4/E1 ✓
- §3.1 normalized interface (TrackResult/stage enum) → B2 (`normalize.js`) ✓
- §4 data model (4 cols + RPC, EDD/delivery_date COALESCE) → A1 ✓
- §5 poll flow (select open, bulk 30, normalize, one RPC, terminal drop-out, 30-min cron, ≤30d) → B4 ✓
- §5.1 stage mapping (UD/DL/EOD-38/RTO/CN + raw codes preserved) → B2 `mapStage`/`checkpoint` ✓
- §6 UI timeline + stage (Depot floor + Snorkel read-only) → C2/D1 ✓; courier dropdown (#6) → C1 ✓
- §7 deferred (webhooks/Shiprocket/returns/on-demand) → not built; recorded in E3 BACKLOG ✓
- §8 verification (schema, adapter unit, live smoke, regression) → A1/B2/E2 ✓
- §9 risks (token rotation, manual-date safety via COALESCE, no sandbox) → A1 RPC + E1/E2 ✓
- Manual-override safety (poller never nulls a manual delivery_date) → A1 `COALESCE(u.delivery_date, s.delivery_date)` ✓
```
