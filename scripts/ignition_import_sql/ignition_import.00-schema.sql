-- Staging tables in ignition schema. Dropped by 99-drain.sql.
CREATE TABLE IF NOT EXISTS ignition._stage_influencers (
  influencer_code text PRIMARY KEY,
  channel_name text, person_name text, channel_link text, channel_platform text,
  influencer_type text, categories text[],
  reach int, audience text, location text,
  contact_number text, address text, email text,
  contact_poc_type text, contact_poc_name text,
  first_invite_sent_at timestamptz,
  list_status text NOT NULL,
  legacy_sheet_ref text
);
GRANT ALL ON ignition._stage_influencers TO service_role;

CREATE TABLE IF NOT EXISTS ignition._stage_engagements (
  legacy_sheet_ref text PRIMARY KEY,
  influencer_code_ref text NOT NULL,
  engagement_type text NOT NULL,
  product_code text, product_variant text,
  deal_type text NOT NULL, payment_terms text,
  payment_amount numeric, affiliate_pct numeric, commission_amount numeric,
  ad_spend numeric, goodies_cost numeric, shipping_cost numeric, return_cost numeric,
  cpm numeric, post_date date, video_link text, utm_link text,
  views int, likes int, comments int, shares int, impressions int,
  sessions int, orders int, conversions_value numeric, orders_cc int,
  shipping_order_id text, tracking_id text, shipping_month text, shipping_date date,
  directed_to text, stage text, closed_reason text
);
GRANT ALL ON ignition._stage_engagements TO service_role;

CREATE TABLE IF NOT EXISTS ignition._stage_codes (
  code text PRIMARY KEY,
  pool_label text, utilized bool, order_name text, order_value numeric,
  used_at timestamptz, address_pincode text, products text[],
  quantity int, tracking_url text
);
GRANT ALL ON ignition._stage_codes TO service_role;
