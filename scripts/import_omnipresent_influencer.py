#!/usr/bin/env python3
"""
Import Omnipresent — Influencer.xlsx → ignition schema (Phase A cutover).

Reads ~/Downloads/Omnipresent - Influencer.xlsx and writes a sequence of SQL
files ready to apply via the Supabase MCP `apply_migration` tool:

  <prefix>.00-schema.sql      — staging tables in ignition schema
  <prefix>.01-data.sql        — influencer rows (chunked, 40 per file)
  <prefix>.02-data.sql        — ...
  <prefix>.NN-data.sql
  <prefix>.50-engagements.sql — engagement rows (Video Tracking + UGC)
  <prefix>.80-codes.sql       — discount codes
  <prefix>.98-roster.sql      — roster patches (rating/onboard)
  <prefix>.99-drain.sql       — DO block: mint engagement_no per row,
                                INSERT into ignition.engagements, drop staging

Idempotency: every row gets a `legacy_sheet_ref` derived from a stable hash
of identifying columns. The drain block skips rows whose ref already
exists in the target table.

Run:
  python3 scripts/import_omnipresent_influencer.py \\
    "~/Downloads/Omnipresent - Influencer.xlsx" \\
    out/ignition_import
"""

import os
import sys
import re
import hashlib
import pandas as pd
from datetime import datetime


# ─── Helpers ─────────────────────────────────────────────────────────────────

def s(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    return str(v).strip()


def num(v, default=0, integer=False):
    """Safe-cast to number. Returns `default` for None/NaN/non-numeric strings."""
    if v is None:
        return default
    if isinstance(v, float) and pd.isna(v):
        return default
    if isinstance(v, (int, float)):
        return int(v) if integer else float(v)
    try:
        cleaned = re.sub(r'[^\d.\-]', '', str(v))
        if not cleaned or cleaned in ('-', '.', '-.'):
            return default
        return int(float(cleaned)) if integer else float(cleaned)
    except (ValueError, TypeError):
        return default


def num_or_none(v):
    """Safe-cast to number. Returns None for None/NaN/non-numeric strings."""
    if v is None:
        return None
    if isinstance(v, float) and pd.isna(v):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    try:
        cleaned = re.sub(r'[^\d.\-]', '', str(v))
        if not cleaned or cleaned in ('-', '.', '-.'):
            return None
        return float(cleaned)
    except (ValueError, TypeError):
        return None


def sql_escape(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 'NULL'
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    if isinstance(v, (int, float)):
        return str(v) if not pd.isna(v) else 'NULL'
    text = str(v).replace("'", "''")
    return f"'{text}'"


def sql_array(values):
    if not values:
        return 'NULL'
    quoted = [str(x).replace("'", "''").replace('"', '\\"') for x in values if x]
    if not quoted:
        return 'NULL'
    return "ARRAY[" + ', '.join(f"'{x}'" for x in quoted) + "]::text[]"


def to_pg_timestamp(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 'NULL'
    try:
        if isinstance(v, datetime):
            return f"'{v.strftime('%Y-%m-%dT00:00:00Z')}'"
        d = pd.to_datetime(v, errors='coerce', dayfirst=True)
        if pd.isna(d):
            return 'NULL'
        return f"'{d.strftime('%Y-%m-%dT00:00:00Z')}'"
    except (ValueError, AttributeError, TypeError):
        return 'NULL'


def to_pg_date(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 'NULL'
    try:
        if isinstance(v, datetime):
            return f"'{v.strftime('%Y-%m-%d')}'"
        d = pd.to_datetime(v, errors='coerce', dayfirst=True)
        if pd.isna(d):
            return 'NULL'
        return f"'{d.strftime('%Y-%m-%d')}'"
    except (ValueError, AttributeError, TypeError):
        return 'NULL'


def normalize_phone(raw):
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None
    digits = re.sub(r'\D', '', str(raw))
    if not digits:
        return None
    if len(digits) == 10:
        return f'+91{digits}'
    if len(digits) == 12 and digits.startswith('91'):
        return f'+{digits}'
    return f'+{digits}'


def normalize_type(raw):
    if not raw:
        return None
    t = str(raw).strip().lower()
    if t in ('nano', 'micro', 'macro', 'brand', 'store'):
        return t
    return None


def normalize_platform(link):
    if not link:
        return None
    low = link.lower()
    if 'instagram' in low:
        return 'instagram'
    if 'youtube' in low or 'youtu.be' in low:
        return 'youtube'
    if 'tiktok' in low:
        return 'tiktok'
    return 'other'


def normalize_directed_to(raw):
    if not raw:
        return None
    t = str(raw).strip().lower()
    if 'website' in t:
        return 'website'
    if 'amazon' in t:
        return 'amazon'
    if 'flipkart' in t:
        return 'flipkart'
    return None


def parse_categories(raw):
    if not raw:
        return []
    parts = [p.strip().lower() for p in re.split(r'[,/|]', str(raw)) if p.strip()]
    return parts


def legacy_ref(prefix, *parts):
    key = '|'.join((p or '') for p in (str(x) for x in parts))
    return f'{prefix}-' + hashlib.sha1(key.encode('utf-8')).hexdigest()[:16]


# ─── Sheet parsers ───────────────────────────────────────────────────────────

def parse_master_data(df, list_status='master'):
    """Master Data sheet → influencers rows. Position-based column access.

    Master Data columns (header row 0):
      0: SL/code (IN0001), 1: Channel Name, 2: Name, 3: Channel Link,
      4: Influencer Type, 5: Category, 6: Reach (Views), 7: Audience,
      8: Location, 9: Contact #, 10: Address, 11: POC, 12: Contact POC,
      13: Email, 14: First Invite Sent, 15: Status, 16: Comments
    """
    rows = []
    skipped = 0
    for _, r in df.iterrows():
        # Use iloc positional access — column names are unreliable
        code = s(r.iloc[0])
        if not code or not (code.upper().startswith('IN') and any(ch.isdigit() for ch in code[2:])):
            skipped += 1
            continue
        code = code.upper()

        channel_name = s(r.iloc[1])
        person_name = s(r.iloc[2])
        link = s(r.iloc[3])

        rows.append({
            'influencer_code': code,
            'channel_name': channel_name,
            'person_name': person_name if person_name and person_name != channel_name else None,
            'channel_link': link,
            'channel_platform': normalize_platform(link),
            'influencer_type': normalize_type(s(r.iloc[4])),
            'categories': parse_categories(s(r.iloc[5])),
            'reach': num(r.iloc[6], default=None, integer=True),
            'audience': s(r.iloc[7]),
            'location': s(r.iloc[8]),
            'contact_number': normalize_phone(r.iloc[9]),
            'address': s(r.iloc[10]),
            'contact_poc_type': normalize_poc(s(r.iloc[11])),
            'contact_poc_name': s(r.iloc[12]),
            'email': s(r.iloc[13]),
            'first_invite_sent_at': to_pg_timestamp(datetime.utcnow()) if r.iloc[14] is True else 'NULL',
            'list_status': list_status,
            'legacy_sheet_ref': legacy_ref('omnipres-inf', code, channel_name or '', link or ''),
        })
    return rows, skipped


def parse_b_list(df):
    """B List sheet → influencer rows with list_status='b_list'.

    B List columns (similar to Master Data but col 0 is SL No):
      0: SL No, 1: Channel Name, 2: Name, 3: Channel Link, 4: Influencer Type,
      5: Category, 6: Reach (Views), 7: Directed to, 8: Audience, 9: Location,
      10: Contact #, 11: Address, 12: Contact POC, 13: Email,
      14: First Invite Sent, 15: Status, 16: Comments, 17: POC
    """
    rows = []
    skipped = 0
    for _, r in df.iterrows():
        sl_raw = r.iloc[0]
        if pd.isna(sl_raw):
            skipped += 1
            continue
        try:
            sl_int = int(float(sl_raw))
        except (ValueError, TypeError):
            skipped += 1
            continue
        synth_code = f'IBL{sl_int:04d}'

        channel_name = s(r.iloc[1])
        person_name = s(r.iloc[2])
        link = s(r.iloc[3])

        rows.append({
            'influencer_code': synth_code,
            'channel_name': channel_name,
            'person_name': person_name if person_name and person_name != channel_name else None,
            'channel_link': link,
            'channel_platform': normalize_platform(link),
            'influencer_type': normalize_type(s(r.iloc[4])),
            'categories': parse_categories(s(r.iloc[5])),
            'reach': num(r.iloc[6], default=None, integer=True),
            'audience': s(r.iloc[8]),
            'location': s(r.iloc[9]),
            'contact_number': normalize_phone(r.iloc[10]),
            'address': s(r.iloc[11]),
            'email': s(r.iloc[13]),
            'contact_poc_type': normalize_poc(s(r.iloc[17])) if len(r) > 17 else None,
            'contact_poc_name': s(r.iloc[12]),
            'first_invite_sent_at': to_pg_timestamp(datetime.utcnow()) if r.iloc[14] is True else 'NULL',
            'list_status': 'b_list',
            'legacy_sheet_ref': legacy_ref('omnipres-blist', synth_code, channel_name or '', link or ''),
        })
    return rows, skipped


def normalize_poc(raw):
    if not raw:
        return None
    t = str(raw).strip().lower()
    if 'manager' in t:
        return 'manager'
    if 'influencer' in t:
        return 'influencer'
    if 'agency' in t:
        return 'agency'
    return None


def parse_video_tracking(df, engagement_type='video_tracking'):
    """Video Tracking + UGC sheets → engagements rows. Position-based.

    Video Tracking columns:
      0: code, 1: Channel Name, 2: Name, 3: Channel Link, 4: Influencer Type,
      5: Category, 6: Reach, 7: Audience, 8: Location, 9: Contact #,
      10: Address, 11: POC, 12: Video Status, 13: Directed to, 14: Comments,
      15: Shipping Month, 16: Shipping Date, 17: Tracking ID, 18: Shipping Order ID,
      19: Product Variant (Colour), 20: Product, 21: Goodies Cost, 22: Compensation,
      23: Shipping Cost, 24: Return Cost, 25: Total Cost, 26: CPM,
      27: Video Link, 28: Posting Month, 29: Posting Date, 30: Views,
      31: Likes, 32: Comments, 33: Shares, 34: UTM LINK, 35: Sessions,
      36: Orders, 37: Conversions $, 38: Affliate %, 39: Coupon Code, 40: Orders (CC)

    UGC columns:
      0: Key, 1: Channel Name, 2: Name, 3: Channel Link, 4: Influencer Type,
      5: Category, 6: Reach, 7: Audience, 8: Location, 9: Contact #,
      10: Address, 11: Video Status, 12: Posting Date, 13: Comments,
      14: Shipping Month, 15: Shipping Date, 16: Order ID, 17: Shipping Order ID,
      18: Product Variant & Colour, 19: Product, 20: Goodies Cost,
      21: Replacement YES/NO, 22: Compensation, 23: Shipping Cost, 24: Ad Spend,
      25: Commission % agreed, 26: Commission amount, 27: Total Cost,
      28: Conversions $, 29: ROAS on ad spend, 30: Actual ROAS,
      31: Views, 32: Impressions, 33: Likes, 34: Comments, 35: Shares,
      36: Directed to
    """
    rows = []
    skipped = {'no_code': 0}

    if engagement_type == 'video_tracking':
        IDX = {
            'shipping_month': 15, 'shipping_date': 16,
            'tracking_id': 17, 'shipping_order_id': 18,
            'product_variant': 19, 'product_code': 20,
            'goodies': 21, 'compensation': 22, 'shipping_cost': 23, 'return_cost': 24,
            'cpm': 26,
            'video_link': 27, 'posting_month': 28, 'post_date': 29,
            'views': 30, 'likes': 31, 'vcomments': 32, 'shares': 33,
            'utm': 34, 'sessions': 35, 'orders': 36, 'conv_value': 37,
            'affiliate_pct': 38, 'orders_cc': 40,
            'directed_to': 13, 'video_status': 12,
        }
    else:  # ugc
        IDX = {
            'shipping_month': 14, 'shipping_date': 15,
            'shipping_order_id': 17, 'product_variant': 18, 'product_code': 19,
            'goodies': 20, 'compensation': 22, 'shipping_cost': 23, 'ad_spend': 24,
            'affiliate_pct': 25, 'commission_amount': 26,
            'conv_value': 28, 'roas_on_ad_spend': 29, 'actual_roas': 30,
            'views': 31, 'impressions': 32, 'likes': 33, 'vcomments': 34, 'shares': 35,
            'directed_to': 36, 'post_date': 12,
            'video_status': 11,
        }

    for _, r in df.iterrows():
        code = s(r.iloc[0])
        if not code or not (code.upper().startswith('IN') and any(ch.isdigit() for ch in code[2:])):
            skipped['no_code'] += 1
            continue
        code = code.upper()

        def col(name, default=None):
            i = IDX.get(name)
            if i is None or i >= len(r):
                return default
            return r.iloc[i]

        product = s(col('product_code'))
        variant = s(col('product_variant'))
        video_link = s(col('video_link')) if engagement_type == 'video_tracking' else None
        post_date_raw = col('post_date')
        shipping_date_raw = col('shipping_date')

        comp = num(col('compensation'), default=0)
        affiliate_pct_val = num_or_none(col('affiliate_pct'))

        if engagement_type == 'ugc':
            if affiliate_pct_val and comp > 0:
                deal_type = 'paid_plus_affiliate'
            elif affiliate_pct_val:
                deal_type = 'affiliate'
            elif comp > 0:
                deal_type = 'paid'
            else:
                deal_type = 'barter'
        else:
            deal_type = 'paid' if comp > 0 else 'barter'

        # Stage determination: posted = closed; shipped only = delivered; nothing = identified
        if video_link:
            stage = 'closed'
            closed_reason = 'historical_import'
        elif shipping_date_raw is not None and not (isinstance(shipping_date_raw, float) and pd.isna(shipping_date_raw)):
            stage = 'delivered'
            closed_reason = None
        else:
            stage = 'identified'
            closed_reason = None

        rows.append({
            'influencer_code_ref': code,
            'engagement_type': engagement_type,
            'product_code': product,
            'product_variant': variant,
            'deal_type': deal_type,
            'payment_terms': 'on_release' if deal_type in ('paid','paid_plus_affiliate') else 'n_a',
            'payment_amount': comp,
            'affiliate_pct': affiliate_pct_val,
            'commission_amount': num_or_none(col('commission_amount')) if engagement_type == 'ugc' else None,
            'ad_spend': num(col('ad_spend'), default=0) if engagement_type == 'ugc' else 0,
            'goodies_cost': num(col('goodies'), default=0),
            'shipping_cost': num(col('shipping_cost'), default=0),
            'return_cost': num(col('return_cost'), default=0) if engagement_type == 'video_tracking' else 0,
            'cpm': num_or_none(col('cpm')) if engagement_type == 'video_tracking' else None,
            'post_date': post_date_raw,
            'video_link': video_link,
            'utm_link': s(col('utm')) if engagement_type == 'video_tracking' else None,
            'views': num(col('views'), default=0, integer=True),
            'likes': num(col('likes'), default=0, integer=True),
            'comments': num(col('vcomments'), default=0, integer=True),
            'shares': num(col('shares'), default=0, integer=True),
            'impressions': num(col('impressions'), default=0, integer=True) if engagement_type == 'ugc' else 0,
            'sessions': num(col('sessions'), default=0, integer=True) if engagement_type == 'video_tracking' else 0,
            'orders': num(col('orders'), default=0, integer=True) if engagement_type == 'video_tracking' else 0,
            'conversions_value': num(col('conv_value'), default=0),
            'orders_cc': num(col('orders_cc'), default=0, integer=True) if engagement_type == 'video_tracking' else 0,
            'shipping_order_id': s(col('shipping_order_id')),
            'tracking_id': s(col('tracking_id')) if engagement_type == 'video_tracking' else None,
            'shipping_month': s(col('shipping_month')),
            'shipping_date': shipping_date_raw,
            'directed_to': normalize_directed_to(s(col('directed_to'))),
            'stage': stage,
            'closed_reason': closed_reason,
            'legacy_sheet_ref': legacy_ref(
                'omnipres-eng',
                code, engagement_type,
                str(video_link or ''), str(shipping_date_raw or ''),
                str(product or ''), str(variant or '')
            ),
        })
    return rows, skipped


def parse_discount_codes(df):
    """discountCodes: 0:code, 1:utilized, 2:name, 3:order_name, 4:order_value,
       5:date, 6:address_pincode, 7:products, 8:quantity, 9:tracking_url"""
    rows = []
    for _, r in df.iterrows():
        code = s(r.iloc[0])
        if not code:
            continue
        rows.append({
            'code': code,
            'pool_label': '-'.join(code.split('-')[:2]) if '-' in code else None,
            'utilized': str(s(r.iloc[1]) or '').lower() == 'yes',
            'order_name': s(r.iloc[3]) or s(r.iloc[2]),
            'order_value': num_or_none(r.iloc[4]),
            'used_at': r.iloc[5],
            'address_pincode': s(r.iloc[6]),
            'products': parse_categories(s(r.iloc[7])),
            'quantity': num(r.iloc[8], default=None, integer=True),
            'tracking_url': s(r.iloc[9]),
        })
    return rows


def parse_roster(df):
    """Roster sheet → patches to influencers (rating + onboard date)."""
    rows = []
    for _, r in df.iterrows():
        sl = r.get('SL No. ')
        link = s(r.get('Channel Link '))
        if not link:
            continue
        rows.append({
            'channel_link': link,
            'channel_name': s(r.get('Channel Name')),
            'commercials': float(r.get('Commercials') or 0) if not pd.isna(r.get('Commercials')) else None,
            'onboard_at': r.get('Onboard '),
            'comments': s(r.get('Comments ')),
        })
    return rows


# ─── Emitters ────────────────────────────────────────────────────────────────

INFLUENCER_COLS = [
    'influencer_code','channel_name','person_name','channel_link','channel_platform',
    'influencer_type','categories','reach','audience','location','contact_number',
    'address','email','contact_poc_type','contact_poc_name','first_invite_sent_at',
    'list_status','legacy_sheet_ref',
]

ENGAGEMENT_COLS = [
    'influencer_code_ref','engagement_type','product_code','product_variant',
    'deal_type','payment_terms','payment_amount','affiliate_pct','commission_amount',
    'ad_spend','goodies_cost','shipping_cost','return_cost','cpm','post_date','video_link',
    'utm_link','views','likes','comments','shares','impressions','sessions','orders',
    'conversions_value','orders_cc','shipping_order_id','tracking_id','shipping_month',
    'shipping_date','directed_to','stage','closed_reason','legacy_sheet_ref',
]

DISCOUNT_COLS = [
    'code','pool_label','utilized','order_name','order_value','used_at',
    'address_pincode','products','quantity','tracking_url',
]


def emit_schema(prefix):
    sql = """-- Staging tables in ignition schema. Dropped by 99-drain.sql.
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
"""
    with open(f'{prefix}.00-schema.sql', 'w') as f:
        f.write(sql)


def emit_influencer_chunks(prefix, rows, start_idx=1):
    chunk_size = 40
    chunk_n = start_idx
    for i in range(0, len(rows), chunk_size):
        batch = rows[i:i+chunk_size]
        path = f'{prefix}.{chunk_n:02d}-influencers.sql'
        with open(path, 'w') as f:
            f.write(f'-- {len(batch)} influencer rows\n')
            f.write('INSERT INTO ignition._stage_influencers (\n  ' + ',\n  '.join(INFLUENCER_COLS) + '\n) VALUES\n')
            tuples = []
            for r in batch:
                tuples.append('(' + ', '.join([
                    sql_escape(r['influencer_code']),
                    sql_escape(r['channel_name']),
                    sql_escape(r['person_name']),
                    sql_escape(r['channel_link']),
                    sql_escape(r['channel_platform']),
                    sql_escape(r['influencer_type']),
                    sql_array(r['categories']),
                    sql_escape(r['reach']),
                    sql_escape(r['audience']),
                    sql_escape(r['location']),
                    sql_escape(r['contact_number']),
                    sql_escape(r['address']),
                    sql_escape(r['email']),
                    sql_escape(r['contact_poc_type']),
                    sql_escape(r['contact_poc_name']),
                    r['first_invite_sent_at'] if r['first_invite_sent_at'] != 'NULL' else 'NULL',
                    sql_escape(r['list_status']),
                    sql_escape(r['legacy_sheet_ref']),
                ]) + ')')
            f.write(',\n'.join(tuples))
            f.write('\nON CONFLICT (influencer_code) DO NOTHING;\n')
        chunk_n += 1
    return chunk_n


def emit_engagement_chunks(prefix, rows, start_idx=50):
    chunk_size = 30
    chunk_n = start_idx
    for i in range(0, len(rows), chunk_size):
        batch = rows[i:i+chunk_size]
        path = f'{prefix}.{chunk_n:02d}-engagements.sql'
        with open(path, 'w') as f:
            f.write(f'-- {len(batch)} engagement rows\n')
            f.write('INSERT INTO ignition._stage_engagements (\n  ' + ',\n  '.join(ENGAGEMENT_COLS) + '\n) VALUES\n')
            tuples = []
            for r in batch:
                tuples.append('(' + ', '.join([
                    sql_escape(r['influencer_code_ref']),
                    sql_escape(r['engagement_type']),
                    sql_escape(r['product_code']),
                    sql_escape(r['product_variant']),
                    sql_escape(r['deal_type']),
                    sql_escape(r['payment_terms']),
                    sql_escape(r['payment_amount']),
                    sql_escape(r['affiliate_pct']),
                    sql_escape(r['commission_amount']),
                    sql_escape(r['ad_spend']),
                    sql_escape(r['goodies_cost']),
                    sql_escape(r['shipping_cost']),
                    sql_escape(r['return_cost']),
                    sql_escape(r['cpm']),
                    to_pg_date(r['post_date']),
                    sql_escape(r['video_link']),
                    sql_escape(r['utm_link']),
                    sql_escape(r['views']),
                    sql_escape(r['likes']),
                    sql_escape(r['comments']),
                    sql_escape(r['shares']),
                    sql_escape(r['impressions']),
                    sql_escape(r['sessions']),
                    sql_escape(r['orders']),
                    sql_escape(r['conversions_value']),
                    sql_escape(r['orders_cc']),
                    sql_escape(r['shipping_order_id']),
                    sql_escape(r['tracking_id']),
                    sql_escape(r['shipping_month']),
                    to_pg_date(r['shipping_date']),
                    sql_escape(r['directed_to']),
                    sql_escape(r['stage']),
                    sql_escape(r['closed_reason']),
                    sql_escape(r['legacy_sheet_ref']),
                ]) + ')')
            f.write(',\n'.join(tuples))
            f.write('\nON CONFLICT (legacy_sheet_ref) DO NOTHING;\n')
        chunk_n += 1
    return chunk_n


def emit_code_chunks(prefix, rows, start_idx=80):
    chunk_size = 60
    chunk_n = start_idx
    for i in range(0, len(rows), chunk_size):
        batch = rows[i:i+chunk_size]
        path = f'{prefix}.{chunk_n:02d}-codes.sql'
        with open(path, 'w') as f:
            f.write(f'-- {len(batch)} discount-code rows\n')
            f.write('INSERT INTO ignition._stage_codes (\n  ' + ',\n  '.join(DISCOUNT_COLS) + '\n) VALUES\n')
            tuples = []
            for r in batch:
                tuples.append('(' + ', '.join([
                    sql_escape(r['code']),
                    sql_escape(r['pool_label']),
                    sql_escape(r['utilized']),
                    sql_escape(r['order_name']),
                    sql_escape(r['order_value']),
                    to_pg_timestamp(r['used_at']),
                    sql_escape(r['address_pincode']),
                    sql_array(r['products']),
                    sql_escape(r['quantity']),
                    sql_escape(r['tracking_url']),
                ]) + ')')
            f.write(',\n'.join(tuples))
            f.write('\nON CONFLICT (code) DO NOTHING;\n')
        chunk_n += 1
    return chunk_n


def emit_drain(prefix):
    sql = """-- Drain staging → real tables. Idempotent. Drops staging at the end.

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
"""
    with open(f'{prefix}.99-drain.sql', 'w') as f:
        f.write(sql)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print('Usage: import_omnipresent_influencer.py <input.xlsx> <output-prefix>', file=sys.stderr)
        sys.exit(1)

    xlsx_path = os.path.expanduser(sys.argv[1])
    prefix = sys.argv[2]
    os.makedirs(os.path.dirname(prefix) or '.', exist_ok=True)

    xl = pd.ExcelFile(xlsx_path)
    print(f'Sheets in file: {xl.sheet_names}', file=sys.stderr)

    # 1. Master Data (influencers)
    master_df = pd.read_excel(xl, sheet_name=' Master Data', header=0)
    inf_rows, inf_skipped = parse_master_data(master_df)
    print(f'Master Data: {len(inf_rows)} influencers ({inf_skipped} skipped)', file=sys.stderr)

    # 2. B List (more influencers)
    if 'B List' in xl.sheet_names:
        blist_df = pd.read_excel(xl, sheet_name='B List', header=0)
        blist_rows, blist_skipped = parse_b_list(blist_df)
        print(f'B List: {len(blist_rows)} influencers ({blist_skipped} skipped)', file=sys.stderr)
        inf_rows = inf_rows + blist_rows

    # Dedupe influencers by code (last write wins)
    seen = {}
    for r in inf_rows:
        seen[r['influencer_code']] = r
    inf_rows = list(seen.values())

    # 3. Video Tracking + UGC (engagements)
    vt_df = pd.read_excel(xl, sheet_name='Video Tracking ', header=0)
    vt_rows, vt_skipped = parse_video_tracking(vt_df, engagement_type='video_tracking')
    print(f'Video Tracking: {len(vt_rows)} engagements ({vt_skipped} skipped)', file=sys.stderr)

    ugc_df = pd.read_excel(xl, sheet_name='UGC', header=0)
    ugc_rows, ugc_skipped = parse_video_tracking(ugc_df, engagement_type='ugc')
    print(f'UGC: {len(ugc_rows)} engagements ({ugc_skipped} skipped)', file=sys.stderr)

    eng_rows = vt_rows + ugc_rows
    # Dedupe by legacy_sheet_ref
    seen = {}
    for r in eng_rows:
        seen[r['legacy_sheet_ref']] = r
    eng_rows = list(seen.values())

    # 4. Discount Codes
    dc_df = pd.read_excel(xl, sheet_name='discountCodes', header=0)
    dc_rows = parse_discount_codes(dc_df)
    print(f'discountCodes: {len(dc_rows)} codes', file=sys.stderr)

    # Emit SQL files
    emit_schema(prefix)
    next_idx = emit_influencer_chunks(prefix, inf_rows, start_idx=1)
    print(f'Wrote {next_idx - 1} influencer chunks', file=sys.stderr)

    next_idx = emit_engagement_chunks(prefix, eng_rows, start_idx=max(next_idx, 50))
    print(f'Wrote engagement chunks up to {next_idx - 1}', file=sys.stderr)

    next_idx = emit_code_chunks(prefix, dc_rows, start_idx=max(next_idx, 80))
    print(f'Wrote code chunks up to {next_idx - 1}', file=sys.stderr)

    emit_drain(prefix)
    print(f'Wrote drain SQL at {prefix}.99-drain.sql', file=sys.stderr)

    print('\nNext step: apply the .sql files in order via Supabase MCP apply_migration.', file=sys.stderr)
    print('  Order: .00-schema, .01..NN-influencers, .50..NN-engagements, .80..NN-codes, .99-drain', file=sys.stderr)


if __name__ == '__main__':
    main()
