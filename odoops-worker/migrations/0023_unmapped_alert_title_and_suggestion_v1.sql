-- S325 (2026-08-31) — the unmapped-revenue alert now names the PRODUCT, not just the SKU.
--
-- ⚠️ READ THIS BEFORE RE-OPENING THE ZEPTO BACKLOG ITEM: its premise was WRONG.
-- The item said a new Zepto SKU lands in the numbers "with no alert to anyone". Measured
-- 2026-08-31: the S307 `unmapped` alert FIRED on that exact SKU, twice, and both were `sent` —
-- `b8d7db11-c182-4f29-836b-d7eca70477fd` on 2026-08-27 11:31 IST (₹11,994 / 6u) and again
-- 2026-08-28 11:31 (₹15,992 / 8u). Detection was never the gap.
--
-- ⭐ THE ACTUAL GAP IS THAT THE ALERT WAS UNACTIONABLE. `top_skus` carried only the opaque
-- channel SKU, so the Slack message read `b8d7db11-c182-4f29-836b-d7eca70477fd` — a UUID no human
-- can act on without opening the database. That is why it fired twice and the miss was still found
-- by a person noticing a variance. Zepto DOES send a usable `title` ("Construction Fang"); the
-- alert simply never carried it.
--
-- Adds to each `top_skus` entry:
--   `title`                   — the channel's own product name, straight from staging.
--   `suggested_product_code`  — a PROPOSAL ONLY. Nothing auto-maps. See the guards below.
--
-- ⛔ THE TWO GUARDS ON THE SUGGESTION ARE LOAD-BEARING — VALIDATED, NOT ASSUMED.
-- A naive title→product_master match was tested against the 26 Zepto SKUs a human had already
-- mapped: 21 agreed but **2 were WRONG**, and both wrongly in a way that would corrupt revenue —
--   • "McCloud"     → matched `MCXXR`, the REMOTE, where the human chose `MCBK`, the car. A bare
--                     product name hits the remote row because its model/color are empty. This is
--                     the same class Ignition hit in S313 (bare "Shadow" resolving to `SHXXR`).
--   • "Bumble Green" → matched `BMFG` (Bumble FOREST Green) where the human chose `BMBG` (BASE
--                     Green). product+colour collides across two models.
-- So: (1) remotes are EXCLUDED from the candidate set, and (2) a suggestion is emitted ONLY when
-- the match is UNIQUE — ambiguity yields NULL, never a guess. Re-tested with both guards:
-- **21 suggested, 21 correct, 0 wrong, 5 silent.** Negative control over all 18 currently-unmapped
-- SKUs fleet-wide: **zero suggestions** for the never-map classes (Website Gift Wrapping, `SP - *`
-- spares, Replacement Part, Repairs) and for GT's genuinely ambiguous bare "Shadow"/"Flare".
-- ⚠️ If either guard is ever removed, re-run that validation first — the 2 failures above are what
-- it is protecting against, and both look harmless until you check which product_code came back.
--
-- ⚠️ THE SIGNATURE IS UNCHANGED AND MUST STAY THAT WAY. The window/threshold are internal
-- constants, not parameters: adding an argument to a function PostgREST already exposes creates an
-- OVERLOAD, after which every call fails PGRST203 (systems/odo.md §S307; RULE-STOCK-002 records the
-- same incident). CREATE OR REPLACE only replaces a MATCHING signature — a longer one would
-- silently leave the old function alongside the new. Verify exactly one signature exists after
-- applying.
--
-- Everything else — the staleness block, the silence block, the staging⋈sku_map basis, the
-- 'ignored' suppression, the 7d/₹10,000 constants, the per-(channel,kind) cooldown — is unchanged.
--
-- Applied to live as `odo_unmapped_alert_title_and_suggestion_v1`. Mirror copy (PATTERN-297).

CREATE OR REPLACE FUNCTION sales.detect_connector_alerts(
  p_stale_hours integer DEFAULT 24, p_cooldown_hours integer DEFAULT 24,
  p_min_active_days integer DEFAULT 20, p_silent_mult numeric DEFAULT 4,
  p_min_silent_days integer DEFAULT 7)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'sales', 'public'
AS $function$
declare
  v_count int := 0; v_n int;
  c_window_days constant int := 7;
  c_min_gross   constant numeric := 10000;
  c_top_skus    constant int := 5;
begin
  -- (1) STALENESS — unchanged.
  insert into sales.connector_alert_outbox (channel_id, adapter_kind, alert_kind, severity, detail)
  select cc.channel_id, cc.adapter_kind, 'stale', 'red',
         jsonb_build_object(
           'channel_name', dc.name,
           'last_ok_at',   cc.last_ok_at,
           'hours_stale',  case when cc.last_ok_at is null then null
                                else round(extract(epoch from (now() - cc.last_ok_at)) / 3600) end,
           'last_error',   left(coalesce(cc.last_error, ''), 200))
  from sales.connector_config cc
  left join public.dispatch_channels dc on dc.id = cc.channel_id
  where cc.enabled
    and cc.adapter_kind <> 'uniware'
    and (cc.last_ok_at is null or cc.last_ok_at < now() - make_interval(hours => p_stale_hours))
    and not exists (
      select 1 from sales.connector_alert_outbox o
      where o.channel_id = cc.channel_id and o.alert_kind = 'stale'
        and o.detected_at > now() - make_interval(hours => p_cooldown_hours));
  get diagnostics v_n = row_count; v_count := v_count + v_n;

  -- (2) SILENCE — unchanged.
  insert into sales.connector_alert_outbox (channel_id, adapter_kind, alert_kind, severity, detail)
  select p.channel_id, cc.adapter_kind, 'silent', 'amber',
         jsonb_build_object(
           'channel_name',     dc.name,
           'last_sale',        p.last_sale,
           'days_silent',      (current_date - p.last_sale),
           'active_days_90',   p.active_days_90,
           'typical_gap_days', round(90.0 / nullif(p.active_days_90, 0), 1))
  from (
    select f.channel_id,
           max(f.sale_date) as last_sale,
           count(distinct f.sale_date) filter (where f.sale_date > current_date - 90) as active_days_90
    from sales.sales_fact f
    group by f.channel_id
  ) p
  join public.dispatch_channels dc on dc.id = p.channel_id and dc.is_sale
  left join sales.connector_config cc on cc.channel_id = p.channel_id
  where p.active_days_90 >= p_min_active_days
    and (current_date - p.last_sale) > greatest(p_silent_mult * (90.0 / nullif(p.active_days_90, 0)), p_min_silent_days)
    and not exists (
      select 1 from sales.connector_alert_outbox o
      where o.channel_id = p.channel_id and o.alert_kind = 'silent'
        and o.detected_at > now() - make_interval(hours => p_cooldown_hours));
  get diagnostics v_n = row_count; v_count := v_count + v_n;

  -- (3) UNMAPPED REVENUE — basis unchanged (staging ⋈ sku_map, NOT the unmapped_sku queue, which
  -- drifts and has held 'ignored' rows worth ₹17.8L that resolve fine). Only the payload grows.
  with staged as (
    select channel_id, channel_sku, title, qty, gross_value, sale_date, is_cancelled, row_type from sales.stg_shopify
    union all select channel_id, channel_sku, title, qty, gross_value, sale_date, is_cancelled, row_type from sales.stg_amazon
    union all select channel_id, channel_sku, title, qty, gross_value, sale_date, is_cancelled, row_type from sales.stg_snorkel
    union all select channel_id, channel_sku, title, qty, gross_value, sale_date, is_cancelled, row_type from sales.stg_qc
    union all select channel_id, channel_sku, title, qty, gross_value, sale_date, is_cancelled, row_type from sales.stg_uniware
  ), cand as (
    -- Candidate products for the suggestion. Remotes excluded — see the header.
    select product_code,
           lower(regexp_replace(concat_ws(' ', product, model, color), '\s+', ' ', 'g')) as full_key,
           lower(regexp_replace(concat_ws(' ', product, color), '\s+', ' ', 'g'))        as pc_key,
           lower(regexp_replace(product, '\s+', ' ', 'g'))                               as p_key
    from public.product_master
    where is_active and coalesce(component_type, '') <> 'remote'
  ), per_sku as (
    select s.channel_id, s.channel_sku,
           max(s.title) as title,
           sum(s.qty) as units, sum(s.gross_value) as gross, max(s.sale_date) as last_date
    from staged s
    left join sales.sku_map m
           on m.channel_id = s.channel_id and m.channel_sku = s.channel_sku
    left join sales.unmapped_sku u
           on u.channel_id = s.channel_id and u.channel_sku = s.channel_sku
    where m.product_code is null
      and coalesce(s.is_cancelled, false) = false
      and coalesce(s.row_type, 'sale') = 'sale'
      and s.sale_date > current_date - c_window_days
      and coalesce(u.status, 'open') <> 'ignored'
    group by s.channel_id, s.channel_sku
  ), per_channel as (
    select channel_id, sum(units) as units, sum(gross) as gross,
           count(*) as sku_count, max(last_date) as last_date
    from per_sku group by channel_id
    having sum(gross) >= c_min_gross
  )
  insert into sales.connector_alert_outbox (channel_id, adapter_kind, alert_kind, severity, detail)
  select pc.channel_id, cc.adapter_kind, 'unmapped', 'red',
         jsonb_build_object(
           'channel_name',  dc.name,
           'window_days',   c_window_days,
           'unmapped_gross', round(pc.gross),
           'unmapped_units', pc.units,
           'sku_count',     pc.sku_count,
           'last_date',     pc.last_date,
           'top_skus',      (select jsonb_agg(jsonb_build_object(
                                      'sku',   t.channel_sku,
                                      'title', t.title,
                                      'gross', round(t.gross),
                                      'units', t.units,
                                      -- Proposal only. NULL unless exactly one non-remote product
                                      -- matches the title. Never auto-applied.
                                      'suggested_product_code',
                                      (select case when count(*) = 1 then min(c.product_code) end
                                         from cand c
                                        where c.full_key = lower(regexp_replace(btrim(coalesce(t.title, '')), '\s+', ' ', 'g'))
                                           or c.pc_key   = lower(regexp_replace(btrim(coalesce(t.title, '')), '\s+', ' ', 'g'))
                                           or c.p_key    = lower(regexp_replace(btrim(coalesce(t.title, '')), '\s+', ' ', 'g'))))
                                    order by t.gross desc)
                             from (select * from per_sku ps
                                   where ps.channel_id = pc.channel_id
                                   order by ps.gross desc limit c_top_skus) t))
  from per_channel pc
  join public.dispatch_channels dc on dc.id = pc.channel_id
  left join sales.connector_config cc on cc.channel_id = pc.channel_id
  where not exists (
    select 1 from sales.connector_alert_outbox o
    where o.channel_id = pc.channel_id and o.alert_kind = 'unmapped'
      and o.detected_at > now() - make_interval(hours => p_cooldown_hours));
  get diagnostics v_n = row_count; v_count := v_count + v_n;

  return v_count;
end $function$;
