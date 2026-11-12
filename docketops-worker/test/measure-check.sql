-- F9 R9b (migration 0029) — the measure auto-check: the strict target parser by unit, every registry metric
-- against an independent query over a fixed past IST window (0 on no rows, first-pass yield as distinct car units,
-- unrounded), measure_check's scope (agreed + auto-checkable only), reached true / false / null, ceilings held until
-- the due date, one failing item counted as `errored` (a throw-away reading that raises, rolled back with the block),
-- the same-day upsert, the latest-reading view, the cron job and the grants.
-- One DO block that always rolls back (ends by raising RESULT …). Before 0029 is applied it runs the migration
-- inside the block (execute $mig$ … $mig$, generated verbatim from migrations/0029_measure_check.sql); after,
-- it only checks. Run via execute_sql. Section 2 reads LIVE source tables; a window ending 2 days ago keeps it
-- stable while the floor keeps scanning.
-- EXPECT: 1:>=98,null,>=15900000,null,<=30,>=250000,null,null,null,>5000,null,>=200000,null,=7,<0.5,>=15000000,null,>=12345,null,null,null
--   2:match,null,null,null,0,0,null,false
--   3:ZZMC.M1=true,ZZMC.M1.R1=true,ZZMC.M2=false,ZZMC.M3=null/unparsed,ZZMC.M7=null/unparsed,ZZMC.M8=null,ZZMC.M9=true,win,future,json
--   4:1,true/retargeted,2,latest,5  5:1,false,false,false,true
do $mcheck$
declare
  E1 uuid := (select id from podium.employees where status = 'active' order by id limit 1);
  today date := (now() at time zone 'Asia/Kolkata')::date;
  wf date; wt date; v numeric; th uuid; m1 uuid; m2 uuid; m3 uuid; m9 uuid; r1 uuid; j jsonb; out text := ''; agg text;
begin
  if to_regclass('docket.plan_measure_readings') is null then
    execute $mig$
-- 0029_measure_check.sql — F9 R9b (docket_measure_check_v1): the measure auto-check (spec §4.4, P2).
-- Every day at 06:00 IST pg_cron runs docket.measure_check(): for each AGREED milestone / result whose measure
-- names an auto-checkable registry metric (src/plan-metrics.mjs MEASURE_CHECK_UNITS — the v_units constant below,
-- key → unit, kept equal by test/measure-keys.test.mjs) it reads the metric over the trailing 30 IST days to the
-- item's effective due date (or today, if earlier) and stores ONE reading per item per IST day (a re-run upserts).
-- The reading is compared with the measure's target when the target parses strictly FOR THAT METRIC'S UNIT
-- (plan_target_parse); otherwise `reached` stays null. One item failing is counted (`errored`) and the run goes
-- on. Silent — no Slack, no email; the worker shows the readings and the founders' confirm queue, and
-- confirming is still the existing `done` action. The worker keeps no cron of its own (decisions 2026-08-25),
-- as with docket.week_tick.
--
-- plan_metric_reading has ONE fixed SQL branch per registry key — never dynamic SQL. Every source table and
-- column was checked live (information_schema.columns, 2026-11-12) before its branch was written. Odo:
-- spend and sessions reuse the very functions Odo's own pages sum (sales.f_mkt_rollup / f_traffic_rollup);
-- net revenue ex-GST has NO SQL definition (Odo derives it at display, apps/odo/src/lib/segregation.js), so
-- its branch returns null and the registry marks it auto_check: false — the checker never re-derives revenue.
--
-- Additive + idempotent. Table: RLS on, no policies (service_role only). Functions: service_role only.
-- Applied by the lane before the worker that reads plan_measure_latest deploys.

-- ── readings ─────────────────────────────────────────────────────────────────
create table if not exists docket.plan_measure_readings (
  item_id uuid not null references docket.plan_items(id) on delete cascade,
  checked_on date not null,                -- IST date of the check
  metric text not null,
  reading numeric,                         -- a count / sum over no rows is 0; null = no reading (a ratio with no denominator, no source)
  window_from date not null,
  window_to date not null,
  target_text text,
  target_parsed jsonb,                     -- { op, value } or null (the target didn't parse)
  reached boolean,                         -- null when the target can't be parsed or the reading is null
  checked_at timestamptz not null default now(),
  primary key (item_id, checked_on),
  check (window_from <= window_to)
);
alter table docket.plan_measure_readings enable row level security;
revoke all on docket.plan_measure_readings from public, anon, authenticated;
grant all on docket.plan_measure_readings to service_role;

-- The latest reading per item — the worker's one batched read.
create or replace view docket.plan_measure_latest with (security_invoker = true) as
  select distinct on (item_id) item_id, checked_on, metric, reading, window_from, window_to, target_text, target_parsed, reached, checked_at
    from docket.plan_measure_readings
   order by item_id, checked_on desc;
revoke all on docket.plan_measure_latest from public, anon, authenticated;
grant select on docket.plan_measure_latest to service_role;

-- ── one metric over IST days [p_from, p_to] ──────────────────────────────────
-- A count or sum over no rows is a real 0 (nothing happened); first-pass yield is null only with no denominator;
-- odo.net_revenue, 'manual' and unknown keys are null. Full precision — rounding is the display's.
-- timestamptz sources: [ist_midnight(p_from), ist_midnight(p_to + 1)).
create or replace function docket.plan_metric_reading(p_metric text, p_from date, p_to date)
returns numeric
language plpgsql stable security definer
set search_path to 'docket', 'public'
as $function$
declare
  v_a timestamptz := docket.ist_midnight(p_from);
  v_b timestamptz := docket.ist_midnight(p_to + 1);
  n numeric;
begin
  if p_metric is null or p_from is null or p_to is null or p_from > p_to then return null; end if;
  case p_metric
    when 'redline.units_inwarded' then      -- INW scans, voided ones excluded
      select count(*) into n from public.scans s
       where s.activity = 'INW' and not coalesce(s.voided, false) and s."timestamp" >= v_a and s."timestamp" < v_b;
    when 'redline.first_pass_yield' then
      -- Mirrors public.v_first_pass_yield's filters exactly (scans ⋈ units on upc, s.voided = false, QC_PASS / QC_FAIL,
      -- u.component_type = 'car', IST days) but DISTINCT units across the whole window, not per day / line / product
      -- (summing the view's rows counts a unit inspected on two days twice): first-pass QC_PASS (loop_count = 0) ÷
      -- every unit with a QC_PASS or QC_FAIL. Unrounded.
      select 100.0 * count(distinct case when s.activity = 'QC_PASS' and s.loop_count = 0 then s.upc end)
                   / nullif(count(distinct s.upc), 0) into n
        from public.scans s join public.units u on u.upc = s.upc
       where s.voided = false and s.activity in ('QC_PASS', 'QC_FAIL') and u.component_type = 'car'
         and s."timestamp" >= v_a and s."timestamp" < v_b;
    when 'redline.qc_fail_units' then       -- fail EVENTS: a unit that fails twice counts twice
      select count(*) into n from public.qc_fail_events e where e.failed_at >= v_a and e.failed_at < v_b;
    when 'redline.units_packed' then
      select count(*) into n from public.pkg_scans p where p.packed_at >= v_a and p.packed_at < v_b;
    when 'redline.units_shipped' then       -- boxes, by shipped_at
      select count(*) into n from public.dispatch_boxes b
       where b.status = 'shipped' and b.shipped_at >= v_a and b.shipped_at < v_b;
    when 'redline.downtime_minutes' then
      select coalesce(sum(d.duration_mins), 0) into n from public.downtime_events d where d.start_time >= v_a and d.start_time < v_b;
    when 'garage.grn_lines' then
      select count(*) into n from store.grn_register g where g.grn_date between p_from and p_to;
    when 'garage.issue_lines' then
      select count(*) into n from store.issue_register i where i.issue_date between p_from and p_to;
    when 'garage.production_runs' then      -- runs RELEASED in the window (the label), by released_at; never a cancelled / rejected one
      select count(*) into n from store.production_runs r
       where r.released_at >= v_a and r.released_at < v_b and r.status not in ('Cancelled', 'Rejected');
    when 'odo.ad_spend' then                -- Odo /marketing's "Ad spend" KPI: Σ spend of f_mkt_rollup(…, 'platform')
      select coalesce(sum(m.spend), 0) into n from sales.f_mkt_rollup(p_from, p_to, 'platform') m;
    when 'odo.web_sessions' then            -- Odo /funnel's "Sessions" step: Σ sessions of f_traffic_rollup(…, 'src')
      select coalesce(sum(t.sessions), 0) into n from sales.f_traffic_rollup(p_from, p_to, 'src') t;
    when 'odo.net_revenue' then             -- no canonical SQL definition (see the header): never re-derived
      n := null;
    when 'podium.one_on_ones' then
      select count(*) into n from podium.one_on_ones o where o.met_on between p_from and p_to;
    when 'podium.okr_checkins' then
      select count(*) into n from podium.okr_checkins c where c.checked_in_on between p_from and p_to;
    when 'docket.tasks_done' then           -- top-level, not archived, done, completed in the window; never Founders'-space work
      select count(*) into n from docket.tasks t left join docket.spaces sp on sp.id = t.space_id
       where t.status = 'done' and t.parent_task_id is null and t.archived_at is null and not coalesce(sp.is_founders, false)
         and t.completed_at >= v_a and t.completed_at < v_b;
    else
      n := null;                            -- 'manual' and any unknown key
  end case;
  return n;
end $function$;

-- ── the target, strictly, for the metric's unit ──────────────────────────────
-- [comparator] [₹] number [suffix]; no comparator = '>='. The number: digits, or comma digit-grouping only
-- (1,000 · 2,50,000), with an optional decimal part. By unit:
--   '%'          — the '%' is REQUIRED; no ₹, no scale
--   '₹'          — optional ₹; scale k = 1e3, L / lakh / lakhs = 1e5, cr / crore = 1e7; no '%'
--   anything else (a count) — optional 'k' only; no ₹, no '%'
-- Anything else in the string, or a null / unknown-shape unit → null (never guess).
create or replace function docket.plan_target_parse(p_target text, p_unit text)
returns jsonb
language plpgsql immutable
as $function$
declare
  m text[];
  v numeric;
  sfx text;
begin
  if p_target is null or p_unit is null then return null; end if;
  m := regexp_match(p_target, '^\s*(>=|≥|>|<=|≤|<|=)?\s*(₹)?\s*((?:[0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]+)(?:\.[0-9]+)?|\.[0-9]+)\s*(%|k|l|lakhs|lakh|cr|crore)?\s*$', 'i');
  if m is null then return null; end if;
  sfx := lower(coalesce(m[4], ''));
  if p_unit = '%' then
    if sfx <> '%' or m[2] is not null then return null; end if;
  elsif p_unit = '₹' then
    if sfx = '%' then return null; end if;
  else
    if m[2] is not null or sfx not in ('', 'k') then return null; end if;
  end if;
  v := replace(m[3], ',', '')::numeric
     * case sfx when 'k' then 1e3 when 'l' then 1e5 when 'lakh' then 1e5 when 'lakhs' then 1e5 when 'cr' then 1e7 when 'crore' then 1e7 else 1 end;
  return jsonb_build_object('op', case coalesce(m[1], '>=') when '≥' then '>=' when '≤' then '<=' else coalesce(m[1], '>=') end,
                            'value', trim_scale(v));
end $function$;

create or replace function docket.plan_target_reached(p_reading numeric, p_parsed jsonb)
returns boolean
language sql immutable
as $function$
  select case when p_reading is null or p_parsed is null then null
    else case p_parsed->>'op'
      when '>=' then p_reading >= (p_parsed->>'value')::numeric
      when '>'  then p_reading >  (p_parsed->>'value')::numeric
      when '<=' then p_reading <= (p_parsed->>'value')::numeric
      when '<'  then p_reading <  (p_parsed->>'value')::numeric
      when '='  then p_reading =  (p_parsed->>'value')::numeric
    end end
$function$;

-- ── the daily check ──────────────────────────────────────────────────────────
-- A ceiling target (< / <=) is NOT reached before the item's effective due date: a trailing 30-day count is
-- trivially under a ceiling early on. A floor or exact target (>= / > / =) may be reached any day; the founders
-- confirm it before anything is marked done (lane decision, R9b review 2026-11-12).
create or replace function docket.measure_check(p_on date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb
language plpgsql security definer
set search_path to 'docket', 'public'
as $function$
declare
  -- key → unit = MEASURE_CHECK_UNITS in src/plan-metrics.mjs (test/measure-keys.test.mjs keeps them equal)
  v_units jsonb := '{"redline.units_inwarded": "units", "redline.first_pass_yield": "%", "redline.qc_fail_units": "units",
                     "redline.units_packed": "units", "redline.units_shipped": "boxes", "garage.grn_lines": "lines",
                     "garage.issue_lines": "lines", "garage.production_runs": "runs", "odo.ad_spend": "₹",
                     "odo.web_sessions": "sessions", "docket.tasks_done": "tasks"}';
  r record;
  v_to date; v_from date; v_read numeric; v_parsed jsonb; v_reached boolean;
  n_checked int := 0; n_reached int := 0; n_unparsed int := 0; n_errored int := 0;
begin
  if p_on is null then raise exception 'date_required' using errcode = 'check_violation'; end if;
  for r in
    select i.id, i.measure->>'metric' as metric, nullif(btrim(i.measure->>'target'), '') as target,
           coalesce(i.revised_due_date, i.due_date) as due
      from docket.plan_items i
     where i.kind in ('milestone', 'result') and i.state = 'agreed'
       and jsonb_typeof(i.measure) = 'object' and i.measure->>'metric' is not null and i.measure->>'metric' <> 'manual'
       and v_units ? (i.measure->>'metric')
     order by i.id
  loop
    begin
      v_to := least(p_on, coalesce(r.due, p_on));
      v_from := v_to - 29;
      v_read := docket.plan_metric_reading(r.metric, v_from, v_to);
      v_parsed := docket.plan_target_parse(r.target, v_units->>r.metric);
      v_reached := docket.plan_target_reached(v_read, v_parsed);
      if v_parsed->>'op' in ('<', '<=') and (r.due is null or p_on < r.due) then v_reached := null; end if;
      insert into docket.plan_measure_readings (item_id, checked_on, metric, reading, window_from, window_to, target_text, target_parsed, reached, checked_at)
      values (r.id, p_on, r.metric, v_read, v_from, v_to, r.target, v_parsed, v_reached, now())
      on conflict (item_id, checked_on) do update
        set metric = excluded.metric, reading = excluded.reading, window_from = excluded.window_from, window_to = excluded.window_to,
            target_text = excluded.target_text, target_parsed = excluded.target_parsed, reached = excluded.reached, checked_at = excluded.checked_at;
      n_checked := n_checked + 1;
      if v_reached then n_reached := n_reached + 1; end if;
      if v_parsed is null then n_unparsed := n_unparsed + 1; end if;
    exception when others then
      n_errored := n_errored + 1;            -- this item only (its writes roll back); the run goes on
    end;
  end loop;
  return jsonb_build_object('checked', n_checked, 'reached', n_reached, 'unparsed', n_unparsed, 'errored', n_errored);
end $function$;

revoke all on function docket.plan_metric_reading(text, date, date) from public, anon, authenticated;
revoke all on function docket.plan_target_parse(text, text) from public, anon, authenticated;
revoke all on function docket.plan_target_reached(numeric, jsonb) from public, anon, authenticated;
revoke all on function docket.measure_check(date) from public, anon, authenticated;
grant execute on function docket.plan_metric_reading(text, date, date) to service_role;
grant execute on function docket.plan_target_parse(text, text) to service_role;
grant execute on function docket.plan_target_reached(numeric, jsonb) to service_role;
grant execute on function docket.measure_check(date) to service_role;

-- 06:00 IST = 00:30 UTC. cron.schedule with an existing name replaces that job (re-runnable).
select cron.schedule('docket-measure-check', '30 0 * * *', $$select docket.measure_check()$$);
select docket.measure_check();

notify pgrst, 'reload schema';
$mig$;
  end if;
  -- ── 1. the target parser: strict, and by the metric's unit ('%' needs '%'; ₹ scale only on ₹; counts: plain k) ──
  select string_agg(coalesce((docket.plan_target_parse(x, un)->>'op') || (docket.plan_target_parse(x, un)->>'value'), 'null'), ',' order by o) into agg
    from unnest(array['≥ 98%', '98', '1.59 cr', '1.59 cr', '<= 30', '₹ 2,50,000', '₹ 250', 'about 98', '98% by March', '> 5k', '5k', '2 Lakhs',
                      '2 Lakhs', '= 7', '<0.5%', '1.5 Crore', '1,0000', '12,345', '50%', '', '5'],
                array['%', '%', '₹', 'units', 'units', '₹', 'units', '%', '%', 'units', '%', '₹',
                      'boxes', 'tasks', '%', '₹', 'units', 'units', '₹', 'units', null]) with ordinality u(x, un, o);
  out := out || '1:' || agg;

  -- ── 2. every registry key over a fixed past window = an independent query (IST days, inclusive); 0 on no rows ──
  wf := today - 31; wt := wf + 29;
  select string_agg(k, '+' order by k) into agg from (
    select k, docket.plan_metric_reading(k, wf, wt) as got, case k
      when 'redline.units_inwarded' then (select count(*) from public.scans s where s.activity = 'INW' and not coalesce(s.voided, false)
                                           and (s."timestamp" at time zone 'Asia/Kolkata')::date between wf and wt)
      when 'redline.first_pass_yield' then (select 100.0 * count(distinct s.upc) filter (where s.activity = 'QC_PASS' and s.loop_count = 0) / nullif(count(distinct s.upc), 0)
                                              from public.scans s join public.units u on u.upc = s.upc
                                             where s.voided = false and s.activity in ('QC_PASS', 'QC_FAIL') and u.component_type = 'car'
                                               and (s."timestamp" at time zone 'Asia/Kolkata')::date between wf and wt)
      when 'redline.qc_fail_units' then (select count(*) from public.qc_fail_events where (failed_at at time zone 'Asia/Kolkata')::date between wf and wt)
      when 'redline.units_packed' then (select count(*) from public.pkg_scans where (packed_at at time zone 'Asia/Kolkata')::date between wf and wt)
      when 'redline.units_shipped' then (select count(*) from public.dispatch_boxes where status = 'shipped' and (shipped_at at time zone 'Asia/Kolkata')::date between wf and wt)
      when 'redline.downtime_minutes' then (select coalesce(sum(duration_mins), 0) from public.downtime_events where (start_time at time zone 'Asia/Kolkata')::date between wf and wt)
      when 'garage.grn_lines' then (select count(*) from store.grn_register where grn_date between wf and wt)
      when 'garage.issue_lines' then (select count(*) from store.issue_register where issue_date between wf and wt)
      when 'garage.production_runs' then (select count(*) from store.production_runs where status not in ('Cancelled', 'Rejected')
                                            and (released_at at time zone 'Asia/Kolkata')::date between wf and wt)
      when 'odo.ad_spend' then (select coalesce(sum(spend), 0) from sales.mkt_fact where the_date between wf and wt)
      when 'odo.web_sessions' then (select coalesce(sum(sessions), 0) from sales.traffic_fact where the_date between wf and wt)
      when 'podium.one_on_ones' then (select count(*) from podium.one_on_ones where met_on between wf and wt)
      when 'podium.okr_checkins' then (select count(*) from podium.okr_checkins where checked_in_on between wf and wt)
      when 'docket.tasks_done' then (select count(*) from docket.tasks t where t.status = 'done' and t.parent_task_id is null and t.archived_at is null
                                       and t.space_id not in (select id from docket.spaces where is_founders)
                                       and (t.completed_at at time zone 'Asia/Kolkata')::date between wf and wt)
      else null end as want
    from unnest(array['redline.units_inwarded', 'redline.first_pass_yield', 'redline.qc_fail_units', 'redline.units_packed', 'redline.units_shipped',
                      'redline.downtime_minutes', 'garage.grn_lines', 'garage.issue_lines', 'garage.production_runs', 'odo.net_revenue', 'odo.ad_spend',
                      'odo.web_sessions', 'podium.one_on_ones', 'podium.okr_checkins', 'docket.tasks_done', 'manual', 'zz.unknown']) k
  ) z where got is distinct from want;
  out := out || '  2:' || coalesce('MISMATCH ' || agg, 'match')
    || ',' || coalesce(docket.plan_metric_reading('odo.net_revenue', wf, wt)::text, 'null')
    || ',' || coalesce(docket.plan_metric_reading('manual', wf, wt)::text, 'null')
    || ',' || coalesce(docket.plan_metric_reading('redline.units_packed', wt, wf)::text, 'null')
    -- no rows at all (1990): a count / sum is a real 0, first-pass yield has no denominator → null
    || ',' || coalesce(docket.plan_metric_reading('redline.units_packed', '1990-01-01', '1990-01-30')::text, 'null')
    || ',' || coalesce(docket.plan_metric_reading('odo.ad_spend', '1990-01-01', '1990-01-30')::text, 'null')
    || ',' || coalesce(docket.plan_metric_reading('redline.first_pass_yield', '1990-01-01', '1990-01-30')::text, 'null')
    -- full precision: 9,796 of 10,000 is 97.96 — under a 98% floor (a 1-decimal round would say 98.0 and reach it)
    || ',' || coalesce(docket.plan_target_reached(100.0 * 9796 / 10000, docket.plan_target_parse('≥ 98%', '%'))::text, 'null');

  -- ── 3. measure_check: only agreed + auto-checkable items; reached true / false / null; ceilings wait for the due
  --       date; one failing item is counted and the rest still run ──
  -- (rolled back with the block) a reading that raises for one metric, to prove the per-item guard
  alter function docket.plan_metric_reading(text, date, date) rename to plan_metric_reading_zz;
  execute $w$create function docket.plan_metric_reading(p_metric text, p_from date, p_to date) returns numeric language plpgsql as $f$
    begin if p_metric = 'redline.qc_fail_units' then raise exception 'zz_boom'; end if; return docket.plan_metric_reading_zz(p_metric, p_from, p_to); end $f$$w$;
  v := docket.plan_metric_reading('redline.units_packed', today - 31, today - 2);   -- a closed window (data settled)
  if v is null or v = 0 then raise exception 'RESULT fixture: no PKG rows in the 30 days to %', today - 2; end if;
  insert into docket.plan_items (kind, code, title, state) values ('theme', 'ZZMC', 'zz mc theme', 'agreed') returning id into th;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when, measure) values
    ('milestone', 'ZZMC.M1', th, 'zz m1', E1, 'agreed', today - 2, 'd', jsonb_build_object('system', 'redline', 'metric', 'redline.units_packed', 'target', '≥ ' || v))
    returning id into m1;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when, measure) values
    ('milestone', 'ZZMC.M2', th, 'zz m2', E1, 'agreed', today - 2, 'd', jsonb_build_object('system', 'redline', 'metric', 'redline.units_packed', 'target', '> ' || v)) returning id into m2;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when, measure) values
    ('milestone', 'ZZMC.M3', th, 'zz m3', E1, 'agreed', today - 2, 'd', jsonb_build_object('system', 'redline', 'metric', 'redline.units_packed', 'target', 'about ' || v)) returning id into m3;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, revised_due_date, done_when, measure) values
    ('milestone', 'ZZMC.M9', th, 'zz m9 future', E1, 'agreed', today - 40, today + 10, 'd', jsonb_build_object('system', 'redline', 'metric', 'redline.units_packed', 'target', '>= 1')) returning id into m9;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when, measure) values
    ('result', 'ZZMC.M1.R1', m1, 'zz r1', E1, 'agreed', today - 2, 'd', jsonb_build_object('system', 'redline', 'metric', 'redline.units_packed', 'target', '<= ' || v)) returning id into r1;
  insert into docket.plan_items (kind, code, parent_id, title, owner_employee_id, state, due_date, done_when, measure) values
    ('milestone', 'ZZMC.M8', th, 'zz ceiling, not due', E1, 'agreed', today + 10, 'd', '{"system":"redline","metric":"redline.units_packed","target":"<= 999999999"}'),
    ('milestone', 'ZZMC.M7', th, 'zz pct target on a count', E1, 'agreed', today - 2, 'd', '{"system":"redline","metric":"redline.units_packed","target":">= 5%"}'),
    ('milestone', 'ZZMC.E1', th, 'zz errors', E1, 'agreed', today - 2, 'd', '{"system":"redline","metric":"redline.qc_fail_units","target":">= 1"}'),
    ('milestone', 'ZZMC.X1', th, 'zz proposed', E1, 'proposed', today - 2, 'd', '{"system":"redline","metric":"redline.units_packed","target":">= 1"}'),
    ('milestone', 'ZZMC.X2', th, 'zz revenue', E1, 'agreed', today - 2, 'd', '{"system":"odo","metric":"odo.net_revenue","target":">= 1"}'),
    ('milestone', 'ZZMC.X3', th, 'zz downtime', E1, 'agreed', today - 2, 'd', '{"system":"redline","metric":"redline.downtime_minutes","target":"<= 1"}'),
    ('milestone', 'ZZMC.X4', th, 'zz manual', E1, 'agreed', today - 2, 'd', '{"system":"manual","metric":"manual","target":">= 1"}'),
    ('milestone', 'ZZMC.X5', th, 'zz dropped', E1, 'dropped', today - 2, 'd', '{"system":"redline","metric":"redline.units_packed","target":">= 1"}'),
    ('milestone', 'ZZMC.X6', th, 'zz no measure', E1, 'agreed', today - 2, 'd', null);
  j := docket.measure_check(today);
  select string_agg(i.code || '=' || coalesce(r.reached::text, 'null') || case when r.target_parsed is null then '/unparsed' else '' end
                    || case when r.reading = v or i.code in ('ZZMC.M8', 'ZZMC.M9') then '' else '/BADREAD' end, ',' order by i.code) into agg
    from docket.plan_measure_readings r join docket.plan_items i on i.id = r.item_id where i.code like 'ZZMC%';
  out := out || '  3:' || agg
    || ',' || (select case when window_from = today - 31 and window_to = today - 2 and checked_on = today then 'win' else 'BADWIN' end from docket.plan_measure_readings where item_id = m1)
    || ',' || (select case when window_to = today and window_from = today - 29 then 'future' else 'BADFUT' end from docket.plan_measure_readings where item_id = m9)
    || ',' || (case when (j->>'checked')::int >= 7 and (j->>'reached')::int >= 3 and (j->>'unparsed')::int >= 2 and (j->>'errored')::int >= 1 then 'json' else 'BADJSON ' || j::text end);

  -- ── 4. a re-run the same day upserts; another day adds a row; latest = the newest day ──
  update docket.plan_items set measure = jsonb_set(measure, '{target}', to_jsonb('>= ' || v)) where id = m2;
  perform docket.measure_check(today);
  out := out || '  4:' || (select count(*) from docket.plan_measure_readings where item_id = m2)
    || ',' || (select coalesce(reached::text, 'null') || case when target_text = '>= ' || v then '/retargeted' else '/STALE' end
                 from docket.plan_measure_readings where item_id = m2);
  perform docket.measure_check(today + 1);
  out := out || ',' || (select count(*) from docket.plan_measure_readings where item_id = m1)
    || ',' || (select case when checked_on = today + 1 then 'latest' else 'BADLATEST' end from docket.plan_measure_latest where item_id = m1)
    || ',' || (select count(*) from docket.plan_measure_latest where item_id in (m1, m2, m3, m9, r1));

  -- ── 5. cron + grants ──
  out := out || '  5:' || (select count(*) from cron.job where jobname = 'docket-measure-check' and schedule = '30 0 * * *')
    || ',' || has_function_privilege('anon', 'docket.measure_check(date)', 'execute')
    || ',' || has_function_privilege('authenticated', 'docket.plan_metric_reading_zz(text, date, date)', 'execute')
    || ',' || has_table_privilege('authenticated', 'docket.plan_measure_readings', 'select')
    || ',' || has_function_privilege('service_role', 'docket.measure_check(date)', 'execute');

  raise exception 'RESULT %', coalesce(out, 'NULL — a check collapsed');
end $mcheck$;
