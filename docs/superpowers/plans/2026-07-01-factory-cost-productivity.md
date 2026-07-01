# Factory Cost & Productivity Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Day-to-day factory cost-per-unit (production-only, full, and monthly loaded) + per-capita operator productivity for the production team, with salaries held confidentially in a new Podium factory module.

**Architecture:** Salaries + fixed/overhead cost inputs live in new `podium.factory_*` tables (source of truth, service_role-only, managed only in a Podium admin surface). The cost math is done entirely in Postgres RPCs (`public.f_factory_*`) that read `podium.factory_*` + `public.operator_attendance` + `public.scans/units` and return **aggregates only** — individual salaries never leave the DB. lotopsproxy exposes three perm-gated read actions that just call the RPCs; Redline renders the views.

**Tech Stack:** Supabase Postgres (migrations + RPCs), Cloudflare Workers (podiumops, lotopsproxy — plain JS), Next.js apps (apps/podium, apps/redline).

**Verification model (LOT, not TDD):** migrations → `execute_sql` schema/row checks; RPCs → `execute_sql` with real dates; worker actions → `curl` smoke against the deployed worker; UI → `next build` + authenticated browser smoke. Sequence every worker change: edit → commit → push → `cd <dir> && npx wrangler deploy`.

**Key facts (verified 2026-07-01):**
- Units = distinct cars at PKG_OUT, IST day: `scans⋈units`, `station='PKG_OUT'`, `voided=false`, `units.component_type='car'`, product=`units.product`.
- Present = has an `operator_attendance` row that date (`day_status` is 100% null today; guard `coalesce(day_status,'') not in ('absent','leave')`).
- OT: `operator_attendance.overtime_minutes` (int). v1 OT rate = avg(96,103)=99.50/hr.
- Depts in `public.operators.department`: assembly, qc, packaging, store, dispatch, admin.
- lotopsproxy helpers: `sbPublic`/`queryPublic`, `rpcPublic(fn,body)`, `ok(data)`, `err(msg,status)`, `nowIST()`, `istDateString(d)`; permissions object `P`; big `switch (body.action)` (manpower cases ~line 18743).
- podiumops helpers: `sb(path,env)` (podium profile), `sbStore`, `ok`/`err`, `verifyJWT`, `canComp(auth)`; handlers registered in `GET_ACTIONS`/`POST_ACTIONS` (index.js ~1673); `podium_view` gate + per-handler `canComp`.

---

## Phase A — Podium factory cost module (source of truth)

### Task A1: Migration `podium_factory_cost_v1`

**Files:** apply via `mcp__supabase apply_migration` (name `podium_factory_cost_v1`).

- [ ] **Step 1: Apply the migration**

```sql
-- podium factory cost module (RLS-on, service_role-only; effective-dated)
create table if not exists podium.factory_ranks (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  label text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists podium.factory_workforce (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null unique references public.operators(id),
  rank_id uuid references podium.factory_ranks(id),
  employment_type text not null default 'in_house' check (employment_type in ('in_house','contract')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists podium.factory_pay (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id),
  effective_from date not null,
  monthly_ctc numeric(12,2) not null,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists factory_pay_op_eff on podium.factory_pay(operator_id, effective_from desc);

create table if not exists podium.factory_cost_inputs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('rent','electricity','other','admin','security')),
  label text not null,
  effective_from date not null,
  monthly_amount numeric(12,2) not null,
  is_estimated boolean not null default false,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid
);
create index if not exists factory_cost_inputs_kind_eff on podium.factory_cost_inputs(kind, label, effective_from desc);

create table if not exists podium.factory_ot_rates (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null,
  in_house_per_hour numeric(8,2) not null,
  contract_per_hour numeric(8,2) not null,
  created_at timestamptz not null default now()
);

-- RLS on + service_role only (RULE-RLS-001)
alter table podium.factory_ranks        enable row level security;
alter table podium.factory_workforce    enable row level security;
alter table podium.factory_pay          enable row level security;
alter table podium.factory_cost_inputs  enable row level security;
alter table podium.factory_ot_rates     enable row level security;
grant all on podium.factory_ranks, podium.factory_workforce, podium.factory_pay,
             podium.factory_cost_inputs, podium.factory_ot_rates to service_role;

-- seed: OT rates + a starter rank set (pay + fixed costs seeded later from the Excel)
insert into podium.factory_ot_rates (effective_from, in_house_per_hour, contract_per_hour)
values ('2026-01-01', 96.00, 103.00) on conflict do nothing;
insert into podium.factory_ranks (code, label, sort_order) values
  ('helper','Helper',10),('operator','Operator',20),
  ('senior_op','Senior Operator',30),('line_lead','Line Lead',40)
on conflict (code) do nothing;
```

- [ ] **Step 2: Verify tables + RLS + grants**

```sql
select table_name from information_schema.tables where table_schema='podium' and table_name like 'factory_%' order by 1;
select relname, relrowsecurity from pg_class where relnamespace='podium'::regnamespace and relname like 'factory_%';
select * from podium.factory_ot_rates;
```
Expected: 5 tables, all `relrowsecurity=t`, one OT-rate row (96/103), 4 ranks.

- [ ] **Step 3: Advisor check** — run `mcp__supabase get_advisors` (type `security`); expect no new errors for the factory tables (RLS on = clean).

---

### Task A2: podiumops handlers

**Files:** Modify `05_Throttle/podiumops-worker/src/index.js`.

All handlers gated on `canComp(auth)` (compensation tier) — salaries are comp data. Add near the other admin handlers (before the `GET_ACTIONS`/`POST_ACTIONS` maps ~line 1673).

- [ ] **Step 1: Add the handler functions**

```js
// ── Factory cost module (compensation-tier; source of truth for cost engine) ──
function requireComp(auth) { if (!canComp(auth)) throw new Error('forbidden — compensation permission required'); }

async function getFactoryWorkforce(url, auth, env) {
  requireComp(auth);
  // operators (floor) + their factory row + current pay; salaries visible ONLY here (comp tier)
  const ops = await fetch(`${env.SUPABASE_URL}/rest/v1/operators?select=id,employee_id,name,department,status,employment_type&order=department,name`, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  }).then(r => r.json());
  const wf   = (await sb(`/rest/v1/factory_workforce?select=*`, env)).data || [];
  const pay  = (await sb(`/rest/v1/factory_pay?select=operator_id,effective_from,monthly_ctc&order=effective_from.desc`, env)).data || [];
  const ranks= (await sb(`/rest/v1/factory_ranks?select=*&order=sort_order`, env)).data || [];
  const wfBy = {}; for (const w of wf) wfBy[w.operator_id] = w;
  const curPay = {}; for (const p of pay) if (!curPay[p.operator_id]) curPay[p.operator_id] = p; // latest
  const rows = (Array.isArray(ops) ? ops : []).map(o => ({
    ...o, factory: wfBy[o.id] || null, current_ctc: curPay[o.id]?.monthly_ctc ?? null,
    current_ctc_from: curPay[o.id]?.effective_from ?? null,
  }));
  return ok({ operators: rows, ranks });
}

async function getFactoryCostInputs(url, auth, env) {
  requireComp(auth);
  const r = await sb(`/rest/v1/factory_cost_inputs?select=*&order=kind,label,effective_from.desc`, env);
  const rates = await sb(`/rest/v1/factory_ot_rates?select=*&order=effective_from.desc`, env);
  return ok({ cost_inputs: r.data || [], ot_rates: rates.data || [] });
}

async function setFactoryWorkforce(body, auth, env) {
  requireComp(auth);
  const d = body.data || body;
  if (!d.operator_id) return err('operator_id required');
  const row = { operator_id: d.operator_id, rank_id: d.rank_id ?? null,
    employment_type: d.employment_type === 'contract' ? 'contract' : 'in_house',
    active: d.active !== false, updated_at: new Date().toISOString() };
  const r = await sb(`/rest/v1/factory_workforce`, env, {
    method: 'POST', body: JSON.stringify(row),
    prefer: 'return=representation,resolution=merge-duplicates', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  if (!r.ok) return err('workforce upsert failed: ' + JSON.stringify(r.data));
  return ok(r.data?.[0] || r.data);
}

async function setFactoryPay(body, auth, env) {
  requireComp(auth);
  const d = body.data || body;
  if (!d.operator_id || d.monthly_ctc == null || !d.effective_from) return err('operator_id, monthly_ctc, effective_from required');
  const r = await sb(`/rest/v1/factory_pay`, env, {
    method: 'POST',
    body: JSON.stringify({ operator_id: d.operator_id, effective_from: d.effective_from,
      monthly_ctc: Number(d.monthly_ctc), note: d.note || null, created_by: auth.userId || null }),
    prefer: 'return=representation',
  });
  if (!r.ok) return err('pay insert failed: ' + JSON.stringify(r.data));
  return ok(r.data?.[0]);
}

async function bulkUploadFactoryPay(body, auth, env) {
  requireComp(auth);
  const d = body.data || body;
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (!rows.length) return err('rows required');
  // resolve operator_id by employee_id (fallback exact name)
  const ops = await fetch(`${env.SUPABASE_URL}/rest/v1/operators?select=id,employee_id,name`, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
  }).then(r => r.json());
  const byEmp = {}, byName = {};
  for (const o of (Array.isArray(ops) ? ops : [])) { if (o.employee_id) byEmp[String(o.employee_id).trim().toLowerCase()] = o.id; if (o.name) byName[String(o.name).trim().toLowerCase()] = o.id; }
  const matched = [], unmatched = [], wfRows = [], payRows = [];
  const eff = d.effective_from || (new Date().toISOString().slice(0,8) + '01');
  for (const r of rows) {
    const key = String(r.employee_id || '').trim().toLowerCase();
    const nkey = String(r.name || '').trim().toLowerCase();
    const opId = byEmp[key] || byName[nkey] || null;
    if (!opId || r.monthly_ctc == null) { unmatched.push(r); continue; }
    matched.push({ ...r, operator_id: opId });
    payRows.push({ operator_id: opId, effective_from: r.effective_from || eff, monthly_ctc: Number(r.monthly_ctc), note: 'bulk upload', created_by: auth.userId || null });
    wfRows.push({ operator_id: opId, employment_type: r.employment_type === 'contract' ? 'contract' : 'in_house', active: true, updated_at: new Date().toISOString() });
  }
  if (wfRows.length) await sb(`/rest/v1/factory_workforce`, env, { method: 'POST', body: JSON.stringify(wfRows), headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } });
  if (payRows.length) await sb(`/rest/v1/factory_pay`, env, { method: 'POST', body: JSON.stringify(payRows), prefer: 'return=minimal' });
  return ok({ inserted: payRows.length, matched: matched.length, unmatched });
}

async function setFactoryCostInput(body, auth, env) {
  requireComp(auth);
  const d = body.data || body;
  if (!d.kind || !d.label || d.monthly_amount == null || !d.effective_from) return err('kind, label, monthly_amount, effective_from required');
  const r = await sb(`/rest/v1/factory_cost_inputs`, env, {
    method: 'POST',
    body: JSON.stringify({ kind: d.kind, label: d.label, effective_from: d.effective_from,
      monthly_amount: Number(d.monthly_amount), is_estimated: !!d.is_estimated, note: d.note || null, created_by: auth.userId || null }),
    prefer: 'return=representation',
  });
  if (!r.ok) return err('cost input insert failed: ' + JSON.stringify(r.data));
  return ok(r.data?.[0]);
}

async function setFactoryOtRates(body, auth, env) {
  requireComp(auth);
  const d = body.data || body;
  if (d.in_house_per_hour == null || d.contract_per_hour == null || !d.effective_from) return err('in_house_per_hour, contract_per_hour, effective_from required');
  const r = await sb(`/rest/v1/factory_ot_rates`, env, {
    method: 'POST',
    body: JSON.stringify({ effective_from: d.effective_from, in_house_per_hour: Number(d.in_house_per_hour), contract_per_hour: Number(d.contract_per_hour) }),
    prefer: 'return=representation',
  });
  if (!r.ok) return err('ot rate insert failed: ' + JSON.stringify(r.data));
  return ok(r.data?.[0]);
}
```

Note: `sb(path, env, opts)` sends the podium profile. Its `opts.prefer` maps to the `Prefer` header (see the existing `sb` helper); where upsert dedup is needed, pass `headers:{Prefer:'resolution=merge-duplicates,...'}` explicitly as shown.

- [ ] **Step 2: Register the actions** — in `GET_ACTIONS` (index.js ~1673) add:

```js
  getFactoryWorkforce, getFactoryCostInputs,
```
and in `POST_ACTIONS`:

```js
  setFactoryWorkforce, setFactoryPay, bulkUploadFactoryPay, setFactoryCostInput, setFactoryOtRates,
```
Do NOT add them to `SELF_SERVE_*` (they require full `podium_view` + `canComp`).

- [ ] **Step 3: Commit + push + deploy**

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add podiumops-worker/src/index.js
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "podiumops: factory cost module handlers (workforce/pay/cost-inputs/ot, comp-gated)"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/podiumops-worker && npx wrangler deploy
```

- [ ] **Step 4: curl smoke** (needs a podium_comp JWT — do in browser or with a token):
Confirm `GET ...?action=getFactoryCostInputs` returns `{ok:true,data:{cost_inputs:[],ot_rates:[{in_house_per_hour:"96.00"...}]}}` and returns 403 for a non-comp user.

---

### Task A3: Podium admin UI — Factory Cost page

**Files:**
- Create: `05_Throttle/apps/podium/src/app/(auth)/admin/factory-cost/page.js`
- Modify: `05_Throttle/apps/podium/src/lib/nav.js` (add nav item)
- Reference for style/data-call pattern: `apps/podium/src/app/(auth)/admin/settings/page.js` + `apps/podium/src/app/(auth)/people/page.js`

- [ ] **Step 1: Add the nav entry** — in `nav.js`, inside the `admin` group `items` array (after `settings`):

```js
      { id: 'factory-cost', label: 'Factory Cost', route: '/admin/factory-cost', icon: Factory, requires: 'podium_comp' },
```
Add `Factory` to the lucide import at the top of `nav.js` (`import { ... , Factory } from 'lucide-react';`). Also gate at page level: `if (perms && !perms.podium_comp) return <div>Requires podium_comp.</div>;` (mirror the settings page guard).

- [ ] **Step 2: Build the page** — three sections using the app's existing fetch helper (same `workerFetch`/`podiumFetch` the sibling admin pages use; copy their import). Sections:
  1. **Workforce & pay** — table from `getFactoryWorkforce` (`operators[]` with `current_ctc`, `department`, `factory.rank_id`, `factory.employment_type`). Inline: set rank (`<select>` from `ranks`), employment_type (in_house/contract) → `setFactoryWorkforce`; "Add pay" (effective_from + monthly_ctc) → `setFactoryPay`. **Salaries render here only.**
  2. **Bulk upload** — a textarea to paste CSV (`employee_id,name,monthly_ctc,employment_type,effective_from`) → parse client-side to `rows[]` → `bulkUploadFactoryPay` → show `{inserted, matched, unmatched[]}`.
  3. **Fixed & overhead + OT** — from `getFactoryCostInputs`: list `cost_inputs` grouped by kind; add form (kind select rent/electricity/other/admin/security, label, monthly_amount, effective_from, is_estimated) → `setFactoryCostInput`; OT rates form (in_house/hr, contract/hr, effective_from) → `setFactoryOtRates`.

  Follow the settings page's card/table styling and CSS vars. Keep it functional, not fancy.

- [ ] **Step 3: Build check + commit + push (auto-deploys via deploy workflow)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/apps/podium && npm run build
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/podium/src
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "podium: Factory Cost admin page (workforce/pay/cost-inputs/OT, comp-gated)"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
```
Expected: `next build` green.

- [ ] **Step 4: Seed data (manual, gated on Afshaan's Excel)** — once the salary Excel is provided, paste it into the Bulk upload; add rent + electricity(estimated) + security + admin cost inputs. (Blocked until the sheet arrives — do not fabricate figures.)

---

## Phase B — Cost engine (RPCs) + Redline views

### Task B1: Migration `factory_cost_rpcs_v1` (the cost math)

**Files:** apply via `apply_migration` (name `factory_cost_rpcs_v1`). Functions in `public`, SECURITY INVOKER (service_role has rights on `podium.factory_*`), schema-qualified, EXECUTE to service_role. Return jsonb aggregates only.

- [ ] **Step 1: Apply the migration**

```sql
-- Mon–Sat working-day count in [d1,d2] inclusive
create or replace function public.working_days(d1 date, d2 date)
returns int language sql immutable as $$
  select count(*)::int from generate_series(d1, d2, interval '1 day') g
  where extract(dow from g) <> 0;
$$;

-- present operators (has attendance row, not absent/leave) with dept + OT, and effective daily pay
create or replace function public._factory_daycost(p_from date, p_to date, p_wd int, p_ot_rate numeric)
returns table(the_date date, department text, daycost numeric, ot_cost numeric) language sql stable as $$
  select oa.date, o.department,
         coalesce(fp.monthly_ctc,0)/nullif(p_wd,0) + coalesce(oa.overtime_minutes,0)/60.0*p_ot_rate,
         coalesce(oa.overtime_minutes,0)/60.0*p_ot_rate
  from public.operator_attendance oa
  join public.operators o on o.id = oa.operator_id
  left join lateral (
    select monthly_ctc from podium.factory_pay fp
    where fp.operator_id = oa.operator_id and fp.effective_from <= oa.date
    order by fp.effective_from desc limit 1
  ) fp on true
  where oa.date between p_from and p_to
    and coalesce(oa.day_status,'') not in ('absent','leave');
$$;

-- cars packed out (IST day) per product in a date range
create or replace function public._factory_cars(p_from date, p_to date)
returns table(the_date date, product text, cars int) language sql stable as $$
  select (s."timestamp" at time zone 'Asia/Kolkata')::date, u.product, count(distinct s.upc)::int
  from public.scans s join public.units u on u.upc = s.upc
  where s.station = 'PKG_OUT' and coalesce(s.voided,false) = false and u.component_type = 'car'
    and (s."timestamp" at time zone 'Asia/Kolkata')::date between p_from and p_to
  group by 1,2;
$$;

-- active (latest per kind+label) cost inputs effective on a date
create or replace function public._factory_costinputs(p_on date)
returns table(kind text, monthly_amount numeric) language sql stable as $$
  select distinct on (kind,label) kind, monthly_amount
  from podium.factory_cost_inputs where effective_from <= p_on
  order by kind, label, effective_from desc;
$$;

-- DAILY: views 2 & 3 + per-product breakdown
create or replace function public.f_factory_cost_daily(p_date date)
returns jsonb language plpgsql stable as $$
declare
  m_start date := date_trunc('month', p_date)::date;
  m_end   date := (date_trunc('month', p_date) + interval '1 month - 1 day')::date;
  wd int := public.working_days(m_start, m_end);
  ot_rate numeric;
  prod_mp numeric; store_mp numeric; disp_mp numeric; ot_total numeric;
  fixed_daily numeric; overhead_daily numeric;
  total_cars int; pool_v2 numeric; pool_v3 numeric;
  per_prod jsonb;
begin
  select (in_house_per_hour+contract_per_hour)/2 into ot_rate
    from podium.factory_ot_rates where effective_from <= p_date order by effective_from desc limit 1;
  ot_rate := coalesce(ot_rate, 99.5);

  select coalesce(sum(daycost) filter (where department in ('assembly','qc','packaging')),0),
         coalesce(sum(daycost) filter (where department = 'store'),0),
         coalesce(sum(daycost) filter (where department = 'dispatch'),0),
         coalesce(sum(ot_cost),0)
    into prod_mp, store_mp, disp_mp, ot_total
    from public._factory_daycost(p_date, p_date, wd, ot_rate);

  select coalesce(sum(monthly_amount) filter (where kind in ('rent','electricity','other')),0)/nullif(wd,0),
         coalesce(sum(monthly_amount) filter (where kind in ('admin','security')),0)/nullif(wd,0)
    into fixed_daily, overhead_daily from public._factory_costinputs(p_date);
  fixed_daily := coalesce(fixed_daily,0); overhead_daily := coalesce(overhead_daily,0);

  select coalesce(sum(cars),0) into total_cars from public._factory_cars(p_date, p_date);
  pool_v2 := prod_mp + fixed_daily;
  pool_v3 := pool_v2 + store_mp + disp_mp + overhead_daily;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product', product, 'cars', cars,
           'v2_alloc', round(pool_v2 * cars / nullif(total_cars,0), 2),
           'v2_per_unit', round(pool_v2 / nullif(total_cars,0), 2),
           'v3_alloc', round(pool_v3 * cars / nullif(total_cars,0), 2),
           'v3_per_unit', round(pool_v3 / nullif(total_cars,0), 2)
         ) order by cars desc), '[]'::jsonb)
    into per_prod from public._factory_cars(p_date, p_date);

  return jsonb_build_object(
    'date', p_date, 'working_days', wd, 'ot_rate', ot_rate, 'cars_total', total_cars,
    'v2', jsonb_build_object('pool', round(pool_v2,2), 'per_unit', round(pool_v2/nullif(total_cars,0),2)),
    'v3', jsonb_build_object('pool', round(pool_v3,2), 'per_unit', round(pool_v3/nullif(total_cars,0),2)),
    'breakdown', jsonb_build_object('prod_manpower', round(prod_mp,2), 'store_manpower', round(store_mp,2),
        'dispatch_manpower', round(disp_mp,2), 'fixed', round(fixed_daily,2),
        'overhead', round(overhead_daily,2), 'ot_total', round(ot_total,2)),
    'per_product', per_prod);
end; $$;

-- MONTHLY: loaded per-unit + daily V3 strip (partial month = elapsed working days)
create or replace function public.f_factory_cost_monthly(p_month date)
returns jsonb language plpgsql stable as $$
declare
  m_start date := date_trunc('month', p_month)::date;
  m_end   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  today_ist date := (now() at time zone 'Asia/Kolkata')::date;
  r_end date := least(m_end, today_ist);
  wd int := public.working_days(m_start, m_end);
  elapsed_wd int := public.working_days(m_start, r_end);
  ot_rate numeric; manpower numeric; fixed_over numeric; total_cars int; daily jsonb;
begin
  if r_end < m_start then return jsonb_build_object('month', to_char(p_month,'YYYY-MM'), 'cars_total', 0); end if;
  select (in_house_per_hour+contract_per_hour)/2 into ot_rate
    from podium.factory_ot_rates where effective_from <= r_end order by effective_from desc limit 1;
  ot_rate := coalesce(ot_rate, 99.5);

  -- manpower for prod+store+dispatch present rows across the elapsed range (admin excluded → overhead line)
  select coalesce(sum(daycost) filter (where department in ('assembly','qc','packaging','store','dispatch')),0)
    into manpower from public._factory_daycost(m_start, r_end, wd, ot_rate);

  -- fixed+overhead monthly totals spread over elapsed working days
  select coalesce(sum(monthly_amount),0)/nullif(wd,0)*elapsed_wd
    into fixed_over from public._factory_costinputs(r_end);
  fixed_over := coalesce(fixed_over,0);

  select coalesce(sum(cars),0) into total_cars from public._factory_cars(m_start, r_end);

  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) into daily from (
    select jsonb_build_object('date', d.the_date, 'cars', coalesce(c.cars,0)) as x
    from (select distinct the_date from public._factory_cars(m_start, r_end)) d
    left join (select the_date, sum(cars) cars from public._factory_cars(m_start, r_end) group by 1) c on c.the_date=d.the_date
  ) q;

  return jsonb_build_object('month', to_char(p_month,'YYYY-MM'),
    'working_days', wd, 'elapsed_working_days', elapsed_wd, 'cars_total', total_cars,
    'month_cost', round(manpower+fixed_over,2),
    'per_unit', round((manpower+fixed_over)/nullif(total_cars,0),2),
    'categories', jsonb_build_object('manpower', round(manpower,2), 'fixed_overhead', round(fixed_over,2)),
    'daily', daily);
end; $$;

-- PRODUCTIVITY: per-capita units/operator/day by dept
create or replace function public.f_factory_productivity(p_from date, p_to date)
returns jsonb language plpgsql stable as $$
declare rows jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'date', a.date, 'dept', a.department, 'present', a.present,
      'cars', coalesce(c.cars,0),
      'per_capita', round(coalesce(c.cars,0)::numeric / nullif(a.present,0), 2)
    ) order by a.date desc, a.department), '[]'::jsonb) into rows
  from (
    select oa.date, o.department, count(distinct oa.operator_id) present
    from public.operator_attendance oa join public.operators o on o.id=oa.operator_id
    where oa.date between p_from and p_to
      and o.department in ('assembly','qc','packaging','store','dispatch')
      and coalesce(oa.day_status,'') not in ('absent','leave')
    group by 1,2
  ) a
  left join (select the_date, sum(cars) cars from public._factory_cars(p_from,p_to) group by 1) c
    on c.the_date = a.date;
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', rows);
end; $$;

grant execute on function public.working_days(date,date),
  public.f_factory_cost_daily(date), public.f_factory_cost_monthly(date),
  public.f_factory_productivity(date,date) to service_role;
```

- [ ] **Step 2: Verify against real data**

```sql
select public.f_factory_cost_daily('2026-06-30');      -- cars_total ~821; pools 0 until salaries seeded (fixed/overhead still apply once seeded)
select public.f_factory_cost_monthly('2026-06-15');    -- cars_total = June cars; per_unit computes once inputs seeded
select public.f_factory_productivity('2026-06-25','2026-07-01');  -- per-dept present + per_capita rows
```
Expected: valid jsonb; `cars_total` matches the verified counts (2026-06-30 ≈ 821). Cost pools are 0 until pay/fixed inputs are seeded — that's correct (no data yet), the shapes are what matters.

---

### Task B2: lotopsproxy cost engine actions + permission

**Files:**
- Modify: `01_worker/worker.js` (new `canViewCost` helper near line 41; three `case`s in the manpower area ~line 18820)
- Modify: Garage `/users` PERM_DEFS (add `factory_cost_view`) — find with `grep -n "PERM_DEFS\|production_view" 05_Throttle/apps/garage/src/app/(auth)/users/page.js` (or wherever PERM_DEFS lives) and add the key so it's grantable.

- [ ] **Step 1: Add the permission helper** (worker.js ~line 51, after the other `can*` helpers):

```js
// Factory cost/productivity views — strictly leadership; NOT blanket canManageFloor.
const canViewCost = p => !!p.factory_cost_view;
```

- [ ] **Step 2: Add the three cases** (in the JWT-authed `switch (body.action)`, beside `getManpowerAnalytics` ~line 18755):

```js
          case 'getFactoryCostDaily': {
            if (!canViewCost(P)) return err('No permission to view costs', 403);
            const d = body.data || body;
            const date = d.date || istDateString(nowIST());
            const r = await rpcPublic('f_factory_cost_daily', { p_date: date });
            if (!r.ok) return err('cost daily failed: ' + JSON.stringify(r.data));
            return ok(r.data);
          }
          case 'getFactoryCostMonthly': {
            if (!canViewCost(P)) return err('No permission to view costs', 403);
            const d = body.data || body;
            const month = d.month || istDateString(nowIST());
            const r = await rpcPublic('f_factory_cost_monthly', { p_month: month });
            if (!r.ok) return err('cost monthly failed: ' + JSON.stringify(r.data));
            return ok(r.data);
          }
          case 'getFactoryProductivity': {
            if (!canViewCost(P)) return err('No permission to view productivity', 403);
            const d = body.data || body;
            if (!d.from || !d.to) return err('from and to required');
            const r = await rpcPublic('f_factory_productivity', { p_from: d.from, p_to: d.to });
            if (!r.ok) return err('productivity failed: ' + JSON.stringify(r.data));
            return ok(r.data);
          }
```
`p_date`/`p_month`/`p_from`/`p_to` are accepted by PostgREST as `date` from ISO strings (`YYYY-MM-DD`).

- [ ] **Step 3: Make `factory_cost_view` grantable** — add to the Garage `/users` PERM_DEFS array a row like the existing ones, e.g. `{ key:'factory_cost_view', label:'Factory Costs', group:'Reports' }` (match the surrounding shape). This is a Garage app edit → single-app, no cross-legacy-folder issue.

- [ ] **Step 4: Commit + push + deploy** (lotopsproxy = 3-system blast radius — deploy carefully):

```bash
git -C /Users/afshaansiddiqui/Documents/Claude/01_worker add worker.js
git -C /Users/afshaansiddiqui/Documents/Claude/01_worker commit -m "lotopsproxy: factory cost/productivity read actions (factory_cost_view-gated)"
git -C /Users/afshaansiddiqui/Documents/Claude/01_worker push
cd /Users/afshaansiddiqui/Documents/Claude/01_worker && npx wrangler deploy
# Garage PERM_DEFS edit:
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/garage/src && git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "garage: add factory_cost_view perm key" && git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
```

- [ ] **Step 5: Grant the perm** (apply_migration or execute_sql) — grant `factory_cost_view` to the leadership roles ONLY. First inspect, then set:

```sql
select role_id, permissions->>'factory_cost_view' from store.roles order by role_id;
-- then, for each leadership role_id (confirm with Afshaan), e.g. admin + production_manager:
update store.roles set permissions = permissions || '{"factory_cost_view":true}'::jsonb
 where role_id in ('admin','production_manager');  -- CONFIRM the exact role_ids first
```

- [ ] **Step 6: curl smoke** (with a leadership JWT): `POST {action:'getFactoryCostDaily', data:{date:'2026-06-30'}}` returns the daily jsonb; a non-leadership JWT returns 403.

---

### Task B3: Redline "Costs & Productivity" views

**Files:**
- Modify: `05_Throttle/apps/redline/src/lib/nav.js` (new nav group)
- Create: `05_Throttle/apps/redline/src/app/(auth)/costs/page.js` (Daily)
- Create: `05_Throttle/apps/redline/src/app/(auth)/costs/monthly/page.js`
- Create: `05_Throttle/apps/redline/src/app/(auth)/costs/productivity/page.js`
- Reference: `apps/redline/src/app/(auth)/manpower/page.js` (data-fetch + table/chart patterns, `workerFetch`) and `/reporting` for chart style.

- [ ] **Step 1: Add the nav group** — in `nav.js` `NAV_PRIMARY`, after `reports`:

```js
  {
    id: 'costs', label: 'Costs', icon: Coins, perm: 'factory_cost_view',
    children: [
      { id: 'costs-daily',   label: 'Daily Cost',   route: '/costs',              icon: Coins },
      { id: 'costs-monthly', label: 'Monthly Cost',  route: '/costs/monthly',      icon: BarChart3 },
      { id: 'productivity',  label: 'Productivity',  route: '/costs/productivity', icon: Users },
    ],
  },
```
Add `Coins` to the lucide import at the top of `nav.js`. Confirm the nav filter respects `perm` on a group (it does — groups carry `perm`; verify against `RedlineSidebar.js` filtering).

- [ ] **Step 2: Daily page** (`costs/page.js`) — date picker (default today IST); call `workerFetch({action:'getFactoryCostDaily', data:{date}})`. Render: V2 & V3 headline ₹/unit cards; a per-product table (product, cars, v3_alloc, v3_per_unit); a category breakdown row (prod_manpower/store/dispatch/fixed/overhead/ot_total). No names, no salaries. Guard: if `!perms.factory_cost_view` show "Requires factory_cost_view."

- [ ] **Step 3: Monthly page** (`costs/monthly/page.js`) — month picker; `getFactoryCostMonthly`. Render loaded ₹/unit headline + categories split + a simple bar/line of the `daily[]` cars strip.

- [ ] **Step 4: Productivity page** (`costs/productivity/page.js`) — date-range (default last 7 days); `getFactoryProductivity`. Render a table/chart of per-capita by dept (date, dept, present, cars, per_capita).

- [ ] **Step 5: Build + commit + push (auto-deploys)**

```bash
cd /Users/afshaansiddiqui/Documents/Claude/05_Throttle/apps/redline && npm run build
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle add apps/redline/src
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle commit -m "redline: Costs & Productivity views (factory_cost_view-gated)"
git -C /Users/afshaansiddiqui/Documents/Claude/05_Throttle push
```
Expected: `next build` green.

- [ ] **Step 6: Authenticated browser smoke** — as a leadership user, open Redline → Costs → Daily/Monthly/Productivity; confirm numbers render (cost pools will be 0 until salaries+fixed costs are seeded; cars + per-capita productivity should show real numbers immediately). Confirm the Costs group is hidden for a non-leadership login.

---

## Post-build: knowledge files (session end)

- [ ] Update `systems/lotops.md` (Costs & Productivity views + factory_cost_view) and/or `systems/podium.md` (factory cost module).
- [ ] Add `RULE-COST-001` to `BUSINESS_RULES.md` capturing the costing invariants (working-days Mon–Sat daily rate, present-operator attendance basis, unit-share split, avg OT 99.5, admin/security as overhead lines not attendance-costed, aggregates-only boundary).
- [ ] Add the new perm key + tables to `CORE.md` (podium schema line + permission model).
- [ ] Remove/replace any related BACKLOG line; append a SESSIONS note.

---

## Self-review notes (coverage vs spec)

- Spec §3 formulas → Task B1 RPCs (daily V2/V3, monthly loaded w/ partial-month, per-capita productivity). ✓
- Spec §4 data model → Task A1 (5 tables, effective-dated, RLS+grants). ✓
- Spec §5 Podium admin + bulk upload → Tasks A2/A3. ✓
- Spec §6 engine aggregates-only + Redline views + `factory_cost_view` → Tasks B1/B2/B3 (math lives in RPCs; worker returns jsonb; salaries never serialized). ✓
- Spec §2 double-count guard (admin dept excluded from pools, carried by `admin` overhead line) → encoded in `f_factory_cost_daily`/`_monthly` dept filters. ✓
- Spec §7 permissions → `canViewCost`/`factory_cost_view` (B2) + `podium_comp` gate (A2/A3). ✓
- Open inputs (Excel, seed amounts, security/admin operator identification) → A3 Step 4 (manual, gated on Afshaan). ✓
```
