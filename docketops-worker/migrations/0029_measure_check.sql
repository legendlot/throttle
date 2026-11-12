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
