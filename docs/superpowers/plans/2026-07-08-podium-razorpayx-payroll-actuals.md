# Podium ← RazorpayX Payroll actuals feed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull each month's actual RazorpayX Payroll gross earnings per employee into `podium.payouts` (`source='razorpayx'`), on-demand and review-and-confirm, so the SG&A actuals ledger + Analytics plan-vs-actual trend become real.

**Architecture:** New comp-gated read/write actions on the `podiumops` Cloudflare Worker call the RazorpayX Payroll REST API (auth in the JSON body). A **map** action resolves RazorpayX↔Podium employees by `work_email` (persisting the RazorpayX id), an **amounts** action fetches `view-payroll` in client-orchestrated ≤40-employee chunks (50-subrequest limit), and an **apply** action upserts `payouts`. A modal on `/admin/payouts` drives preview → confirm. Fraternitas (white-collar) only; Silverton (blue-collar contract) is excluded (stays bulk-vendor/COGS).

**Tech Stack:** Cloudflare Workers (JS, `05_Throttle/podiumops-worker`), Supabase/PostgREST (`podium` schema, service_role), Next static-export app (`apps/podium`, React), `@throttle/ui`/`auth`.

**Spec:** `docs/superpowers/specs/2026-07-08-podium-razorpayx-payroll-actuals-design.md`

**Verification model (LOT-adapted, not pytest):** the worker has no unit-test harness. Each worker task is verified by (a) `node --check` on the file, (b) deploy `cd 05_Throttle/podiumops-worker && npx wrangler deploy`, (c) a `curl` smoke against the deployed worker or a live browser action; migrations via the Supabase MCP `apply_migration` + an `information_schema` read; the app via `npx turbo build --filter=podium`.

---

## Task 0: Set RazorpayX secrets on podiumops (Afshaan-gated — blocks probe/live only)

**Files:** none (Cloudflare secrets).

- [ ] **Step 1: Ask Afshaan to set both secrets** (each prompts — `wrangler secret put` is a deliberate ask-permission guardrail):

```bash
cd 05_Throttle/podiumops-worker
npx wrangler secret put RAZORPAYX_PAYROLL_ID
npx wrangler secret put RAZORPAYX_PAYROLL_KEY
```

(Afshaan pastes the API ID and API key from the RazorpayX Payroll dashboard. Never ask him to paste values into chat.)

- [ ] **Step 2: Confirm they're registered**

Run: `cd 05_Throttle/podiumops-worker && npx wrangler secret list`
Expected: output lists `RAZORPAYX_PAYROLL_ID` and `RAZORPAYX_PAYROLL_KEY`.

> Code tasks 2–6 do NOT depend on this (everything is graceful-until-creds). Only the probe (Task 1) and the live smoke (Task 7) need the secrets set.

---

## Task 1: Probe the RazorpayX response shape → lock the field mapping

Purpose: confirm the exact `get-employees` and `view-payroll` JSON field names before writing the parser. Runs locally with Afshaan's creds via env vars (keeps values off git/chat).

**Files:**
- Create: `<scratchpad>/rzp-probe.mjs` (throwaway; not committed)

- [ ] **Step 1: Write the probe script**

```javascript
// rzp-probe.mjs — run:  RZP_ID=... RZP_KEY=... EMP_ID=<one razorpayx employee id> MONTH=2026-06 node rzp-probe.mjs
const BASE = 'https://payroll.razorpay.com/api/payroll';
const auth = { id: process.env.RZP_ID, key: process.env.RZP_KEY };

async function call(type, subType, data) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth, request: { type, 'sub-type': subType }, data: data || {} }),
  });
  const text = await res.text();
  console.log(`\n=== ${type}/${subType} → HTTP ${res.status} ===`);
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
}

// 1) list employees (to learn id/email/name field names + confirm it's bulk)
await call('employee', 'get-employees', {});
// 2) one month's payroll for one employee (to learn gross/net/deduction field names)
await call('payroll', 'view-payroll', { 'employee-id': Number(process.env.EMP_ID), 'payroll-month': process.env.MONTH });
```

- [ ] **Step 2: Run it and read the raw shapes**

Run (Afshaan exports the creds, or exports them in the shell first): `RZP_ID=… RZP_KEY=… EMP_ID=… MONTH=2026-06 node <scratchpad>/rzp-probe.mjs`
Expected: two JSON blocks. Record from them:
  - **employee list:** the array path + the fields for RazorpayX employee **id**, **email**, **name** (and the `request:{type,sub-type}` that actually worked — the exact `get-employees` naming may differ; adjust if HTTP≠200).
  - **view-payroll:** the field holding **gross monthly earnings**, **net pay**, the **deductions** breakdown, and the **payroll/payslip id** + **disbursal date**.

- [ ] **Step 3: Write the confirmed mapping into this plan**

Fill this table from Step 2 output (used verbatim by Tasks 3 & 4). If gross isn't a single field, set `GROSS = net + Σ(employee deductions)`.

```
EMP_LIST_ARRAY_PATH  = <e.g. data.employees>
EMP_ID_FIELD         = <e.g. id>
EMP_EMAIL_FIELD      = <e.g. email>
EMP_NAME_FIELD       = <e.g. name>
PAYROLL_GROSS_FIELD  = <e.g. gross_earnings>   (or net+deductions reconstruction)
PAYROLL_NET_FIELD    = <e.g. net_pay>
PAYROLL_PAIDON_FIELD = <e.g. payroll_month / disbursed_on>
PAYROLL_ID_FIELD     = <e.g. payroll_id>
```

- [ ] **Step 4: Delete the probe script** (`rm <scratchpad>/rzp-probe.mjs`). Nothing to commit.

---

## Task 2: Migrations — add the mapping + source_ref columns

**Files:** Supabase migrations (via MCP `apply_migration`), schema `podium`.

- [ ] **Step 1: Apply the employee-id mapping column**

Use the Supabase MCP `apply_migration` (name `podium_employee_razorpayx_id_v1`):

```sql
ALTER TABLE podium.employees ADD COLUMN IF NOT EXISTS razorpayx_employee_id text;
CREATE UNIQUE INDEX IF NOT EXISTS employees_razorpayx_employee_id_uidx
  ON podium.employees (razorpayx_employee_id)
  WHERE razorpayx_employee_id IS NOT NULL;
```

- [ ] **Step 2: Apply the payouts source_ref column**

`apply_migration` (name `podium_payouts_source_ref_v1`):

```sql
ALTER TABLE podium.payouts ADD COLUMN IF NOT EXISTS source_ref text;
```

- [ ] **Step 3: Verify both columns exist**

Use MCP `execute_sql`:

```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='podium'
  AND ((table_name='employees' AND column_name='razorpayx_employee_id')
    OR (table_name='payouts'   AND column_name='source_ref'));
```

Expected: two rows returned.

- [ ] **Step 4: Refresh the schema snapshot**

Run the `/schema-sync` skill (regenerates `reference/db-schema.md`), then commit at workspace root:

```bash
cd /Users/afshaansiddiqui/Documents/Claude && git add reference/db-schema.md && git commit -m "schema: podium razorpayx_employee_id + payouts.source_ref (S200)"
```

---

## Task 3: Worker — RazorpayX client helper + employee map action

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`

- [ ] **Step 1: Add the client helper + config guard** (insert near the other integration helpers, e.g. just after `googleConfigured`/`googleAccessToken` around line 179–210)

```javascript
// ── RazorpayX Payroll (Opfin) ────────────────────────────────────────────────
// Auth lives in the JSON body, not a header. Graceful-until-creds: if either
// secret is absent, callers return razorpayx_not_configured (mirrors Google SA).
const RZP_PAYROLL_BASE = 'https://payroll.razorpay.com/api/payroll';
function razorpayxConfigured(env) { return !!(env.RAZORPAYX_PAYROLL_ID && env.RAZORPAYX_PAYROLL_KEY); }

async function razorpayxCall(env, type, subType, data) {
  const res = await fetch(RZP_PAYROLL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: { id: env.RAZORPAYX_PAYROLL_ID, key: env.RAZORPAYX_PAYROLL_KEY },
      request: { type, 'sub-type': subType },
      data: data || {},
    }),
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// Fetch the full RazorpayX employee roster (id + email + name). Field paths per Task 1.
async function fetchRazorpayxEmployees(env) {
  const r = await razorpayxCall(env, 'employee', 'get-employees', {});
  if (!r.ok) throw new Error(`razorpayx get-employees ${r.status}: ${JSON.stringify(r.body)?.slice(0, 300)}`);
  // TASK 1 mapping: array path + id/email/name field names.
  const list = r.body?.employees || r.body?.data?.employees || r.body?.data || [];
  return (Array.isArray(list) ? list : []).map(e => ({
    razorpayx_employee_id: String(e.id),           // EMP_ID_FIELD
    email: (e.email || '').trim().toLowerCase(),    // EMP_EMAIL_FIELD
    name: e.name || e.full_name || null,            // EMP_NAME_FIELD
  })).filter(e => e.razorpayx_employee_id);
}
```

> After Task 1, replace the `||`-fallback field accesses with the exact confirmed names.

- [ ] **Step 2: Add `getRazorpayxPayrollMap`** (place near the payouts reads, after `getBulkPayouts` ~line 1985). Resolves matches by `work_email`, persists newly-found RazorpayX ids, returns matched + both-sided unmatched.

```javascript
// Map RazorpayX employees ↔ Podium employees by work_email (Fraternitas white-collar).
// Side-effect: persists newly-resolved razorpayx_employee_id onto the Podium row so
// later syncs resolve directly. Comp-gated + audited (reads the payroll roster).
async function getRazorpayxPayrollMap(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  if (!razorpayxConfigured(env)) return err('razorpayx_not_configured', 400);
  await logCompAccess(auth, 'getRazorpayxPayrollMap', null, url.searchParams.get('month') || null, env);

  const rzp = await fetchRazorpayxEmployees(env);
  const rzpByEmail = new Map(rzp.map(e => [e.email, e]));

  const er = await sb(`/rest/v1/employees?status=neq.exited&select=id,employee_code,full_name,work_email,razorpayx_employee_id&order=full_name.asc`, env);
  if (!er.ok) return err('db_error', 500);
  const emps = er.data || [];

  const matched = [], unmatchedPodium = [], toPersist = [];
  const usedRzp = new Set();
  for (const e of emps) {
    let rid = e.razorpayx_employee_id || null;
    if (!rid) {
      const hit = rzpByEmail.get((e.work_email || '').trim().toLowerCase());
      if (hit) { rid = hit.razorpayx_employee_id; toPersist.push({ id: e.id, razorpayx_employee_id: rid }); }
    }
    if (rid) {
      usedRzp.add(String(rid));
      matched.push({ employee_id: e.id, employee_code: e.employee_code, full_name: e.full_name, razorpayx_employee_id: String(rid) });
    } else {
      unmatchedPodium.push({ employee_id: e.id, employee_code: e.employee_code, full_name: e.full_name, work_email: e.work_email || null });
    }
  }
  const unmatchedRzp = rzp.filter(r => !usedRzp.has(String(r.razorpayx_employee_id)))
    .map(r => ({ razorpayx_employee_id: r.razorpayx_employee_id, name: r.name, email: r.email }));

  // Persist newly-resolved ids (batched upsert; best-effort, must not block the map read).
  if (toPersist.length) {
    try {
      await sb(`/rest/v1/employees?on_conflict=id`, env, {
        method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates',
        body: JSON.stringify(toPersist),
      });
    } catch (_e) { /* mapping persists next run; never block */ }
  }
  return ok({ matched, unmatched_podium: unmatchedPodium, unmatched_razorpayx: unmatchedRzp });
}
```

- [ ] **Step 3: Register the action** — add `getRazorpayxPayrollMap` to `GET_ACTIONS` (line ~2138, near the payout getters) and to `SELF_SERVE_GET` (line ~2199, comp-gated like the factory getters, so a comp-only user without `podium_view` can reach it):

```javascript
// in GET_ACTIONS, beside getPayouts…:
getPayouts, getMyPayouts, getPayoutPeriodSheet, getBulkPayouts,
getRazorpayxPayrollMap, getRazorpayxPayrollAmounts,
```
```javascript
// in SELF_SERVE_GET (comp-self-gated group):
'getFactoryWorkforce', 'getFactoryCostInputs',
'getRazorpayxPayrollMap', 'getRazorpayxPayrollAmounts',
```

- [ ] **Step 4: Syntax-check**

Run: `node --check 05_Throttle/podiumops-worker/src/index.js`
Expected: no output (exit 0). (`getRazorpayxPayrollAmounts` is added in Task 4; if referenced-before-defined lint bites, add Task 4 before deploying — both land before Step 5's deploy.)

- [ ] **Step 5: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js
git commit -m "podium: RazorpayX client helper + payroll employee-map action (S200)"
```

---

## Task 4: Worker — chunked amounts action

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`

- [ ] **Step 1: Add a payroll-amount parser** (put beside the RazorpayX helpers from Task 3). Field names per Task 1.

```javascript
// Extract gross monthly earnings from a view-payroll response. TASK 1 mapping.
// If gross isn't a single field, reconstruct = net + Σ(employee deductions).
function parseRazorpayxPayroll(body) {
  const p = body?.payroll || body?.data || body || {};
  const num = v => (v == null || isNaN(Number(v))) ? null : Number(v);
  const gross = num(p.gross_earnings ?? p.gross ?? p.total_earnings);   // PAYROLL_GROSS_FIELD
  const net   = num(p.net_pay ?? p.net);                                 // PAYROLL_NET_FIELD
  return {
    gross,
    net,
    paid_on: p.disbursed_on || p.payroll_month || null,                  // PAYROLL_PAIDON_FIELD
    source_ref: p.payroll_id != null ? String(p.payroll_id) : null,      // PAYROLL_ID_FIELD
  };
}
```

- [ ] **Step 2: Add `getRazorpayxPayrollAmounts`** — fetches `view-payroll` for a client-supplied chunk of RazorpayX ids (≤40). Resolves each back to a Podium employee via the persisted `razorpayx_employee_id` (one batched DB read). Comp-gated + audited.

```javascript
// Fetch a CHUNK (≤40) of employees' payroll for a month. The client orchestrates
// chunking to respect the 50-subrequest limit. Comp-gated + audited.
async function getRazorpayxPayrollAmounts(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  if (!razorpayxConfigured(env)) return err('razorpayx_not_configured', 400);
  const month = url.searchParams.get('month');
  const idsRaw = url.searchParams.get('ids') || '';
  if (!/^\d{4}-\d{2}$/.test(month || '')) return err('month required (YYYY-MM)', 400);
  const ids = idsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
  if (!ids.length) return err('ids required', 400);
  await logCompAccess(auth, 'getRazorpayxPayrollAmounts', null, `${month} (${ids.length})`, env);

  // Resolve razorpayx id → podium employee (batched; ids persisted by the map action).
  const inList = ids.map(encodeURIComponent).join(',');
  const er = await sb(`/rest/v1/employees?razorpayx_employee_id=in.(${inList})&select=id,razorpayx_employee_id`, env);
  const empByRzp = new Map((er.ok ? er.data || [] : []).map(e => [String(e.razorpayx_employee_id), e.id]));

  const amounts = [];
  for (const rid of ids) {
    const r = await razorpayxCall(env, 'payroll', 'view-payroll', { 'employee-id': Number(rid), 'payroll-month': month });
    if (!r.ok) { amounts.push({ razorpayx_employee_id: rid, employee_id: empByRzp.get(rid) || null, error: `http_${r.status}` }); continue; }
    const parsed = parseRazorpayxPayroll(r.body);
    amounts.push({
      razorpayx_employee_id: rid,
      employee_id: empByRzp.get(rid) || null,
      gross: parsed.gross, net: parsed.net,
      paid_on: parsed.paid_on, source_ref: parsed.source_ref,
    });
  }
  return ok({ month, amounts });
}
```

- [ ] **Step 3: Syntax-check**

Run: `node --check 05_Throttle/podiumops-worker/src/index.js`
Expected: exit 0.

- [ ] **Step 4: Deploy**

Run: `cd 05_Throttle/podiumops-worker && npx wrangler deploy`
Expected: successful deploy, new version id printed.

- [ ] **Step 5: Curl smoke (unauth → gate proves it's wired)**

Run: `curl -s "https://podiumops.afshaan.workers.dev/?action=getRazorpayxPayrollMap" | head -c 200`
Expected: `{"ok":false,"error":"unauthorized"}` (401 — action is registered; auth gate fires before the handler). A live authed run happens in Task 7.

- [ ] **Step 6: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js
git commit -m "podium: RazorpayX chunked payroll-amounts action + parser (S200)"
```

---

## Task 5: Worker — apply action (write to payouts)

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`

- [ ] **Step 1: Add `applyRazorpayxPayouts`** (place beside `upsertPayouts` ~line 2042). Upserts one `fixed` row per employee-month with `source='razorpayx'`; supersedes autogen/manual via the existing unique index. Comp-gated + audited.

```javascript
// Write confirmed RazorpayX gross amounts into the payouts ledger. One 'fixed' row
// per employee-month; source='razorpayx' supersedes autogen/manual via the unique
// index (employee_id,payout_type,period_key). Comp-gated + audited.
async function applyRazorpayxPayouts(body, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const d = body.data || body;
  const month = d.month;
  const inRows = Array.isArray(d.rows) ? d.rows : [];
  if (!/^\d{4}-\d{2}$/.test(month || '')) return err('month required (YYYY-MM)', 400);
  if (!inRows.length) return err('rows required', 400);

  const meta = periodMeta(month);   // { period_type:'monthly', period_start, period_end }
  const clean = [];
  for (const r of inRows) {
    if (!r.employee_id || r.amount == null || isNaN(Number(r.amount))) continue;
    clean.push({
      employee_id: r.employee_id,
      payee_type: 'employee',
      payout_type: 'fixed',
      period_type: meta.period_type,
      period_key: month,
      period_start: meta.period_start,
      period_end: meta.period_end,
      amount: Number(r.amount),
      currency: 'INR',
      paid_on: r.paid_on || null,
      source: 'razorpayx',
      source_ref: r.source_ref || null,
      created_by: auth.userId || null,
      updated_at: nowIso(),
    });
  }
  if (!clean.length) return err('no valid rows', 400);

  const w = await sb(`/rest/v1/payouts?on_conflict=employee_id,payout_type,period_key`, env, {
    method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: JSON.stringify(clean),
  });
  if (!w.ok) return err('upsert_failed: ' + JSON.stringify(w.data), 400);
  await logCompAccess(auth, 'applyRazorpayxPayouts', null, `${month}: ${clean.length} rows`, env);
  return ok({ month, saved: clean.length });
}
```

- [ ] **Step 2: Register the action** — add to `POST_ACTIONS` (beside the payouts writers ~line 2173) and to `SELF_SERVE_POST` (comp-self-gated, like the factory setters ~line 2211):

```javascript
// in POST_ACTIONS, beside the payouts writers:
upsertPayouts, generateFixedPayouts, deletePayout, applyRazorpayxPayouts,
```
```javascript
// in SELF_SERVE_POST (comp-self-gated group):
'setFactoryWorkforce', 'setFactoryPay', 'bulkUploadFactoryPay', 'setFactoryCostInput', 'setFactoryOtRates',
'applyRazorpayxPayouts',
```

- [ ] **Step 3: Syntax-check + deploy**

Run: `node --check 05_Throttle/podiumops-worker/src/index.js && cd 05_Throttle/podiumops-worker && npx wrangler deploy`
Expected: exit 0, then successful deploy.

- [ ] **Step 4: Commit**

```bash
cd 05_Throttle && git add podiumops-worker/src/index.js
git commit -m "podium: applyRazorpayxPayouts — write payroll actuals to payouts ledger (S200)"
```

---

## Task 6: Frontend — Sync-from-RazorpayX modal + button on /admin/payouts

**Files:**
- Create: `05_Throttle/apps/podium/src/components/RazorpayxSyncModal.js`
- Modify: `05_Throttle/apps/podium/src/app/(auth)/admin/payouts/page.js`

- [ ] **Step 1: Write the modal** — loads the map, chunks the amounts client-side (≤40/call), shows a preview, confirms via `applyRazorpayxPayouts`.

```javascript
'use client';
import { useEffect, useState } from 'react';
import { Spinner, useToast } from '@throttle/ui';
import { X, RefreshCw, DownloadCloud } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../lib/podiumopsFetch.js';
import { fmtINR } from '../lib/payouts.js';

const CHUNK = 40;

// On-demand RazorpayX Payroll sync — review-and-confirm. Maps employees, fetches a
// month's gross per employee in ≤40-id chunks, previews, then writes to payouts.
export default function RazorpayxSyncModal({ session, month, onClose, onDone }) {
  const { showToast } = useToast();
  const [phase, setPhase] = useState('loading');   // loading | ready | applying | error
  const [error, setError] = useState(null);
  const [map, setMap] = useState(null);            // {matched, unmatched_podium, unmatched_razorpayx}
  const [amounts, setAmounts] = useState({});      // razorpayx_employee_id → {gross, employee_id, ...}
  const [progress, setProgress] = useState(0);

  useEffect(() => { run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setPhase('loading'); setError(null); setAmounts({}); setProgress(0);
    try {
      const m = await podiumopsGet('getRazorpayxPayrollMap', { month }, session);
      setMap(m);
      const ids = (m.matched || []).map(r => r.razorpayx_employee_id);
      const acc = {};
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const r = await podiumopsGet('getRazorpayxPayrollAmounts', { month, ids: chunk.join(',') }, session);
        for (const a of (r.amounts || [])) acc[a.razorpayx_employee_id] = a;
        setProgress(Math.min(i + CHUNK, ids.length));
      }
      setAmounts(acc);
      setPhase('ready');
    } catch (e) { setError(e.message || 'Sync failed'); setPhase('error'); }
  }

  const rows = (map?.matched || []).map(m => ({ ...m, amt: amounts[m.razorpayx_employee_id] || null }))
    .filter(r => r.amt && r.amt.gross != null);
  const total = rows.reduce((s, r) => s + Number(r.amt.gross), 0);

  async function apply() {
    setPhase('applying');
    try {
      const payload = rows.map(r => ({ employee_id: r.employee_id, amount: r.amt.gross, paid_on: r.amt.paid_on, source_ref: r.amt.source_ref }));
      const res = await podiumopsPost('applyRazorpayxPayouts', { month, rows: payload }, session);
      showToast(`Synced ${res.saved} payouts for ${month}`, 'success');
      onDone?.();
    } catch (e) { showToast(e.message || 'Apply failed', 'error'); setPhase('ready'); }
  }

  return (
    <div style={ov} onClick={onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={hd}>
          <b>Sync payroll from RazorpayX — {month}</b>
          <X size={18} style={{ cursor: 'pointer' }} onClick={onClose} />
        </div>

        {phase === 'loading' && <div style={{ padding: 20 }}><Spinner /> Fetching payroll… {progress}/{(map?.matched || []).length || '…'}</div>}
        {phase === 'error' && <div style={{ padding: 20, color: 'var(--danger, #d33)' }}>{error} <button onClick={run} style={btn}><RefreshCw size={13} /> Retry</button></div>}

        {(phase === 'ready' || phase === 'applying') && (
          <>
            <div style={{ padding: '8px 14px', color: 'var(--t3)' }}>
              {rows.length} matched with payroll · total gross <b>{fmtINR(total)}</b>
              {map.unmatched_razorpayx?.length ? ` · ${map.unmatched_razorpayx.length} RazorpayX unmatched` : ''}
              {map.unmatched_podium?.length ? ` · ${map.unmatched_podium.length} Podium no-payroll` : ''}
            </div>
            <div style={{ maxHeight: 340, overflow: 'auto', padding: '0 14px' }}>
              <table style={{ width: '100%', fontSize: 13 }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--t3)' }}><th>Employee</th><th style={{ textAlign: 'right' }}>Gross</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.employee_id}><td>{r.full_name} <span style={{ color: 'var(--t4)' }}>{r.employee_code}</span></td>
                      <td style={{ textAlign: 'right' }}>{fmtINR(r.amt.gross)}</td></tr>
                  ))}
                </tbody>
              </table>
              {!!map.unmatched_razorpayx?.length && (
                <div style={{ margin: '10px 0', color: 'var(--t4)', fontSize: 12 }}>
                  Unmatched (in RazorpayX, no Podium email): {map.unmatched_razorpayx.map(u => u.name || u.email).join(', ')}
                </div>
              )}
            </div>
            <div style={{ padding: 14, textAlign: 'right' }}>
              <button onClick={apply} disabled={phase === 'applying' || !rows.length} style={btnPrimary}>
                <DownloadCloud size={14} /> {phase === 'applying' ? 'Writing…' : `Confirm & write ${rows.length} to ledger`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const ov = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 };
const panel = { background: 'var(--surface)', borderRadius: 12, width: 'min(680px, 94vw)', maxHeight: '86vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' };
const hd = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--border, #2a2a33)' };
const btn = { display: 'inline-flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border,#2a2a33)', background: 'transparent', color: 'var(--t1)', cursor: 'pointer' };
const btnPrimary = { ...btn, background: 'var(--yellow, #f5c518)', color: '#1a1a1a', border: 'none', fontWeight: 600 };
```

- [ ] **Step 2: Wire the button into the payouts page** — on the `fixed` tab, next to the existing "Generate month from CTC" button (page.js ~line 106). Import + state + render.

Add to imports (top of `page.js`):
```javascript
import RazorpayxSyncModal from '../../../../components/RazorpayxSyncModal.js';
```
Add state (beside the other `useState`s, ~line 23):
```javascript
const [rzpSync, setRzpSync] = useState(false);
```
Replace the fixed-tab button line (~line 106) with the Generate button **plus** the Sync button:
```javascript
        {tab === 'fixed' && <>
          <button onClick={generateFixed} disabled={busy} style={btn}><Sparkles size={13} /> Generate month from CTC</button>
          <button onClick={() => setRzpSync(true)} disabled={busy} style={btn}><Wallet size={13} /> Sync from RazorpayX</button>
        </>}
```
Render the modal near the end of the returned JSX (before the closing wrapper), reloading the sheet on done:
```javascript
      {rzpSync && (
        <RazorpayxSyncModal
          session={session} month={period}
          onClose={() => setRzpSync(false)}
          onDone={() => { setRzpSync(false); podiumopsGet('getPayoutPeriodSheet', { period_key: period, payout_type: 'fixed' }, session).then(setSheet).catch(() => {}); }}
        />
      )}
```

> The page already shows "Requires salary access." when `sheet === false` (non-comp users), so the Sync button is only reachable by comp-access members — no extra gate needed.

- [ ] **Step 3: Build the app**

Run: `cd 05_Throttle && npx turbo build --filter=podium`
Expected: build completes with zero errors.

- [ ] **Step 4: Commit**

```bash
cd 05_Throttle && git add apps/podium/src/components/RazorpayxSyncModal.js "apps/podium/src/app/(auth)/admin/payouts/page.js"
git commit -m "podium: Sync-from-RazorpayX modal on /admin/payouts (S200)"
git push
```

> Push triggers the podium gh-pages deploy (3–4 min).

---

## Task 7: Live smoke (needs Task 0 secrets + a comp-access login)

**Files:** none.

- [ ] **Step 1: Confirm the map resolves** — logged into Podium as a comp-access member (Afshaan), open `/admin/payouts` → Fixed tab → **Sync from RazorpayX**, month = a completed payroll month. Expect the matched count ≈ the white-collar (Fraternitas) headcount, a plausible gross total, and any unmatched listed. (If everything is unmatched, re-check the Task 1 email field / the `work_email` values.)

- [ ] **Step 2: Confirm the write** — click Confirm; toast reports N synced. Verify via MCP `execute_sql`:

```sql
SELECT count(*), sum(amount) FROM podium.payouts
WHERE source='razorpayx' AND period_key='<month>';
```

Expected: count = the confirmed N, sum = the previewed gross total.

- [ ] **Step 3: Confirm supersede semantics** — if that month had autogen'd `fixed` rows, confirm they were replaced (not duplicated):

```sql
SELECT employee_id, count(*) FROM podium.payouts
WHERE payout_type='fixed' AND period_key='<month>'
GROUP BY employee_id HAVING count(*) > 1;
```

Expected: zero rows (the unique index held; RazorpayX superseded).

- [ ] **Step 4: Confirm Analytics fills** — open Podium `/analytics` → Payroll Cost → the plan-vs-actual trend now shows an actuals point for `<month>`.

---

## Task 8: Knowledge-file updates (session-wrap)

**Files:** workspace-root knowledge docs + memory.

- [ ] **Step 1:** Update `systems/podium.md` — new actions (`getRazorpayxPayrollMap`/`getRazorpayxPayrollAmounts`/`applyRazorpayxPayouts`), the `razorpayx_employee_id`/`source_ref` columns, Phase-5 "real-salary feed" → done; bump `Last updated`.
- [ ] **Step 2:** Update `reference/integrations.md` — add a RazorpayX Payroll section (base URL, body-auth, the two secrets, Fraternitas-only, probe-first field mapping).
- [ ] **Step 3:** Update the `project_podium_salary_vault` memory — real-salary feed now wired (was the pending follow-on).
- [ ] **Step 4:** `BACKLOG.md` — add any residuals (e.g. reimbursements view, profile payroll display, component-split v2, cron automation) under `[podium]`.
- [ ] **Step 5:** Commit workspace root (`git add -A && git commit && git push`) — the brain-sync hook also auto-syncs memory.

---

## Self-review notes

- **Spec coverage:** §4 secrets→T0; §3 probe→T1; §2 entity model→enforced by Fraternitas-only matching in T3 + email match; §5 matching→T3; §6 chunking→T4 + modal T6; §7 payouts write→T5; §8 permissions→`requireComp`+`logCompAccess` on every action + SELF_SERVE registration; §9 frontend→T6; §11 migrations→T2; §12 rollout→T7. All covered.
- **Deferred-by-design (out of scope, not gaps):** reimbursements, profile payroll display, write-back, component-split — logged to BACKLOG in T8.
- **Type consistency:** action names, `razorpayx_employee_id`, `source_ref`, `source='razorpayx'`, `parseRazorpayxPayroll`, and the modal↔worker payload keys (`employee_id`/`amount`/`paid_on`/`source_ref`, `ids` comma list, `month`) match across tasks.
- **One real dependency, not a placeholder:** the exact `view-payroll`/`get-employees` field names are resolved by the Task 1 probe and threaded into the `||`-fallback accessors in Tasks 3–4 — flagged inline at each site.
