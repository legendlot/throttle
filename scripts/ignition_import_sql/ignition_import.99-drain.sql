-- Drain staging → real tables. Idempotent. Drops staging at the end.

-- 1. Influencers
INSERT INTO ignition.influencers (
  influencer_code, channel_name, person_name, channel_link, channel_platform,
  influencer_type, categories, reach, audience, location,
  contact_number, address, email, contact_poc_type, contact_poc_name,
  first_invite_sent_at, list_status, legacy_sheet_ref
)
SELECT
  influencer_code, channel_name, person_name, channel_link, channel_platform,
  influencer_type, categories, reach, audience, location,
  contact_number, address, email, contact_poc_type, contact_poc_name,
  first_invite_sent_at, list_status, legacy_sheet_ref
FROM ignition._stage_influencers
ON CONFLICT (influencer_code) DO NOTHING;

-- 2. Engagements — mint engagement_no per row, look up influencer_id
DO $$
DECLARE
  r RECORD;
  v_inf_id uuid;
  v_seq bigint;
  v_year text;
  inserted_count int := 0;
  skipped_count int := 0;
BEGIN
  FOR r IN
    SELECT * FROM ignition._stage_engagements s
    WHERE NOT EXISTS (
      SELECT 1 FROM ignition.engagements e WHERE e.legacy_sheet_ref = s.legacy_sheet_ref
    )
  LOOP
    SELECT id INTO v_inf_id FROM ignition.influencers
      WHERE influencer_code = r.influencer_code_ref;
    IF v_inf_id IS NULL THEN
      skipped_count := skipped_count + 1;
      CONTINUE;
    END IF;
    v_year := COALESCE(EXTRACT(YEAR FROM r.post_date)::text, '2025');
    v_seq  := ignition.next_engagement_seq(v_year);
    INSERT INTO ignition.engagements (
      engagement_no, influencer_id, engagement_type, product_code, product_variant,
      deal_type, payment_terms, payment_amount, affiliate_pct, commission_amount,
      ad_spend, goodies_cost, shipping_cost, return_cost, cpm,
      post_date, video_link, utm_link,
      views, likes, comments, shares, impressions, sessions, orders,
      conversions_value, orders_cc,
      shipping_order_id, tracking_id, shipping_month, shipping_date, directed_to,
      stage, closed_reason, closed_at,
      legacy_sheet_ref, created_at
    ) VALUES (
      'IGN-' || v_year || '-' || LPAD(v_seq::text, 5, '0'),
      v_inf_id, r.engagement_type, r.product_code, r.product_variant,
      r.deal_type, r.payment_terms, r.payment_amount, r.affiliate_pct, r.commission_amount,
      r.ad_spend, r.goodies_cost, r.shipping_cost, r.return_cost, r.cpm,
      r.post_date, r.video_link, r.utm_link,
      r.views, r.likes, r.comments, r.shares, r.impressions, r.sessions, r.orders,
      r.conversions_value, r.orders_cc,
      r.shipping_order_id, r.tracking_id, r.shipping_month, r.shipping_date, r.directed_to,
      r.stage, r.closed_reason,
      CASE WHEN r.stage = 'closed' THEN COALESCE(r.post_date::timestamptz, now()) ELSE NULL END,
      r.legacy_sheet_ref,
      COALESCE(r.post_date::timestamptz, r.shipping_date::timestamptz, now())
    );
    inserted_count := inserted_count + 1;
  END LOOP;
  RAISE NOTICE 'Engagements: inserted %, skipped (no matching influencer) %', inserted_count, skipped_count;
END $$;

-- 3. Discount codes
INSERT INTO ignition.discount_codes (
  code, pool_label, utilized, order_name, order_value, used_at,
  address_pincode, products, quantity, tracking_url
)
SELECT
  code, pool_label, utilized, order_name, order_value, used_at,
  address_pincode, products, quantity, tracking_url
FROM ignition._stage_codes
ON CONFLICT (code) DO NOTHING;

-- 4. Drop staging
DROP TABLE ignition._stage_engagements;
DROP TABLE ignition._stage_influencers;
DROP TABLE ignition._stage_codes;
