-- 0010 — Reann, #bugs 1794284934.757279 (2026-11-10).
--
-- (1) Three contract templates — Barter, Paid, Affiliate — each with its own dos and don'ts and
--     terms. The deal's type picks one: barter → Barter, paid → Paid, affiliate → Affiliate,
--     paid_plus_affiliate → Paid (the contract adds the commission line from the deal's %).
--     The subject and published_at stay shared: publishing is still the one switch for sending
--     and for the Shipping lock.
--
--     ⛔ APPLY BEFORE DEPLOYING THE WORKER: the worker selects the new columns, and PostgREST
--     errors on an unknown column, which the lock reads as "could not check" and refuses moves.
--
--     Each template starts as a copy of the wording published 2026-11-09, so nothing a creator
--     receives changes until Reann edits one. The old dos_and_donts / terms columns stay as they
--     are (the copy's source, read by nothing after this worker ships).
alter table ignition.contract_settings
  add column if not exists barter_dos_and_donts    text,
  add column if not exists barter_terms            text,
  add column if not exists paid_dos_and_donts      text,
  add column if not exists paid_terms              text,
  add column if not exists affiliate_dos_and_donts text,
  add column if not exists affiliate_terms         text;

update ignition.contract_settings set
  barter_dos_and_donts    = coalesce(barter_dos_and_donts,    dos_and_donts),
  barter_terms            = coalesce(barter_terms,            terms),
  paid_dos_and_donts      = coalesce(paid_dos_and_donts,      dos_and_donts),
  paid_terms              = coalesce(paid_terms,              terms),
  affiliate_dos_and_donts = coalesce(affiliate_dos_and_donts, dos_and_donts),
  affiliate_terms         = coalesce(affiliate_terms,         terms)
where id = 1;

comment on column ignition.contract_settings.dos_and_donts is
  'RETIRED by 0010: copied into barter_/paid_/affiliate_dos_and_donts. Read by nothing.';
comment on column ignition.contract_settings.terms is
  'RETIRED by 0010: copied into barter_/paid_/affiliate_terms. Read by nothing.';

-- (2) TDS on products (section 194R): product value a creator received, per financial year
--     (April–March, IST). Flag over ₹20,000.
--
--     Value = the product's SELLING price (ignition.product_prices, the Shopify cache; through
--     sales.sku_map when product_master.sku is stale — the same lookup as getProductPrice), not
--     engagement_products.goodies_cost, which holds COGS. LOT makes what it gifts, so the value of
--     the benefit is the price it normally charges. It is TODAY's price: the cache keeps no history.
--
--     Received = the deal reached Shipped or later, or the courier dispatched its order and it did
--     not come back (RTO or cancelled shipments are left out; a deal ghosted, dropped or cancelled
--     after a delivered dispatch still received the goods), or it was marked
--     gifted-no-post. FY date = the courier dispatch date, else the date the deal was created.
--     A line whose price cannot be found counts 0 and is reported in unpriced_lines.
create or replace function ignition.creator_product_value_fy(p_influencer_id uuid)
returns table (fy_start date, value numeric, deals int, lines int, unpriced_lines int)
language sql stable security invoker
set search_path = ignition, public, sales, pg_temp
as $$
  with deals as (
    select e.id, e.created_at,
      (select min(s.dispatched_at) from public.ecom_shipments s
        where nullif(trim(e.shipping_order_id), '') is not null
          and coalesce(s.lifecycle, '') not in ('rto', 'cancelled')       -- goods that came back were not received
          and upper(regexp_replace(s.shopify_order_name, '[^A-Za-z0-9]', '', 'g'))
            = upper(regexp_replace(e.shipping_order_id, '[^A-Za-z0-9]', '', 'g'))) as dispatched_at,
      e.stage, e.gifted_no_post
    from ignition.engagements e
    where e.influencer_id = p_influencer_id
  ),
  received as (
    select d.id,
      (coalesce(d.dispatched_at, d.created_at) at time zone 'Asia/Kolkata')::date as on_date
    from deals d
    where d.stage in ('shipped', 'delivered', 'scheduled', 'posting', 'live', 'completed')
       or d.dispatched_at is not null
       or d.gifted_no_post is true
  ),
  priced as (
    select r.id, r.on_date, greatest(coalesce(p.quantity, 1), 1) as qty,
      (select coalesce(
         (select pp.price from ignition.product_prices pp
           where pp.sku = pm.sku and pp.price > 0 order by pp.synced_at desc limit 1),
         (select pp.price from sales.sku_map sm join ignition.product_prices pp on pp.sku = sm.channel_sku
           where sm.product_code = pm.product_code and pp.price > 0 order by pp.synced_at desc limit 1))
       from public.product_master pm where pm.product_code = p.product_ref limit 1) as price
    from received r
    join ignition.engagement_products p on p.engagement_id = r.id
  )
  select
    make_date(case when extract(month from on_date) >= 4 then extract(year from on_date)::int
                   else extract(year from on_date)::int - 1 end, 4, 1) as fy_start,
    coalesce(sum(price * qty), 0)::numeric(12,2) as value,
    count(distinct id)::int as deals,
    count(*)::int as lines,
    count(*) filter (where price is null)::int as unpriced_lines
  from priced
  group by 1
  order by 1 desc
$$;

revoke execute on function ignition.creator_product_value_fy(uuid) from public, anon, authenticated;
grant execute on function ignition.creator_product_value_fy(uuid) to service_role;

notify pgrst, 'reload schema';
