# Podium Phase 6 — Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/analytics` page in Podium — org/headcount, payroll-cost (comp-gated), and performance analytics — powered by three aggregate-only Postgres RPCs and three gated podiumops actions.

**Architecture:** Migration `podium_analytics_v1` creates `podium.f_analytics_org/comp/perf` (each returns one `jsonb` document; aggregates only — no per-person salary rows leave Postgres, mirroring `public.f_factory_cost_*`). podiumops adds three thin GET handlers (gate → single RPC call → return). apps/podium adds a nav entry + one self-fetching sectioned page using Recharts (already a dependency).

**Tech Stack:** Supabase Postgres (SQL functions, `podium` schema), Cloudflare Worker (podiumops), Next.js static export (apps/podium), Recharts 2.12.

**Spec:** `docs/superpowers/specs/2026-07-07-podium-phase6-analytics-design.md`

**Ground truth verified 2026-07-07 (live DB):**
- `podium.employees`: 56 `active` + 6 `exited`; **28 active rows have NULL `date_joined`** → tenure gets an explicit `unknown` bucket; historical-headcount math treats NULL `date_joined` as "joined before the window" (else denominators lie).
- `compensation_events`: event_type values live today = `initial` (54) + `revision` (27). Current-CTC dedup (`DISTINCT ON (employee_id) … WHERE event_type <> 'one_time_bonus' AND new_ctc IS NOT NULL ORDER BY effective_date DESC, created_at DESC`) sums to **₹4,91,99,007** — that exact number is the migration checksum.
- `appraisal_cycles`/`appraisals`: **zero rows** → perf section must render a real "no cycles yet" empty state; RPC must return `cycles: []` not error.
- `payouts`: **zero rows** (cols verified live: `payout_type, period_type, period_key, period_start, period_end, target_amount, achievement_pct, amount, paid_on, source, payee_type, payee_label`) → actuals overlay renders empty, expected.
- `getMe` already returns `tier: { …, comp: canComp(auth) }` — frontend uses `me.tier.comp`; **no worker change needed for exposure**.
- `recharts@^2.12.7` already in `apps/podium/package.json` — no dependency task.
- podiumops patterns: `sb()` targets the `podium` schema (`Accept-Profile`/`Content-Profile: podium`); RPC call = `sb('/rest/v1/rpc/<fn>', env, { method:'POST', body: JSON.stringify({...}) })`; gates = `isHr(auth)` / `requireComp(auth)`; audit = `logCompAccess(auth, action, subjectId, label, env, detail)`; GET dispatch requires `podium_view` unless the action is in `SELF_SERVE_GET`.

---

### Task 1: Migration `podium_analytics_v1` — the three RPCs

**Files:**
- No repo files — applied via Supabase MCP `apply_migration` (name `podium_analytics_v1`), like every prior Podium migration.

- [ ] **Step 1: Apply the migration**

Use `apply_migration` with name `podium_analytics_v1` and this SQL (non-destructive — auto-runs, no prompt):

```sql
-- Podium Phase 6 analytics — aggregate-only RPCs.
-- Spec: docs/superpowers/specs/2026-07-07-podium-phase6-analytics-design.md
-- Pattern precedent: public.f_factory_cost_* (RULE-COST-001). No new tables.
-- All month math is IST (Asia/Kolkata). Each fn returns ONE jsonb document.

-- ── 1) Org & headcount ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION podium.f_analytics_org(p_months int DEFAULT 12)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = podium, public
AS $$
WITH bounds AS (
  SELECT date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))::date AS cur_month,
         (now() AT TIME ZONE 'Asia/Kolkata')::date AS today,
         LEAST(GREATEST(coalesce(p_months, 12), 1), 36) AS n
),
months AS (
  SELECT to_char(gs, 'YYYY-MM') AS month, gs::date AS mstart,
         (gs + interval '1 month')::date AS mnext
  FROM bounds b,
       generate_series(b.cur_month - make_interval(months => b.n - 1),
                       b.cur_month, interval '1 month') gs
),
act AS (SELECT * FROM podium.employees WHERE status <> 'exited')
SELECT jsonb_build_object(
  'headcount', jsonb_build_object(
    'total', (SELECT count(*) FROM act),
    'by_department', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('department', dname, 'count', c) ORDER BY c DESC), '[]'::jsonb)
      FROM (SELECT coalesce(d.name, 'Unassigned') AS dname, count(*) AS c
            FROM act a LEFT JOIN podium.departments d ON d.id = a.department_id
            GROUP BY 1) x),
    'by_employment_type', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('type', t, 'count', c) ORDER BY c DESC), '[]'::jsonb)
      FROM (SELECT coalesce(employment_type, 'unknown') AS t, count(*) AS c FROM act GROUP BY 1) x),
    'by_legal_entity', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('entity', e, 'count', c) ORDER BY c DESC), '[]'::jsonb)
      FROM (SELECT coalesce(legal_entity, 'unknown') AS e, count(*) AS c FROM act GROUP BY 1) x)
  ),
  'joiners_exits', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'joiners', j.c, 'exits', e.c)
                              ORDER BY m.month), '[]'::jsonb)
    FROM months m
    LEFT JOIN LATERAL (SELECT count(*) c FROM podium.employees
                       WHERE date_joined >= m.mstart AND date_joined < m.mnext) j ON true
    LEFT JOIN LATERAL (SELECT count(*) c FROM podium.employees
                       WHERE date_exited >= m.mstart AND date_exited < m.mnext) e ON true
  ),
  'tenure_buckets', (
    SELECT jsonb_build_array(
      jsonb_build_object('bucket', '<6mo',   'count', count(*) FILTER (WHERE a.date_joined IS NOT NULL AND a.date_joined >  (b.today - interval '6 months')::date)),
      jsonb_build_object('bucket', '6–12mo', 'count', count(*) FILTER (WHERE a.date_joined >  (b.today - interval '12 months')::date AND a.date_joined <= (b.today - interval '6 months')::date)),
      jsonb_build_object('bucket', '1–2y',   'count', count(*) FILTER (WHERE a.date_joined >  (b.today - interval '24 months')::date AND a.date_joined <= (b.today - interval '12 months')::date)),
      jsonb_build_object('bucket', '2–3y',   'count', count(*) FILTER (WHERE a.date_joined >  (b.today - interval '36 months')::date AND a.date_joined <= (b.today - interval '24 months')::date)),
      jsonb_build_object('bucket', '3y+',    'count', count(*) FILTER (WHERE a.date_joined <= (b.today - interval '36 months')::date)),
      jsonb_build_object('bucket', 'unknown','count', count(*) FILTER (WHERE a.date_joined IS NULL))
    )
    FROM act a CROSS JOIN bounds b
  ),
  'attrition', (
    -- NULL date_joined = treated as joined-before-window for historical headcount
    -- (28/56 active rows have no join date; excluding them would fake-halve denominators).
    SELECT jsonb_build_object(
      'trailing_12mo_pct',
        CASE WHEN t.hc_avg > 0 THEN round(100.0 * t.exits12 / t.hc_avg, 1) ELSE NULL END,
      'series', t.series)
    FROM (
      SELECT
        (SELECT count(*) FROM podium.employees e, bounds b
          WHERE e.date_exited >= (b.today - interval '12 months')::date) AS exits12,
        ( (SELECT count(*) FROM podium.employees e, bounds b
            WHERE (e.date_joined IS NULL OR e.date_joined <= (b.today - interval '12 months')::date)
              AND (e.status <> 'exited'
                   OR (e.date_exited IS NOT NULL AND e.date_exited > (b.today - interval '12 months')::date)))
          + (SELECT count(*) FROM act) ) / 2.0 AS hc_avg,
        (SELECT coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'rate_pct',
            CASE WHEN hs.hc > 0 THEN round(100.0 * ex.c / hs.hc, 2) ELSE NULL END)
            ORDER BY m.month), '[]'::jsonb)
         FROM months m
         LEFT JOIN LATERAL (SELECT count(*) c FROM podium.employees
                            WHERE date_exited >= m.mstart AND date_exited < m.mnext) ex ON true
         LEFT JOIN LATERAL (SELECT count(*) hc FROM podium.employees e
                            WHERE (e.date_joined IS NULL OR e.date_joined < m.mstart)
                              AND (e.date_exited IS NULL OR e.date_exited >= m.mstart)
                              AND (e.status <> 'exited' OR e.date_exited IS NOT NULL)) hs ON true
        ) AS series
    ) t
  )
)
FROM bounds;
$$;

-- ── 2) Comp & payroll cost — AGGREGATES ONLY ───────────────────────────────
CREATE OR REPLACE FUNCTION podium.f_analytics_comp(p_months int DEFAULT 12)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = podium, public
AS $$
WITH bounds AS (
  SELECT date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))::date AS cur_month,
         (now() AT TIME ZONE 'Asia/Kolkata')::date AS today,
         LEAST(GREATEST(coalesce(p_months, 12), 1), 36) AS n
),
months AS (
  SELECT to_char(gs, 'YYYY-MM') AS month, gs::date AS mstart,
         (gs + interval '1 month')::date AS mnext
  FROM bounds b,
       generate_series(b.cur_month - make_interval(months => b.n - 1),
                       b.cur_month, interval '1 month') gs
),
act AS (SELECT id, department_id FROM podium.employees WHERE status <> 'exited'),
cur_comp AS (
  -- CTC in force TODAY, one row per active employee that has any comp event.
  SELECT DISTINCT ON (ce.employee_id) ce.employee_id, ce.new_ctc
  FROM podium.compensation_events ce
  JOIN act a ON a.id = ce.employee_id
  CROSS JOIN bounds b
  WHERE ce.event_type <> 'one_time_bonus' AND ce.new_ctc IS NOT NULL
    AND ce.effective_date <= b.today
  ORDER BY ce.employee_id, ce.effective_date DESC, ce.created_at DESC
)
SELECT jsonb_build_object(
  'totals', (
    SELECT jsonb_build_object(
      'annual_ctc_total',       coalesce(sum(new_ctc), 0),
      'monthly_plan_cost',      round(coalesce(sum(new_ctc), 0) / 12.0, 0),
      'employees_with_comp',    count(*),
      'employees_without_comp', (SELECT count(*) FROM act) - count(*))
    FROM cur_comp),
  'by_department', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('department', dname,
             'annual_ctc_total', s, 'headcount_with_comp', c) ORDER BY s DESC), '[]'::jsonb)
    FROM (SELECT coalesce(d.name, 'Unassigned') AS dname, sum(cc.new_ctc) AS s, count(*) AS c
          FROM cur_comp cc
          JOIN act a ON a.id = cc.employee_id
          LEFT JOIN podium.departments d ON d.id = a.department_id
          GROUP BY 1) x),
  'distribution', (
    SELECT jsonb_build_array(
      jsonb_build_object('bucket', '<3L',    'count', count(*) FILTER (WHERE new_ctc < 300000)),
      jsonb_build_object('bucket', '3–6L',   'count', count(*) FILTER (WHERE new_ctc >= 300000  AND new_ctc < 600000)),
      jsonb_build_object('bucket', '6–12L',  'count', count(*) FILTER (WHERE new_ctc >= 600000  AND new_ctc < 1200000)),
      jsonb_build_object('bucket', '12–24L', 'count', count(*) FILTER (WHERE new_ctc >= 1200000 AND new_ctc < 2400000)),
      jsonb_build_object('bucket', '24L+',   'count', count(*) FILTER (WHERE new_ctc >= 2400000)))
    FROM cur_comp),
  'increments', (
    -- applyIncrement writes event_type='increment'; empty today (only initial/revision live) — correct long-term.
    SELECT coalesce(jsonb_agg(jsonb_build_object('anchor', anchor, 'count', c,
             'avg_increment_pct', avgpct) ORDER BY anchor DESC), '[]'::jsonb)
    FROM (SELECT effective_date AS anchor, count(*) AS c, round(avg(increment_pct), 1) AS avgpct
          FROM podium.compensation_events
          WHERE event_type = 'increment'
          GROUP BY 1) x),
  'monthly_trend', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('month', m.month,
             'plan_cost', p.plan_cost,
             'actuals_employee', pay.emp_amt,
             'actuals_vendor',   pay.ven_amt) ORDER BY m.month), '[]'::jsonb)
    FROM months m
    LEFT JOIN LATERAL (
      -- plan = Σ (CTC in force at that month ÷ 12) over employees active in that month.
      SELECT round(coalesce(sum(pick.new_ctc), 0) / 12.0, 0) AS plan_cost
      FROM podium.employees e
      LEFT JOIN LATERAL (
        SELECT ce.new_ctc
        FROM podium.compensation_events ce
        WHERE ce.employee_id = e.id AND ce.event_type <> 'one_time_bonus'
          AND ce.new_ctc IS NOT NULL AND ce.effective_date < m.mnext
        ORDER BY ce.effective_date DESC, ce.created_at DESC
        LIMIT 1) pick ON true
      WHERE (e.date_joined IS NULL OR e.date_joined < m.mnext)
        AND (e.status <> 'exited' OR (e.date_exited IS NOT NULL AND e.date_exited >= m.mstart))
        AND (e.date_exited IS NULL OR e.date_exited >= m.mstart)
    ) p ON true
    LEFT JOIN LATERAL (
      -- actuals from the payouts ledger: monthly rows by period_key, ad-hoc/one-time by paid_on month.
      SELECT coalesce(sum(amount) FILTER (WHERE coalesce(payee_type, 'employee') = 'employee'), 0) AS emp_amt,
             coalesce(sum(amount) FILTER (WHERE payee_type = 'vendor'), 0) AS ven_amt
      FROM podium.payouts py
      WHERE CASE WHEN py.period_key ~ '^\d{4}-\d{2}$' THEN py.period_key
                 WHEN py.paid_on IS NOT NULL THEN to_char(py.paid_on, 'YYYY-MM')
                 ELSE NULL END = m.month
    ) pay ON true
  )
);
$$;

-- ── 3) Performance ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION podium.f_analytics_perf(p_cycles int DEFAULT 4)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = podium, public
AS $$
WITH bounds AS (
  SELECT date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))::date AS cur_month,
         LEAST(GREATEST(coalesce(p_cycles, 4), 1), 10) AS n
),
months AS (
  SELECT to_char(gs, 'YYYY-MM') AS month, gs::date AS mstart,
         (gs + interval '1 month')::date AS mnext
  FROM bounds b,
       generate_series(b.cur_month - interval '11 months', b.cur_month, interval '1 month') gs
),
cyc AS (
  SELECT * FROM podium.appraisal_cycles
  ORDER BY appraisal_date DESC
  LIMIT (SELECT n FROM bounds)
)
SELECT jsonb_build_object(
  'cycles', (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'cycle', c.name, 'appraisal_date', c.appraisal_date, 'status', c.status,
      'rating_distribution', s.dist,
      'avg_final_rating', s.avgr,
      'pip_count', s.pip,
      'funnel', jsonb_build_object(
        'enrolled', s.enrolled, 'self_submitted', s.selfs,
        'manager_submitted', s.mgrs, 'finalized', s.fin, 'acknowledged', s.ack)
    ) ORDER BY c.appraisal_date DESC), '[]'::jsonb)
    FROM cyc c
    LEFT JOIN LATERAL (
      SELECT count(*) AS enrolled,
             count(ap.self_submitted_at)    AS selfs,
             count(ap.manager_submitted_at) AS mgrs,
             count(ap.final_rating)         AS fin,
             count(ap.acknowledged_at)      AS ack,
             count(*) FILTER (WHERE ap.outcome = 'pip') AS pip,
             round(avg(ap.final_rating), 2) AS avgr,
             jsonb_build_object(
               '1', count(*) FILTER (WHERE ap.final_rating = 1),
               '2', count(*) FILTER (WHERE ap.final_rating = 2),
               '3', count(*) FILTER (WHERE ap.final_rating = 3),
               '4', count(*) FILTER (WHERE ap.final_rating = 4),
               '5', count(*) FILTER (WHERE ap.final_rating = 5)) AS dist
      FROM podium.appraisals ap
      WHERE ap.cycle_id = c.id
    ) s ON true
  ),
  'activity', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('month', m.month,
      'observations_positive',     o.pos,
      'observations_neutral',      o.neu,
      'observations_constructive', o.con,
      'wins', w.c, 'one_on_ones', oo.c) ORDER BY m.month), '[]'::jsonb)
    FROM months m
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE sentiment = 'positive')     AS pos,
             count(*) FILTER (WHERE sentiment = 'neutral')      AS neu,
             count(*) FILTER (WHERE sentiment = 'constructive') AS con
      FROM podium.observations
      WHERE observed_on >= m.mstart AND observed_on < m.mnext) o ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS c FROM podium.accomplishments
      WHERE achieved_on >= m.mstart AND achieved_on < m.mnext) w ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS c FROM podium.one_on_ones
      WHERE met_on >= m.mstart AND met_on < m.mnext) oo ON true
  )
);
$$;

-- ── Grants: service_role only (worker is the sole caller) ──────────────────
REVOKE ALL ON FUNCTION podium.f_analytics_org(int)  FROM PUBLIC;
REVOKE ALL ON FUNCTION podium.f_analytics_comp(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION podium.f_analytics_perf(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION podium.f_analytics_org(int)  TO service_role;
GRANT EXECUTE ON FUNCTION podium.f_analytics_comp(int) TO service_role;
GRANT EXECUTE ON FUNCTION podium.f_analytics_perf(int) TO service_role;
```

- [ ] **Step 2: Verify org RPC against live truths**

Run via `execute_sql`:

```sql
SELECT podium.f_analytics_org(12) AS org;
```

Expected: `headcount.total = 62 − 6 = 56`; `tenure_buckets` contains `{"bucket":"unknown","count":28}`; `joiners_exits` has 12 rows ending at the current month; `attrition.trailing_12mo_pct` is a number or null (no error).

- [ ] **Step 3: Verify comp RPC checksum**

```sql
SELECT (podium.f_analytics_comp(12))->'totals' AS totals;
```

Expected: `annual_ctc_total = 49199007` (exact — matches the pre-verified `DISTINCT ON` dedup), `employees_with_comp + employees_without_comp = 56`, `monthly_plan_cost = 4099917` (49199007/12 rounded). `monthly_trend` has 12 rows; `actuals_employee`/`actuals_vendor` all 0 (payouts empty); `increments = []`.

- [ ] **Step 4: Verify perf RPC empty-safe**

```sql
SELECT podium.f_analytics_perf(4) AS perf;
```

Expected: `cycles: []` (no cycles exist), `activity` = 12 month rows with numeric counts (observations/wins/1:1s do have rows — non-zero somewhere is plausible, zeros fine). No error.

- [ ] **Step 5: Verify grants**

```sql
SELECT p.proname, pg_get_userbyid(a.grantee) AS grantee, a.privilege_type
FROM pg_proc p
CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
WHERE p.pronamespace = 'podium'::regnamespace AND p.proname LIKE 'f_analytics%';
```

Expected: only `service_role` (and the owner `postgres`/`supabase_admin`) hold EXECUTE — no `PUBLIC`, `anon`, or `authenticated`.

---

### Task 2: podiumops — three gated GET actions

**Files:**
- Modify: `05_Throttle/podiumops-worker/src/index.js`
  - new handlers after the factory-cost GET handlers (search anchor: `async function getFactoryCostInputs`)
  - `GET_ACTIONS` map (~line 2089)
  - `SELF_SERVE_GET` set (~line 2146)

- [ ] **Step 1: Add the three handlers**

Insert after the factory-cost GET handlers (keep the section-comment style):

```js
// ── Phase 6 — Analytics (aggregate-only; math lives in podium.f_analytics_*) ──
// Org + Perf are HR/admin surfaces. Comp is allow-list-gated (RULE-PODIUM-002:
// the allow-list is THE salary gate) and audited — it is a cross-person comp
// read even though only aggregates are returned.

function clampInt(v, def, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : def;
}

async function getAnalyticsOrg(url, auth, env) {
  if (!isHr(auth)) return err('Forbidden — requires podium_hr', 403);
  const months = clampInt(url.searchParams.get('months'), 12, 1, 36);
  const r = await sb(`/rest/v1/rpc/f_analytics_org`, env, {
    method: 'POST', body: JSON.stringify({ p_months: months }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

async function getAnalyticsComp(url, auth, env) {
  const gate = requireComp(auth); if (gate) return gate;
  const months = clampInt(url.searchParams.get('months'), 12, 1, 36);
  await logCompAccess(auth, 'getAnalyticsComp', null, 'comp aggregates', env, { months });
  const r = await sb(`/rest/v1/rpc/f_analytics_comp`, env, {
    method: 'POST', body: JSON.stringify({ p_months: months }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}

async function getAnalyticsPerf(url, auth, env) {
  if (!isHr(auth)) return err('Forbidden — requires podium_hr', 403);
  const cycles = clampInt(url.searchParams.get('cycles'), 4, 1, 10);
  const r = await sb(`/rest/v1/rpc/f_analytics_perf`, env, {
    method: 'POST', body: JSON.stringify({ p_cycles: cycles }),
  });
  if (!r.ok) return err('db_error', 500);
  return ok(r.data);
}
```

Notes for the implementer: `isHr()` already includes admins (line ~249: `isHr = isAdmin || podium_hr`). `requireComp()` (line ~255) returns an `err` Response or null. RULE-011 satisfied — gate is the first line of each handler.

- [ ] **Step 2: Register the actions**

In `GET_ACTIONS`, after the `// Factory cost module (compensation-tier)` pair, add:

```js
  // Phase 6 — analytics
  getAnalyticsOrg, getAnalyticsComp, getAnalyticsPerf,
```

In `SELF_SERVE_GET`, after the factory-cost line, add (comp allow-list members need not hold `podium_view` — same reasoning as `getFactoryWorkforce`; the handler self-gates via `requireComp`):

```js
  // Comp analytics — self-gated by requireComp (a comp-only user need not hold podium_view).
  'getAnalyticsComp',
```

`getAnalyticsOrg`/`getAnalyticsPerf` deliberately stay OUT of `SELF_SERVE_GET` — HR roles always carry `podium_view` (forced by `normalizePodiumPerms`), so the default gate is correct for them.

- [ ] **Step 3: Commit + push + deploy** (worker sequence: edit → commit → push → deploy)

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add podiumops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "podium: Phase 6 analytics — getAnalyticsOrg/Comp/Perf (aggregate RPC reads)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/podiumops-worker && npx wrangler deploy
```

Expected: deploy prints a new version id, no errors.

- [ ] **Step 4: Curl-verify the deployed gates (no JWT available in CLI — verify the auth wall + routing)**

```bash
curl -s 'https://podiumops.afshaan.workers.dev/?action=ping'
curl -s 'https://podiumops.afshaan.workers.dev/?action=getAnalyticsOrg'
curl -s 'https://podiumops.afshaan.workers.dev/?action=getAnalyticsComp'
```

Expected: ping → `{"ok":true,"data":{"pong":true}}`; both analytics calls → `{"ok":false,"error":"unauthorized"}` (401 — action recognized, JWT wall holds). Authenticated 403/200 behaviour goes to the browser-smoke checklist.

---

### Task 3: apps/podium — nav entry + `/analytics` page

**Files:**
- Modify: `05_Throttle/apps/podium/src/lib/nav.js` (PERFORMANCE group + icon import)
- Create: `05_Throttle/apps/podium/src/app/(auth)/analytics/page.js`

- [ ] **Step 1: Nav entry**

In `nav.js`, add `TrendingUp` to the lucide-react import, and in the `performance` group append after the `appraisals` item:

```js
      { id: 'analytics', label: 'Analytics', route: '/analytics', icon: TrendingUp, requires: 'podium_hr' },
```

(`requires: 'podium_hr'` — the `admin` system role carries all keys, so admins pass; `filterNavByPerms` needs no change.)

- [ ] **Step 2: Create the page**

`src/app/(auth)/analytics/page.js` — complete file:

```js
'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner } from '@throttle/ui';
import { podiumopsGet } from '../../../lib/podiumopsFetch.js';
import { KpiTile, card, cardLabel } from '../../../components/ui.js';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ComposedChart, Line, CartesianGrid,
} from 'recharts';

const YELLOW = '#F2CD1A', BLUE = '#9fb0ff', GREEN = '#4ade80',
      ORANGE = '#fb923c', RED = '#ff8a8a';

const inr = (n) => n == null ? '—'
  : n >= 1e7 ? `₹${(n / 1e7).toFixed(2)}Cr`
  : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L`
  : `₹${Math.round(n).toLocaleString('en-IN')}`;
const mLabel = (m) => {
  const [y, mo] = String(m).split('-');
  return new Date(+y, +mo - 1, 1).toLocaleString('en', { month: 'short' }) + ' ' + y.slice(2);
};

const TT = { contentStyle: { background: 'var(--surface)', border: '1px solid var(--t5)', borderRadius: 8, fontSize: 12 } };
const AXIS = { stroke: 'var(--t4)', fontSize: 11 };

// Self-fetching section: own loading / error / retry, so one failure never blanks the page.
function useSection(action, params, session) {
  const [state, setState] = useState({ data: null, error: null });
  const load = useCallback(() => {
    if (!session) return;
    setState({ data: null, error: null });
    podiumopsGet(action, params, session)
      .then((data) => setState({ data, error: null }))
      .catch((e) => setState({ data: null, error: e.message || 'failed' }));
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return { ...state, retry: load };
}

function Section({ title, state, children }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ font: '600 13px/1 inherit', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', margin: '0 0 12px' }}>{title}</h2>
      {state.error ? (
        <div style={{ ...card, color: 'var(--bad-fg, ' + RED + ')' }}>
          Failed to load: {state.error}{' '}
          <button onClick={state.retry} style={{ marginLeft: 8, cursor: 'pointer', background: 'none', border: '1px solid var(--t5)', color: 'var(--t2)', borderRadius: 6, padding: '2px 10px' }}>Retry</button>
        </div>
      ) : !state.data ? <Spinner /> : children(state.data)}
    </section>
  );
}

const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14 };
function ChartCard({ label, children, h = 240 }) {
  return (
    <div style={card}>
      <div style={cardLabel}>{label}</div>
      <div style={{ width: '100%', height: h }}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}
const Rail = ({ children }) => <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>{children}</div>;
const Empty = ({ text }) => <div style={{ ...card, color: 'var(--t4)' }}>{text}</div>;

// ── Sections ────────────────────────────────────────────────────────────────

function OrgSection({ d }) {
  const je = (d.joiners_exits || []).map((r) => ({ ...r, m: mLabel(r.month) }));
  const att = ((d.attrition || {}).series || []).map((r) => ({ ...r, m: mLabel(r.month) }));
  const exits12 = je.reduce((s, r) => s + (r.exits || 0), 0);
  const lastMonth = je[je.length - 1] || {};
  return (
    <>
      <Rail>
        <KpiTile label="Headcount" value={d.headcount?.total ?? '—'} stripe />
        <KpiTile label="Joiners · this month" value={lastMonth.joiners ?? 0} subColor="var(--green-bright)" />
        <KpiTile label="Exits · 12mo" value={exits12} />
        <KpiTile label="Attrition · 12mo" value={d.attrition?.trailing_12mo_pct != null ? `${d.attrition.trailing_12mo_pct}%` : '—'} />
      </Rail>
      <div style={grid}>
        <ChartCard label="Headcount by department" h={Math.max(240, (d.headcount?.by_department?.length || 0) * 26)}>
          <BarChart data={d.headcount?.by_department || []} layout="vertical" margin={{ left: 8, right: 16 }}>
            <XAxis type="number" {...AXIS} allowDecimals={false} />
            <YAxis type="category" dataKey="department" width={130} {...AXIS} />
            <Tooltip {...TT} />
            <Bar dataKey="count" fill={YELLOW} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="Joiners vs exits">
          <ComposedChart data={je}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} /><Legend />
            <Bar dataKey="joiners" name="Joiners" fill={GREEN} radius={[3, 3, 0, 0]} />
            <Bar dataKey="exits" name="Exits" fill={RED} radius={[3, 3, 0, 0]} />
          </ComposedChart>
        </ChartCard>
        <ChartCard label="Tenure distribution">
          <BarChart data={d.tenure_buckets || []}>
            <XAxis dataKey="bucket" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} />
            <Bar dataKey="count" fill={BLUE} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="Monthly attrition rate (%)">
          <ComposedChart data={att}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} />
            <Tooltip {...TT} />
            <Line dataKey="rate_pct" name="Attrition %" stroke={ORANGE} strokeWidth={2} dot={false} connectNulls />
          </ComposedChart>
        </ChartCard>
      </div>
    </>
  );
}

function CompSection({ d }) {
  const t = d.totals || {};
  const trend = (d.monthly_trend || []).map((r) => ({ ...r, m: mLabel(r.month) }));
  const latestInc = (d.increments || [])[0];
  return (
    <>
      <Rail>
        <KpiTile label="Annual CTC (plan)" value={inr(t.annual_ctc_total)} stripe />
        <KpiTile label="Monthly plan cost" value={inr(t.monthly_plan_cost)} />
        <KpiTile label="With comp on file" value={`${t.employees_with_comp ?? 0} / ${(t.employees_with_comp ?? 0) + (t.employees_without_comp ?? 0)}`}
          sub={t.employees_without_comp ? `${t.employees_without_comp} missing` : 'complete'}
          subColor={t.employees_without_comp ? 'var(--warn-fg)' : 'var(--green-bright)'} />
        <KpiTile label="Latest increment round" value={latestInc ? `${latestInc.avg_increment_pct ?? '—'}%` : '—'}
          sub={latestInc ? `${latestInc.count} people · ${latestInc.anchor}` : 'none yet'} />
      </Rail>
      <div style={grid}>
        <ChartCard label="Annual CTC by department" h={Math.max(240, (d.by_department?.length || 0) * 26)}>
          <BarChart data={d.by_department || []} layout="vertical" margin={{ left: 8, right: 16 }}>
            <XAxis type="number" {...AXIS} tickFormatter={inr} />
            <YAxis type="category" dataKey="department" width={130} {...AXIS} />
            <Tooltip {...TT} formatter={(v) => inr(v)} />
            <Bar dataKey="annual_ctc_total" name="Annual CTC" fill={YELLOW} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="CTC distribution">
          <BarChart data={d.distribution || []}>
            <XAxis dataKey="bucket" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} />
            <Bar dataKey="count" fill={BLUE} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartCard>
        <ChartCard label="Monthly cost — plan vs actuals (actuals fill in as payouts land)">
          <ComposedChart data={trend}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} tickFormatter={inr} />
            <Tooltip {...TT} formatter={(v) => inr(v)} /><Legend />
            <Bar dataKey="actuals_employee" name="Actuals · payroll" stackId="a" fill={GREEN} />
            <Bar dataKey="actuals_vendor" name="Actuals · contract labour" stackId="a" fill={ORANGE} />
            <Line dataKey="plan_cost" name="Plan (CTC ÷ 12)" stroke={YELLOW} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ChartCard>
      </div>
    </>
  );
}

function PerfSection({ d }) {
  const cycles = d.cycles || [];
  const act = (d.activity || []).map((r) => ({
    ...r, m: mLabel(r.month),
    observations: (r.observations_positive || 0) + (r.observations_neutral || 0) + (r.observations_constructive || 0),
  }));
  const latest = cycles[0];
  const dist = cycles.length
    ? ['1', '2', '3', '4', '5'].map((k) => {
        const row = { rating: `★${k}` };
        cycles.forEach((c) => { row[c.cycle || c.appraisal_date] = c.rating_distribution?.[k] || 0; });
        return row;
      })
    : [];
  const CYCLE_COLS = [YELLOW, BLUE, GREEN, ORANGE];
  return (
    <>
      {latest ? (
        <Rail>
          <KpiTile label={`Avg rating · ${latest.cycle || latest.appraisal_date}`} value={latest.avg_final_rating ?? '—'} stripe />
          <KpiTile label="PIP" value={latest.pip_count ?? 0} subColor={latest.pip_count ? 'var(--bad-fg)' : 'var(--t4)'} />
          <KpiTile label="Finalized" value={`${latest.funnel?.finalized ?? 0} / ${latest.funnel?.enrolled ?? 0}`} />
          <KpiTile label="Acknowledged" value={`${latest.funnel?.acknowledged ?? 0} / ${latest.funnel?.enrolled ?? 0}`} />
        </Rail>
      ) : (
        <Empty text="No appraisal cycles yet — cycle analytics will appear after the first cycle runs. Activity volume below is live." />
      )}
      <div style={grid}>
        {cycles.length > 0 && (
          <ChartCard label="Final-rating distribution by cycle">
            <BarChart data={dist}>
              <XAxis dataKey="rating" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
              <Tooltip {...TT} /><Legend />
              {cycles.map((c, i) => (
                <Bar key={c.cycle || c.appraisal_date} dataKey={c.cycle || c.appraisal_date} fill={CYCLE_COLS[i % CYCLE_COLS.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ChartCard>
        )}
        {latest && (
          <ChartCard label={`Participation funnel · ${latest.cycle || latest.appraisal_date}`}>
            <BarChart layout="vertical" margin={{ left: 8, right: 16 }} data={[
              { stage: 'Enrolled', n: latest.funnel?.enrolled ?? 0 },
              { stage: 'Self done', n: latest.funnel?.self_submitted ?? 0 },
              { stage: 'Manager done', n: latest.funnel?.manager_submitted ?? 0 },
              { stage: 'Finalized', n: latest.funnel?.finalized ?? 0 },
              { stage: 'Acknowledged', n: latest.funnel?.acknowledged ?? 0 },
            ]}>
              <XAxis type="number" {...AXIS} allowDecimals={false} />
              <YAxis type="category" dataKey="stage" width={110} {...AXIS} />
              <Tooltip {...TT} />
              <Bar dataKey="n" fill={BLUE} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ChartCard>
        )}
        <ChartCard label="Performance activity · 12mo">
          <ComposedChart data={act}>
            <CartesianGrid stroke="var(--t5)" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="m" {...AXIS} /><YAxis {...AXIS} allowDecimals={false} />
            <Tooltip {...TT} /><Legend />
            <Line dataKey="observations" name="Observations" stroke={YELLOW} strokeWidth={2} dot={false} />
            <Line dataKey="wins" name="Wins" stroke={GREEN} strokeWidth={2} dot={false} />
            <Line dataKey="one_on_ones" name="1:1s" stroke={BLUE} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ChartCard>
      </div>
    </>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const { session } = useAuth();
  const [me, setMe] = useState(null);
  useEffect(() => {
    if (!session) return;
    podiumopsGet('getMe', {}, session).then(setMe).catch(() => setMe({}));
  }, [session]);

  const org = useSection('getAnalyticsOrg', { months: 12 }, session);
  const perf = useSection('getAnalyticsPerf', { cycles: 4 }, session);
  const isComp = !!me?.tier?.comp;
  const comp = useSection('getAnalyticsComp', { months: 12 }, isComp ? session : null);

  return (
    <div>
      <Section title="Org & Headcount" state={org}>{(d) => <OrgSection d={d} />}</Section>
      {isComp && <Section title="Payroll Cost" state={comp}>{(d) => <CompSection d={d} />}</Section>}
      <Section title="Performance" state={perf}>{(d) => <PerfSection d={d} />}</Section>
    </div>
  );
}
```

Implementation notes: the comp section fetch passes `null` as session until `me.tier.comp` confirms membership — a non-member never even calls `getAnalyticsComp` (and if they did, the worker 403s and the section shows the error card — but it isn't rendered at all for non-members). `useSection`'s `load` depends only on `session` — params are constant per mount.

- [ ] **Step 3: Build**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npm run build --workspace=@throttle/podium
```

Expected: `next build` green, `/analytics` in the route list. (App-local change only — no `packages/*` touched, other apps don't need rebuilding.)

- [ ] **Step 4: Commit + push (auto-deploys via `deploy-podium.yml`)**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/podium/src/lib/nav.js "apps/podium/src/app/(auth)/analytics/page.js"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "podium: /analytics page — org/comp/perf charts (Phase 6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
```

---

### Task 4: In-app manual chapter (S105 upkeep rule — same PR as the screen)

**Files:**
- Create: `05_Throttle/apps/podium/docs/manual/content/analytics.html`
- Modify: `05_Throttle/apps/podium/docs/manual/manual.json` (Performance part + version bump 1.0.0 → 1.1.0, date 2026-07-07)
- Generated (must be committed): `apps/podium/src/data/manual.json`, `apps/podium/public/manual/*.pdf`, `docs/manual/Podium-Operations-Manual.pdf`

- [ ] **Step 1: Write the chapter** — `content/analytics.html`:

```html
<p class="lead">Analytics is the numbers view of Podium: how the team is growing, what it costs, and how performance is trending. Everything on this page is a total or an average &mdash; it never shows any individual person&rsquo;s pay or rating.</p>

<div class="glance">
  <div class="g-cell"><div class="g-lbl">What it&rsquo;s for</div><div class="g-val">Org, cost &amp; performance trends.</div></div>
  <div class="g-cell"><div class="g-lbl">Read or act?</div><div class="g-val">Read-only.</div></div>
  <div class="g-cell"><div class="g-lbl">Who</div><div class="g-val"><span class="role hr">HR</span> <span class="role adm">Admin</span></div></div>
  <div class="g-cell"><div class="g-lbl">Extra gate</div><div class="g-val">Payroll Cost: salary allow-list only.</div></div>
</div>

<h2 class="sec">The three sections</h2>
<table class="tbl">
  <thead><tr><th>Section</th><th>What it shows</th></tr></thead>
  <tbody>
    <tr><td><strong>Org &amp; Headcount</strong></td><td>Headcount by department and type, joiners vs exits by month, how long people have been here, and the attrition rate.</td></tr>
    <tr><td><strong>Payroll Cost</strong></td><td>Total annual CTC and the monthly cost it implies, cost by department, salary spread, and a plan-vs-actuals trend that fills in as real payouts are recorded. Only visible to the salary allow-list.</td></tr>
    <tr><td><strong>Performance</strong></td><td>Rating spread and participation for recent appraisal cycles, PIP count, and how actively observations, wins and 1:1s are being logged.</td></tr>
  </tbody>
</table>

<div class="callout note">
  <div class="c-title">&#9432; Aggregates only</div>
  <p>The Payroll Cost section is department totals and averages. To see a specific person&rsquo;s pay you still go to their profile &mdash; and that stays limited to the salary allow-list, with every view logged.</p>
</div>

<div class="callout note">
  <div class="c-title">&#9432; Empty charts are normal at first</div>
  <p>Cycle charts appear after the first appraisal cycle runs, and the &ldquo;actuals&rdquo; series fills in as payouts are recorded (automatically once the payroll connector is live). An empty chart means no data yet, not a fault.</p>
</div>
```

- [ ] **Step 2: Register the chapter** — in `manual.json`: bump `"version"` to `"1.1.0"` and `"date"` to `"2026-07-07"`; in the `"Performance"` part's `chapters` array, append:

```json
{ "id": "analytics", "title": "Analytics", "route": "/analytics", "file": "analytics.html", "roles": ["hr", "adm"] }
```

- [ ] **Step 3: Rebuild PDF + in-app data**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/apps/podium && python3 docs/manual/build.py
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && python3 scripts/build-manual-web.py podium
```

Expected: both scripts exit 0; `apps/podium/src/data/manual.json` + `apps/podium/public/manual/` PDF regenerate (CI only runs `next build`, so generated files MUST be committed).

- [ ] **Step 4: Rebuild the app (manual data is imported at build time) and commit everything**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle && npm run build --workspace=@throttle/podium
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/podium/docs/manual apps/podium/src/data/manual.json apps/podium/public/manual
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "podium: manual v1.1.0 — Analytics chapter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
```

---

### Task 5: Knowledge files + schema snapshot

**Files:**
- Modify: `systems/podium.md` (header + Worker actions + Frontend routes + Roadmap row 6 → Live)
- Modify: `BACKLOG.md` (mark Phase 6 analytics done; add browser-smoke pending note)
- Modify: `archive/BACKLOG_CHANGELOG.md` + `archive/SESSIONS.md` (session entry)
- Regenerate: `reference/db-schema.md` via `/schema-sync` (also catches the S195 `payouts`/`comp_access`/`comp_access_log` tables missing from the snapshot)

- [ ] **Step 1: Update `systems/podium.md`**

- Header: prepend a Session-196 line — Phase 6 analytics live (migration `podium_analytics_v1`, 3 aggregate RPCs, 3 worker actions, `/analytics` page, manual v1.1.0).
- Worker actions GET list: add `getAnalyticsOrg`/`getAnalyticsPerf` (hr) + `getAnalyticsComp` (comp allow-list, audited).
- Frontend routes: add `/analytics` (nav `podium_hr`; comp section allow-list-only).
- Roadmap: row 6 → `**Live (S97 sync · S196 analytics)**`.

- [ ] **Step 2: Update `BACKLOG.md`** — replace the open `[podium] Phase 6 — Analytics` line with nothing (closed items are deleted per the header rule); if browser smoke remains outstanding, fold one `[~]` line into the podium section: "Phase 6 analytics SHIPPED (S196) — authenticated browser smoke pending (HR sees org+perf; comp member sees Payroll Cost; non-HR gets no nav entry)."

- [ ] **Step 3: Run `/schema-sync`** (regenerates `reference/db-schema.md`; verify the podium section now lists `payouts`, `comp_access`, `comp_access_log`).

- [ ] **Step 4: Commit the workspace root**

```bash
cd /Users/afshaansiddiqui/Documents/Claude
git add -A
git commit -m "session: Podium Phase 6 analytics shipped [2026-07-07]"
git push
```

---

## Verification summary (rolled up)

| Check | Where | Expected |
|---|---|---|
| Org RPC totals | execute_sql | headcount 56; `unknown` tenure bucket = 28 |
| Comp RPC checksum | execute_sql | `annual_ctc_total = 49199007`; trend actuals all 0 |
| Perf RPC empty-safe | execute_sql | `cycles: []`, 12 activity rows, no error |
| Function grants | execute_sql | service_role only |
| Worker deploy | curl | ping pongs; analytics actions 401 without JWT |
| App build | npm | green, `/analytics` route present |
| comp_access_log row on `getAnalyticsComp` | execute_sql after browser smoke | one row, `action='getAnalyticsComp'` |
| Browser smoke (Afshaan) | podium.legendoftoys.com/analytics | HR/admin sees org+perf; allow-list member sees Payroll Cost; non-HR has no nav entry |
