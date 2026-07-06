# Podium Payouts Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-employee ledger of actual payouts (fixed · variable · one-time bonus · perk · other) in Podium — the system of record for people-cost that will later feed Odo SG&A — with a comp-gated entry UI, a variable calculator, monthly-fixed auto-generation, and an own-only employee self-view.

**Architecture:** One new table `podium.payouts` written only by the podiumops worker (service_role). Every salary path reuses the S195 vault chokepoint — cross-person reads/writes gate on the `comp_access` allow-list (`canComp`) and are audited to `comp_access_log`; the employee self-view is a parameter-less own-only path. The variable calculator and fixed auto-gen default their amounts from each person's current CTC `components` (from `compensation_events`); nothing here mutates the CTC ledger.

**Tech Stack:** Cloudflare Worker (`podiumops`, vanilla ESM JS, no unit-test harness — verify with `node --check` on a `.mjs` copy + `wrangler deploy` + live curl/SQL), Supabase Postgres (`podium` schema, migration via MCP `apply_migration`), Next.js static-export app (`apps/podium`, verified with `npx turbo build --filter=podium`).

**Project:** `jkxcnjabmrkteanzoofj`. Worker: `05_Throttle/podiumops-worker/src/index.js`. App: `05_Throttle/apps/podium`. Deploy worker: `cd 05_Throttle/podiumops-worker && npx wrangler deploy`. Spec: `docs/superpowers/specs/2026-07-06-podium-payouts-ledger-design.md`.

**Note on verification:** no local test runner. Replace "failing test → pass" with `node --check` (syntax), SQL assertions, `turbo build`, and a live comp-login smoke (Task 9). Commit per task.

**Forward-compat note:** The RazorpayX Payroll connector is deferred (their API is not yet enabled for the org). The `payouts.source` column (`'manual'|'variable_calc'|'fixed_autogen'`, extensible to `'razorpayx'`) means that connector will later just be another writer into this same table — nothing here is throwaway.

---

## Phase A — Database

### Task 1: `podium.payouts` table

**Files:** Migration via MCP `apply_migration`, name `podium_payouts_ledger_v1`.

- [ ] **Step 1: Apply the migration**

Use MCP `apply_migration`, project `jkxcnjabmrkteanzoofj`, name `podium_payouts_ledger_v1`:

```sql
CREATE TABLE IF NOT EXISTS podium.payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES podium.employees(id) ON DELETE CASCADE,
  payout_type    text NOT NULL CHECK (payout_type IN ('fixed','variable','one_time_bonus','perk','other')),
  period_type    text NOT NULL CHECK (period_type IN ('monthly','half_yearly','one_time')),
  period_key     text,
  period_start   date,
  period_end     date,
  target_amount  numeric,
  achievement_pct numeric,
  amount         numeric NOT NULL,
  currency       text NOT NULL DEFAULT 'INR',
  paid_on        date,
  note           text,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','variable_calc','fixed_autogen','razorpayx')),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- Full UNIQUE (not a partial index) so PostgREST upsert can infer it. NULL period_key
  -- rows (ad-hoc bonus/perk/other) stay unconstrained because NULLs are distinct in UNIQUE.
  CONSTRAINT payouts_period_uniq UNIQUE (employee_id, payout_type, period_key)
);
CREATE INDEX IF NOT EXISTS payouts_emp_idx    ON podium.payouts (employee_id);
CREATE INDEX IF NOT EXISTS payouts_period_idx ON podium.payouts (period_key);
ALTER TABLE podium.payouts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON podium.payouts TO service_role;
REVOKE ALL ON podium.payouts FROM anon, authenticated;
```

- [ ] **Step 2: Verify**

MCP `execute_sql`:
```sql
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE oid='podium.payouts'::regclass) AS rls_on,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='podium' AND table_name='payouts') AS cols,
  (SELECT count(*) FROM podium.payouts) AS rows;
```
Expected: `rls_on=true`, `cols=17`, `rows=0`.

- [ ] **Step 3: Round-trip smoke (insert + unique + cleanup)**

```sql
-- pick any active employee
WITH e AS (SELECT id FROM podium.employees WHERE status<>'exited' LIMIT 1)
INSERT INTO podium.payouts (employee_id, payout_type, period_type, period_key, amount, source)
SELECT e.id, 'fixed', 'monthly', '2099-01', 12345, 'manual' FROM e;
SELECT count(*) AS one FROM podium.payouts WHERE period_key='2099-01';
DELETE FROM podium.payouts WHERE period_key='2099-01';
```
Expected: insert ok, `one=1`, delete ok.

---

## Phase B — Worker (`05_Throttle/podiumops-worker/src/index.js`)

### Task 2: period + component helpers

**Files:** Modify `05_Throttle/podiumops-worker/src/index.js`.

- [ ] **Step 1: Add the helpers**

Insert immediately ABOVE the line `// ── Salary-access allow-list (super_admin only` (the block added in the vault build, just above `getCompAccess`):

```js
// ── Payouts ledger — period + component helpers ──────────────────────────────
// FY = Apr 1 – Mar 31. Half 1 = Apr–Sep, Half 2 = Oct–Mar. Monthly key 'YYYY-MM';
// half key 'FYaa-bb-H1|H2' (e.g. 'FY26-27-H1').
function periodMeta(key) {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // last day of month m
    return { period_type: 'monthly', period_start: `${key}-01`, period_end: end };
  }
  const hm = /^FY(\d{2})-(\d{2})-H([12])$/.exec(key);
  if (hm) {
    const sy = 2000 + Number(hm[1]);
    return Number(hm[3]) === 1
      ? { period_type: 'half_yearly', period_start: `${sy}-04-01`, period_end: `${sy}-09-30` }
      : { period_type: 'half_yearly', period_start: `${sy}-10-01`, period_end: `${sy + 1}-03-31` };
  }
  return { period_type: 'one_time', period_start: null, period_end: null };
}

// Latest non-bonus CTC components per employee id → { <empId>: componentsJsonb }.
// Batched (single query, IN filter) — no per-row awaits.
async function currentComponentsFor(empIds, env) {
  if (!empIds.length) return {};
  const r = await sb(
    `/rest/v1/compensation_events?employee_id=in.(${empIds.join(',')})&event_type=neq.one_time_bonus` +
    `&select=employee_id,components,effective_date,created_at&order=effective_date.desc,created_at.desc`,
    env,
  );
  const out = {};
  for (const row of (r.ok ? r.data || [] : [])) if (!out[row.employee_id]) out[row.employee_id] = row.components || {};
  return out;
}
```

- [ ] **Step 2: Syntax check**

Run: `cp 05_Throttle/podiumops-worker/src/index.js /tmp/pc.mjs && node --check /tmp/pc.mjs && echo ok && rm -f /tmp/pc.mjs`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js && git commit -m "podium: payouts period + CTC-component helpers"
```

---

### Task 3: read handlers (getPayouts, getMyPayouts, getPayoutPeriodSheet)

**Files:** Modify `05_Throttle/podiumops-worker/src/index.js`.

- [ ] **Step 1: Add the handlers**

Insert immediately BELOW the `currentComponentsFor` helper you just added (before the `// ── Salary-access allow-list` block):

```js
// ── Payouts ledger — reads (comp = cross-person + audited; self = own-only) ───
const PAYOUT_ORDER = 'order=period_start.desc.nullslast,paid_on.desc.nullslast,created_at.desc';

async function getPayouts(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const employee_id = url.searchParams.get('employee_id');
  if (!employee_id) return err('employee_id required', 400);
  await logCompAccess(auth, 'getPayouts', employee_id, null, env);
  const r = await sb(`/rest/v1/payouts?employee_id=eq.${employee_id}&select=*&${PAYOUT_ORDER}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ payouts: r.data || [] });
}

async function getMyPayouts(url, auth, env) {
  const edges = await loadOrgEdges(env);
  const me = callerEmployee(edges, auth.userId);
  if (!me) return ok({ employee_id: null, payouts: [] });
  const r = await sb(`/rest/v1/payouts?employee_id=eq.${me.id}&select=*&${PAYOUT_ORDER}`, env);
  if (!r.ok) return err('db_error', 500);
  return ok({ employee_id: me.id, payouts: r.data || [] });
}

// The entry grid: every active employee for a period+type, with a defaulted target
// (from current CTC components) and any existing row. Comp-gated + audited.
async function getPayoutPeriodSheet(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const period_key = url.searchParams.get('period_key');
  const payout_type = url.searchParams.get('payout_type') || 'fixed';
  if (!period_key) return err('period_key required', 400);
  const meta = periodMeta(period_key);
  await logCompAccess(auth, 'getPayoutPeriodSheet', null, `${payout_type} ${period_key}`, env);
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,department:department_id(name)&order=full_name.asc`, env);
  const emps = er.ok ? (er.data || []) : [];
  const comps = await currentComponentsFor(emps.map(e => e.id), env);
  const xr = await sb(`/rest/v1/payouts?period_key=eq.${encodeURIComponent(period_key)}&payout_type=eq.${payout_type}&select=*`, env);
  const existing = {}; for (const row of (xr.ok ? xr.data || [] : [])) existing[row.employee_id] = row;
  const rows = emps.map(e => {
    const c = comps[e.id] || {};
    let target = null;
    if (payout_type === 'fixed') target = c.monthly_fixed ?? null;
    else if (payout_type === 'variable') {
      if (meta.period_type === 'monthly') target = c.monthly_variable ?? null;
      else if (meta.period_type === 'half_yearly') target = c.variable_yearly != null ? Number(c.variable_yearly) / 2 : null;
    }
    return {
      employee_id: e.id, employee_code: e.employee_code, full_name: e.full_name,
      department: e.department?.name || null, bonus_type: c.bonus_type || null,
      default_target: target != null ? Number(target) : null,
      existing: existing[e.id] || null,
    };
  });
  return ok({ period_key, period_type: meta.period_type, payout_type, rows });
}
```

- [ ] **Step 2: Register in `GET_ACTIONS`**

Find `getCompensation, getMyCompensation,` in `GET_ACTIONS` and change to:
```js
  getCompensation, getMyCompensation,
  getPayouts, getMyPayouts, getPayoutPeriodSheet,
```

- [ ] **Step 3: Register `getMyPayouts` in `SELF_SERVE_GET`**

Find the self-serve line added in the vault build and extend it:
```js
  // Own-salary view — parameter-less, self-scoped by callerEmployee.
  'getMyCompensation', 'getMyPayouts',
```

- [ ] **Step 4: Syntax check**

Run: `cp 05_Throttle/podiumops-worker/src/index.js /tmp/pc.mjs && node --check /tmp/pc.mjs && echo ok && rm -f /tmp/pc.mjs`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js && git commit -m "podium: payouts read handlers (getPayouts/getMyPayouts/getPayoutPeriodSheet)"
```

---

### Task 4: write handlers (upsertPayouts, generateFixedPayouts, deletePayout)

**Files:** Modify `05_Throttle/podiumops-worker/src/index.js`.

- [ ] **Step 1: Add the handlers**

Insert immediately BELOW `getPayoutPeriodSheet` (still before the `// ── Salary-access allow-list` block):

```js
// ── Payouts ledger — writes (comp-gated) ─────────────────────────────────────
async function upsertPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const inRows = Array.isArray(d.rows) ? d.rows : [];
  if (!inRows.length) return err('rows required', 400);
  const clean = [];
  for (const r of inRows) {
    if (!r.employee_id || !r.payout_type || r.amount == null || isNaN(Number(r.amount))) continue;
    const key = r.period_key || null;
    const meta = key ? periodMeta(key)
      : { period_type: r.period_type || 'one_time', period_start: r.period_start || null, period_end: r.period_end || null };
    clean.push({
      ...(r.id ? { id: r.id } : {}),
      employee_id: r.employee_id,
      payout_type: r.payout_type,
      period_type: meta.period_type,
      period_key: key,
      period_start: meta.period_start,
      period_end: meta.period_end,
      target_amount: r.target_amount != null ? Number(r.target_amount) : null,
      achievement_pct: r.achievement_pct != null ? Number(r.achievement_pct) : null,
      amount: Number(r.amount),
      currency: r.currency || 'INR',
      paid_on: r.paid_on || null,
      note: r.note || null,
      source: r.source || 'manual',
      created_by: auth.userId || null,
      updated_at: nowIso(),
    });
  }
  if (!clean.length) return err('no valid rows', 400);
  const periodic = clean.filter(r => r.period_key);
  const adhoc = clean.filter(r => !r.period_key);
  let saved = 0;
  if (periodic.length) {
    const r = await sb(`/rest/v1/payouts?on_conflict=employee_id,payout_type,period_key`, env, {
      method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(periodic),
    });
    if (!r.ok) return err('upsert_failed: ' + JSON.stringify(r.data), 400);
    saved += periodic.length;
  }
  if (adhoc.length) {
    const r = await sb(`/rest/v1/payouts`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(adhoc) });
    if (!r.ok) return err('insert_failed: ' + JSON.stringify(r.data), 400);
    saved += adhoc.length;
  }
  await logCompAccess(auth, 'upsertPayouts', null, `${saved} rows`, env);
  return ok({ saved });
}

// Auto-create a month's FIXED rows for active staff from current monthly_fixed.
// Idempotent — skips employees who already have a fixed row for the month.
async function generateFixedPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const period_key = d.period_key;
  if (!period_key || !/^\d{4}-\d{2}$/.test(period_key)) return err('period_key (YYYY-MM) required', 400);
  const meta = periodMeta(period_key);
  const er = await sb(`/rest/v1/employees?status=neq.exited&select=id`, env);
  const emps = er.ok ? (er.data || []) : [];
  const comps = await currentComponentsFor(emps.map(e => e.id), env);
  const xr = await sb(`/rest/v1/payouts?period_key=eq.${encodeURIComponent(period_key)}&payout_type=eq.fixed&select=employee_id`, env);
  const have = new Set((xr.ok ? xr.data || [] : []).map(r => r.employee_id));
  const rows = [];
  for (const e of emps) {
    if (have.has(e.id)) continue;
    const mf = comps[e.id]?.monthly_fixed;
    if (mf == null) continue;
    rows.push({
      employee_id: e.id, payout_type: 'fixed', period_type: 'monthly', period_key,
      period_start: meta.period_start, period_end: meta.period_end,
      target_amount: Number(mf), amount: Number(mf), currency: 'INR',
      source: 'fixed_autogen', created_by: auth.userId || null,
    });
  }
  if (rows.length) {
    const r = await sb(`/rest/v1/payouts`, env, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(rows) });
    if (!r.ok) return err('generate_failed: ' + JSON.stringify(r.data), 400);
  }
  await logCompAccess(auth, 'generateFixedPayouts', null, `${period_key}: +${rows.length}`, env);
  return ok({ created: rows.length, skipped: have.size });
}

async function deletePayout(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  if (!d.id) return err('id required', 400);
  const r = await sb(`/rest/v1/payouts?id=eq.${encodeURIComponent(d.id)}`, env, { method: 'DELETE', prefer: 'return=minimal' });
  if (!r.ok) return err('delete_failed', 400);
  await logCompAccess(auth, 'deletePayout', null, d.id, env);
  return ok({ deleted: d.id });
}
```

- [ ] **Step 2: Register in `POST_ACTIONS`**

Find `addCompAccess, removeCompAccess,` in `POST_ACTIONS` and insert above that line:
```js
  // Payouts ledger (comp-gated)
  upsertPayouts, generateFixedPayouts, deletePayout,
  // Salary-access allow-list (super_admin)
  addCompAccess, removeCompAccess,
```

- [ ] **Step 3: Syntax check**

Run: `cp 05_Throttle/podiumops-worker/src/index.js /tmp/pc.mjs && node --check /tmp/pc.mjs && echo ok && rm -f /tmp/pc.mjs`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js && git commit -m "podium: payouts write handlers (upsert batch / generate-fixed idempotent / delete)"
```

---

### Task 5: deploy + smoke

**Files:** none.

- [ ] **Step 1: Push + deploy**

```bash
cd 05_Throttle && git push
cd 05_Throttle/podiumops-worker && npx wrangler deploy
```
Expected: deploy prints a version id.

- [ ] **Step 2: Unauth smoke (auth runs first, so all 401)**

```bash
B="https://podiumops.afshaan.workers.dev"
for a in getPayouts getMyPayouts getPayoutPeriodSheet; do
  echo "$a: $(curl -s -o /dev/null -w '%{http_code}' "$B/?action=$a")"; done
```
Expected: each prints `401`. (Functional checks need a comp login — Task 9.)

---

## Phase C — App (`05_Throttle/apps/podium`)

### Task 6: shared lib + employee self-view on `/me`

**Files:**
- Create: `05_Throttle/apps/podium/src/lib/payouts.js`
- Create: `05_Throttle/apps/podium/src/components/MyPayouts.js`
- Modify: `05_Throttle/apps/podium/src/app/(auth)/me/page.js`

- [ ] **Step 1: Create `lib/payouts.js`**

```js
// Period-key helpers + labels shared by the payouts UI. Mirrors the worker's periodMeta.
export const PAYOUT_TYPES = [
  { key: 'fixed', label: 'Fixed' },
  { key: 'variable', label: 'Variable' },
  { key: 'one_time_bonus', label: 'One-time Bonus' },
  { key: 'perk', label: 'Perk' },
  { key: 'other', label: 'Other' },
];
export const payoutTypeLabel = (k) => (PAYOUT_TYPES.find((t) => t.key === k)?.label || k);

export const fmtINR = (n) => (n == null || n === '' ? '—' : '₹' + Number(n).toLocaleString('en-IN'));

// Fiscal year that a JS Date falls in (Apr–Mar). Returns the start calendar year.
export function fyStartYear(d) {
  const dt = d ? new Date(d) : new Date(2026, 6, 1);
  return dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
}
export function halfKey(startYear, half) {
  return `FY${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}-H${half}`;
}
export const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
export function periodLabel(key) {
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  }
  const hm = /^FY(\d{2})-(\d{2})-H([12])$/.exec(key);
  if (hm) return `FY${hm[1]}-${hm[2]} · H${hm[3]} (${hm[3] === '1' ? 'Apr–Sep' : 'Oct–Mar'})`;
  return key || 'Ad-hoc';
}
```

- [ ] **Step 2: Create `components/MyPayouts.js`**

```js
'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Wallet } from 'lucide-react';
import { podiumopsGet } from '../lib/podiumopsFetch.js';
import { fmtINR, payoutTypeLabel, periodLabel } from '../lib/payouts.js';

// Own payouts only (getMyPayouts is parameter-less + self-scoped in the worker).
export default function MyPayouts() {
  const { session } = useAuth();
  const [d, setD] = useState(null);
  useEffect(() => { if (session) podiumopsGet('getMyPayouts', {}, session).then(setD).catch(() => setD(false)); }, [session]);
  if (!d || d === false || !d.payouts?.length) return null;
  return (
    <div style={card}>
      <div style={cardTitle}><Wallet size={14} /> My Payouts</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {d.payouts.map((p) => (
          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, color: 'var(--t2)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
            <span>{payoutTypeLabel(p.payout_type)}{p.period_key ? ' · ' + periodLabel(p.period_key) : ''}{p.achievement_pct != null ? ` · ${p.achievement_pct}%` : ''}</span>
            <span className="num" style={{ color: 'var(--t1)' }}>{fmtINR(p.amount)}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11, color: 'var(--t3)', marginTop: 10 }}>Only you and authorised Finance can see this.</p>
    </div>
  );
}
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px', marginTop: 14 };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
```

- [ ] **Step 3: Mount on `/me`**

In `05_Throttle/apps/podium/src/app/(auth)/me/page.js`, add the import beside the `MyCompensation` import:
```js
import MyCompensation from '../../../components/MyCompensation.js';
import MyPayouts from '../../../components/MyPayouts.js';
```
And render it right after `<MyCompensation />`:
```js
      <MyCompensation />
      <MyPayouts />
```

- [ ] **Step 4: Build**

Run: `cd 05_Throttle && npx turbo build --filter=podium`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
cd 05_Throttle && git add apps/podium/src/lib/payouts.js apps/podium/src/components/MyPayouts.js "apps/podium/src/app/(auth)/me/page.js" && git commit -m "podium: My Payouts self-view on /me + payouts lib"
```

---

### Task 7: comp-gated Payouts panel on `/people/detail`

**Files:**
- Create: `05_Throttle/apps/podium/src/components/PayoutsPanel.js`
- Modify: `05_Throttle/apps/podium/src/app/(auth)/people/detail/page.js`

- [ ] **Step 1: Create `components/PayoutsPanel.js`**

```js
'use client';
import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { podiumopsGet } from '../lib/podiumopsFetch.js';
import { fmtINR, payoutTypeLabel, periodLabel } from '../lib/payouts.js';

// A person's full payout history. Self-hides unless the caller is comp (worker 403s).
export default function PayoutsPanel({ employeeId, session }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (session && employeeId) podiumopsGet('getPayouts', { employee_id: employeeId }, session).then(setD).catch(() => setD(false));
  }, [session, employeeId]);
  if (d === false || d === null) return null;
  const rows = d.payouts || [];
  return (
    <div style={card}>
      <div style={cardTitle}><Wallet size={14} /> Payouts</div>
      {rows.length === 0 ? <div style={{ color: 'var(--t3)', fontSize: 13 }}>No payouts recorded.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, color: 'var(--t2)', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
              <span>{payoutTypeLabel(p.payout_type)}{p.period_key ? ' · ' + periodLabel(p.period_key) : ''}{p.achievement_pct != null ? ` · ${p.achievement_pct}%` : ''}{p.paid_on ? ` · paid ${p.paid_on}` : ''}</span>
              <span className="num" style={{ color: 'var(--t1)' }}>{fmtINR(p.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px', marginTop: 14 };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
```

- [ ] **Step 2: Mount on the profile**

Open `05_Throttle/apps/podium/src/app/(auth)/people/detail/page.js`. Read it to find where the compensation section renders (look for `getCompensation` / `can_see_comp` / a comp tab). Add the import at top:
```js
import PayoutsPanel from '../../../../components/PayoutsPanel.js';
```
Render `<PayoutsPanel employeeId={<the profile employee id variable>} session={session} />` in the same place the compensation info shows (it self-hides for non-comp, so no extra gating needed). Use the page's existing employee-id variable (commonly `emp.id` / `employee.id` / the `id` from the query string) and its `session` from `useAuth()`.

- [ ] **Step 3: Build**

Run: `cd 05_Throttle && npx turbo build --filter=podium`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
cd 05_Throttle && git add apps/podium/src/components/PayoutsPanel.js "apps/podium/src/app/(auth)/people/detail/page.js" && git commit -m "podium: Payouts panel on person profile (comp-gated, self-hiding)"
```

---

### Task 8: `/admin/payouts` entry page + nav

**Files:**
- Create: `05_Throttle/apps/podium/src/app/(auth)/admin/payouts/page.js`
- Modify: `05_Throttle/apps/podium/src/lib/nav.js`

- [ ] **Step 1: Create the page**

Create `05_Throttle/apps/podium/src/app/(auth)/admin/payouts/page.js`:

```js
'use client';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Wallet, Sparkles } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { fmtINR, monthKey, halfKey, fyStartYear, periodLabel } from '../../../../lib/payouts.js';

const FY = fyStartYear();                          // current fiscal year start
const MONTHS = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = m >= 4 ? FY : FY + 1; return monthKey(y, m); });

export default function PayoutsAdminPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState('fixed');         // fixed | variable | adhoc
  const [period, setPeriod] = useState(MONTHS[new Date().getMonth() >= 3 ? new Date().getMonth() - 3 : new Date().getMonth() + 9]);
  const [half, setHalf] = useState(halfKey(FY, 1));
  const [sheet, setSheet] = useState(null);        // null=loading, false=forbidden
  const [edits, setEdits] = useState({});          // employee_id → {pct, amount, note}
  const [busy, setBusy] = useState(false);

  const periodKey = tab === 'variable' ? half : period;
  const load = () => {
    setSheet(null); setEdits({});
    if (!session) return;
    const type = tab === 'adhoc' ? 'other' : tab;
    podiumopsGet('getPayoutPeriodSheet', { period_key: periodKey, payout_type: type }, session)
      .then(setSheet).catch(() => setSheet(false));
  };
  useEffect(load, [session, tab, period, half]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sheet === false) return <div style={{ color: 'var(--t3)' }}>Requires salary access.</div>;

  async function generateFixed() {
    setBusy(true);
    try { const r = await podiumopsPost('generateFixedPayouts', { period_key: period }, session); showToast(`Generated ${r.created}, skipped ${r.skipped}`, 'success'); load(); }
    catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true);
    try {
      const rows = [];
      for (const row of (sheet?.rows || [])) {
        const e = edits[row.employee_id]; if (!e) continue;
        const target = row.default_target;
        let amount = e.amount != null && e.amount !== '' ? Number(e.amount)
          : (tab === 'variable' && e.pct != null && e.pct !== '' && target != null) ? Math.round(target * Number(e.pct)) / 100
          : (tab === 'fixed' ? target : null);
        if (amount == null || isNaN(amount)) continue;
        rows.push({
          employee_id: row.employee_id, payout_type: tab === 'adhoc' ? (e.type || 'other') : tab,
          period_key: tab === 'adhoc' ? null : periodKey,
          period_type: tab === 'adhoc' ? 'one_time' : undefined,
          target_amount: tab === 'variable' ? target : (tab === 'fixed' ? target : null),
          achievement_pct: tab === 'variable' && e.pct !== '' ? Number(e.pct) : null,
          amount, paid_on: e.paid_on || null, note: e.note || null,
          source: tab === 'variable' ? 'variable_calc' : 'manual',
        });
      }
      if (!rows.length) { showToast('Nothing to save', 'error'); return; }
      const r = await podiumopsPost('upsertPayouts', { rows }, session);
      showToast(`Saved ${r.saved}`, 'success'); load();
    } catch (e) { showToast(e.message || 'Failed', 'error'); } finally { setBusy(false); }
  }

  const setEdit = (id, patch) => setEdits((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  const visibleRows = useMemo(() => {
    const rows = sheet?.rows || [];
    if (tab !== 'variable') return rows;
    const want = sheet?.period_type; // monthly | half_yearly
    return rows.filter((r) => (r.bonus_type === 'Monthly' ? 'monthly' : r.bonus_type === 'Half-Yearly' ? 'half_yearly' : null) === want);
  }, [sheet, tab]);

  return (
    <div style={{ maxWidth: 920 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {['fixed', 'variable', 'adhoc'].map((t) => (
          <div key={t} className={'pd-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)} style={{ textTransform: 'capitalize' }}>{t === 'adhoc' ? 'Ad-hoc' : t}</div>
        ))}
      </div>

      {tab === 'variable' ? (
        <select value={half} onChange={(e) => setHalf(e.target.value)} className="pd-input" style={sel}>
          {[1, 2].map((h) => <option key={h} value={halfKey(FY, h)}>{periodLabel(halfKey(FY, h))}</option>)}
        </select>
      ) : (
        <select value={period} onChange={(e) => setPeriod(e.target.value)} className="pd-input" style={sel}>
          {MONTHS.map((k) => <option key={k} value={k}>{periodLabel(k)}</option>)}
        </select>
      )}
      {tab === 'fixed' && <button onClick={generateFixed} disabled={busy} style={{ ...btn, marginLeft: 8 }}><Sparkles size={13} /> Generate month from CTC</button>}

      {sheet === null ? <Spinner /> : (
        <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
          {visibleRows.map((row) => {
            const e = edits[row.employee_id] || {};
            const existing = row.existing;
            const computed = tab === 'variable' && e.pct != null && e.pct !== '' && row.default_target != null
              ? Math.round(row.default_target * Number(e.pct)) / 100 : null;
            return (
              <div key={row.employee_id} style={gridRow}>
                <div style={{ flex: 2 }}>
                  <div style={{ color: 'var(--t1)', fontSize: 13.5 }}>{row.full_name}</div>
                  <div style={{ color: 'var(--t3)', fontSize: 11 }}>{row.department || '—'}{row.bonus_type ? ' · ' + row.bonus_type : ''}{existing ? ' · saved ' + fmtINR(existing.amount) : ''}</div>
                </div>
                {tab === 'adhoc' ? (
                  <>
                    <select value={e.type || 'other'} onChange={(ev) => setEdit(row.employee_id, { type: ev.target.value })} className="pd-input" style={{ ...cell, flex: 1 }}>
                      <option value="one_time_bonus">Bonus</option><option value="perk">Perk</option><option value="other">Other</option>
                    </select>
                    <input placeholder="amount" value={e.amount ?? ''} onChange={(ev) => setEdit(row.employee_id, { amount: ev.target.value })} className="pd-input" style={cell} />
                    <input type="date" value={e.paid_on || ''} onChange={(ev) => setEdit(row.employee_id, { paid_on: ev.target.value })} className="pd-input" style={cell} />
                  </>
                ) : tab === 'variable' ? (
                  <>
                    <span className="num" style={{ ...hint }}>target {fmtINR(row.default_target)}</span>
                    <input placeholder="%" value={e.pct ?? (existing?.achievement_pct ?? '')} onChange={(ev) => setEdit(row.employee_id, { pct: ev.target.value })} className="pd-input" style={{ ...cell, width: 70 }} />
                    <span className="num" style={{ ...hint, color: 'var(--t1)' }}>{fmtINR(computed ?? existing?.amount ?? null)}</span>
                  </>
                ) : (
                  <input placeholder="amount" value={e.amount ?? (existing?.amount ?? row.default_target ?? '')} onChange={(ev) => setEdit(row.employee_id, { amount: ev.target.value })} className="pd-input" style={{ ...cell, width: 130 }} />
                )}
                <input placeholder="note" value={e.note ?? (existing?.note || '')} onChange={(ev) => setEdit(row.employee_id, { note: ev.target.value })} className="pd-input" style={{ ...cell, flex: 1 }} />
              </div>
            );
          })}
          {visibleRows.length === 0 && <div style={{ padding: 16, color: 'var(--t3)' }}>No eligible people for this period.</div>}
        </div>
      )}

      <button onClick={save} disabled={busy || sheet === null} style={{ ...btn, marginTop: 14 }}><Wallet size={14} /> Save</button>
    </div>
  );
}

const sel = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontSize: 13 };
const cell = { background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '6px 8px', fontSize: 12.5 };
const hint = { fontSize: 12, color: 'var(--t3)', minWidth: 90, textAlign: 'right' };
const gridRow = { display: 'flex', gap: 8, alignItems: 'center', padding: '9px 12px', borderTop: '1px solid var(--border)' };
const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--yellow)', color: '#1a1a1a', border: 'none', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
```

- [ ] **Step 2: Add the nav entry**

Open `05_Throttle/apps/podium/src/lib/nav.js`. Find the admin group entry for Settings (`route: '/admin/settings'`, `requires: 'podium_admin'`). Add, next to it in the same group, following the exact object shape used there:
```js
{ id: 'payouts', label: 'Payouts', route: '/admin/payouts', requires: 'podium_admin', icon: Wallet },
```
If `Wallet` isn't already imported from `lucide-react` at the top of `nav.js`, add it to that import. (The page enforces `comp` server-side; the nav gate on `podium_admin` just controls who sees the link — the comp group are all podium_admins today.)

- [ ] **Step 3: Build**

Run: `cd 05_Throttle && npx turbo build --filter=podium`
Expected: zero errors. Fix any unused-import lint before continuing.

- [ ] **Step 4: Commit + push (auto-deploys)**

```bash
cd 05_Throttle && git add "apps/podium/src/app/(auth)/admin/payouts/page.js" apps/podium/src/lib/nav.js && git commit -m "podium: /admin/payouts entry (fixed autogen / variable calc / ad-hoc) + nav" && git push
```

---

## Phase D — Live verify + knowledge

### Task 9: live smoke (needs a comp login)

**Files:** none (browser, with Afshaan).

- [ ] **Step 1:** After the app deploy (~3–4 min), as a comp-group member open `/admin/payouts`:
  - Fixed tab → pick the current month → "Generate month from CTC" → a grid of ~52 people appears with their monthly_fixed prefilled → adjust one → Save.
  - Variable tab → pick H1/H2 → only Half-Yearly people show (Monthly people appear under a month you pick on the variable cadence — verify the cadence filter) → enter a `%` → payout computes → Save.
  - Ad-hoc tab → enter a bonus amount + date for one person → Save.
- [ ] **Step 2:** Confirm the rows landed:
```sql
SELECT payout_type, period_key, count(*), to_char(sum(amount),'FM99,99,99,999') AS total
FROM podium.payouts GROUP BY payout_type, period_key ORDER BY 2,1;
```
- [ ] **Step 3:** As that person (or check via SQL) confirm `/me` "My Payouts" shows only their own rows; as a non-comp user confirm no Payouts panel on a profile and no `/admin/payouts` access (403 → "Requires salary access").
- [ ] **Step 4:** Confirm audit rows exist:
```sql
SELECT action, count(*) FROM podium.comp_access_log WHERE action LIKE '%Payout%' OR action IN ('upsertPayouts','generateFixedPayouts','deletePayout','getPayouts') GROUP BY action;
```

### Task 10: knowledge

**Files:** `systems/podium.md`, memory, `BACKLOG.md`.

- [ ] **Step 1:** `systems/podium.md` — add `podium.payouts` to the DB section; add the worker actions (`getPayouts`/`getMyPayouts`/`getPayoutPeriodSheet`/`upsertPayouts`/`generateFixedPayouts`/`deletePayout`); note the ledger is the SG&A source-of-truth (vs factory_pay = COGS), all comp-gated + audited + self-view; bump `Last updated`.
- [ ] **Step 2:** Memory — extend `[[project_podium_salary_vault]]` (or a new `project_podium_payouts_ledger`) with: the ledger table, types, cadence-from-bonus_type, fixed auto-gen, `source` field forward-compat for RazorpayX. Update `MEMORY.md` pointer.
- [ ] **Step 3:** `BACKLOG.md` [podium] — add two items: **(a) RazorpayX Payroll connector (blocked — API not enabled for the org; request via xpayroll@razorpay.com; then build on the Odo `ConnectorWorkflow` pattern, `source='razorpayx'`, read-only scopes, per-entity keys Fraternitas+Silverton, identity-match by work email).** **(b) Phase 2 — Odo SG&A feed** (read Podium payout aggregates into the P&L; accrual by `period_key` vs cash by `paid_on`).
- [ ] **Step 4:** Commit + push root:
```bash
cd /Users/afshaansiddiqui/Documents/Claude && git add systems/podium.md BACKLOG.md memory/ && git commit -m "podium: payouts ledger live — actuals system of record (SG&A source); RazorpayX connector logged as blocked" && git push
```

---

## Self-review (author)

- **Spec coverage:** §3 table → Task 1. §4 cadence/periods → Task 2 (`periodMeta`) + defaulting in Task 3. §5 access/audit → every handler gates `requireComp` / self path + `logCompAccess`; Task 1 RLS. §6 actions → Tasks 3–4 (all six). §7 app → Tasks 6 (/me + lib), 7 (profile panel), 8 (/admin/payouts + nav). §9 invariants → batch upsert (Task 4), idempotent generate (Task 4), no id on self path (Task 3). §11 Phase 2 → Task 10 backlog.
- **Deviation from spec:** spec §3 wrote a *partial* unique index; the plan uses a full `UNIQUE` constraint instead so PostgREST upsert can infer it — behaviour is identical (NULL `period_key` rows stay unconstrained because NULLs are distinct in UNIQUE). Noted in Task 1.
- **Type consistency:** handler names match registrations (`getPayouts`/`getMyPayouts`/`getPayoutPeriodSheet`/`upsertPayouts`/`generateFixedPayouts`/`deletePayout`); `periodMeta`/`currentComponentsFor` defined in Task 2 and used in Tasks 3–4; app calls the exact action names; `lib/payouts.js` helpers (`fmtINR`/`payoutTypeLabel`/`periodLabel`/`halfKey`/`monthKey`/`fyStartYear`) used consistently in Tasks 6–8.
- **No placeholders:** every code/SQL/command step is concrete; the two "read the file to find the mount point" steps (profile page, nav.js) name the exact anchor to match.
