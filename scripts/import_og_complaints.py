#!/usr/bin/env python3
"""
Import OG Product Complaints.xlsx → store.cs_tickets as closed historic tickets.

Reads ~/Downloads/OG Product Complaints.xlsx, builds one SQL INSERT statement
per batch of 100 rows, writes them to a single .sql file ready to apply via
the Supabase MCP apply_migration tool.

Idempotency: every row gets a legacy_sheet_ref = SHA1(Order ID | Date | phone)
that we check against existing cs_tickets before inserting.

Run:
  python3 scripts/import_og_complaints.py path/to/file.xlsx output.sql
"""

import sys
import re
import hashlib
import pandas as pd
from datetime import datetime, time

# Channel → platform CHECK enum (RULE-PITSTOP platform CHECK)
CHANNEL_MAP = {
    'Website':           'website',
    'Amazon':            'amazon',
    'CRED':              'cred',
    'Swiggy':            'swiggy',
    'Zepto':             'zepto',
    'Blinkit':           'blinkit',
    'Flipkart':          'flipkart',
    'Offline':           'offline',
    'Instamart':         'instamart',
    'Krazy Caterpillar': 'other',
}

# (cat, subcat) pairs in store.cs_issue_catalog — only these go to issue_subcategory.
# Anything else (combos, free text) goes to issue_subcategory_custom with subcategory=null.
CATALOG = {
    ('Battery & Charging Issues', 'Battery not charging'): True,
    ('Battery & Charging Issues', 'Battery drains quickly'): True,
    ('Battery & Charging Issues', 'Battery overheating'): True,
    ('Battery & Charging Issues', 'Charging port not working'): True,
    ('Battery & Charging Issues', 'Loose charging port'): True,
    ('Battery & Charging Issues', 'Charging cable defective'): True,
    ('Customer Experience Issues', 'Incomplete information provided'): True,
    ('Customer Experience Issues', 'Multiple follow-ups required'): True,
    ('Customer Experience Issues', 'Support not responding'): True,
    ('Customer Experience Issues', 'Incorrect resolution shared'): True,
    ('Damage / Defective', 'Indicator light not turning on'): True,
    ('Damage / Defective', 'Not powering on'): True,
    ('Damage / Defective', 'Not pairing'): True,
    ('Damage / Defective', 'Intermittent connection'): True,
    ('Damage / Defective', 'No movement'): True,
    ('Damage / Defective', 'Forward/Reverse not working'): True,
    ('Damage / Defective', 'Steering not working'): True,
    ('Damage / Defective', 'Speed control not working'): True,
    ('Damage / Defective', 'Body damaged / cracked'): True,
    ('Damage / Defective', 'Wheel broken / loose'): True,
    ('Damage / Defective', 'Steering wheel damaged'): True,
    ('Damage / Defective', 'Lever broken'): True,
    ('Damage / Defective', 'Lights not working'): True,
    ('Damage / Defective', 'Oil leakage'): True,
    ('Damage / Defective', 'Remote damaged'): True,
    ('Damage / Defective', 'Buttons not working'): True,
    ('Delivery / Shipment Issues', 'Delayed delivery'): True,
    ('Delivery / Shipment Issues', 'Shipment not delivered'): True,
    ('Delivery / Shipment Issues', 'Fake delivery attempt'): True,
    ('Delivery / Shipment Issues', 'Delivery rejected'): True,
    ('Delivery / Shipment Issues', 'RTO (Return to Origin)'): True,
    ('Delivery / Shipment Issues', 'Incorrect address'): True,
    ('Delivery / Shipment Issues', 'Pincode not serviceable'): True,
    ('Delivery / Shipment Issues', 'Package damaged in transit'): True,
    ('Delivery / Shipment Issues', 'Partial delivery received'): True,
    ('Drone-Specific Issues', 'Broken propellers'): True,
    ('Drone-Specific Issues', 'Broken arms'): True,
    ('Drone-Specific Issues', 'Camera not working'): True,
    ('Drone-Specific Issues', 'Drone not taking off'): True,
    ('Drone-Specific Issues', 'Drone not stable / drifting'): True,
    ('Drone-Specific Issues', 'Short flight time'): True,
    ('Drone-Specific Issues', 'Missing propellers'): True,
    ('Drone-Specific Issues', 'Missing user manual'): True,
    ('General Queries', 'General queries'): True,
    ('Missing Accessories', 'Missing remote'): True,
    ('Missing Accessories', 'Missing spare tyres'): True,
    ('Missing Accessories', 'Missing cones'): True,
    ('Missing Accessories', 'Missing rechargeable batteries'): True,
    ('Missing Accessories', 'Missing remote batteries'): True,
    ('Missing Accessories', 'Missing charging cable'): True,
    ('Missing Accessories', 'Missing screwdriver'): True,
    ('Missing Accessories', 'Missing accessories set'): True,
    ('Missing Accessories', 'Missing user manual'): True,
    ('Payment & Refund Issues', 'Refund failed'): True,
    ('Returns & Replacement Issues', 'Return pickup not scheduled'): True,
    ('Returns & Replacement Issues', 'Pickup failed'): True,
    ('Returns & Replacement Issues', 'Replacement delayed'): True,
    ('Returns & Replacement Issues', 'Replacement out of stock'): True,
    ('Returns & Replacement Issues', 'Wrong replacement received'): True,
    ('Returns & Replacement Issues', 'Return rejected'): True,
    ('Used / Dirty Product', 'Used tyres'): True,
    ('Used / Dirty Product', 'Hair strands present'): True,
    ('Used / Dirty Product', 'Dust accumulation'): True,
    ('Used / Dirty Product', 'Scratches'): True,
    ('Used / Dirty Product', 'Fingerprints'): True,
    ('Used / Dirty Product', 'Signs of prior usage'): True,
    ('Used / Dirty Product', 'Opened or resealed packaging'): True,
    ('Used / Dirty Product', 'Poor packaging'): True,
    ('Website / Order Issues', 'Incorrect product ordered'): True,
    ('Wrong Item / Switcheroo', 'Wrong product delivered'): True,
    ('Wrong Item / Switcheroo', 'Wrong model / variant'): True,
    ('Wrong Item / Switcheroo', 'Wrong color'): True,
}


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


def sql_escape(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 'NULL'
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    s = str(v).replace("'", "''")
    return f"'{s}'"


def to_pg_timestamp(v):
    if v is None or pd.isna(v):
        return 'NULL'
    if isinstance(v, datetime):
        d = v
    else:
        d = pd.to_datetime(v, errors='coerce')
        if pd.isna(d):
            return 'NULL'
    # Treat as UTC midnight (no time of day in source sheet)
    return f"'{d.strftime('%Y-%m-%dT00:00:00Z')}'"


def main():
    if len(sys.argv) < 3:
        print('Usage: import_og_complaints.py <input.xlsx> <output.sql>', file=sys.stderr)
        sys.exit(1)

    xlsx_path = sys.argv[1]
    out_path  = sys.argv[2]

    df = pd.read_excel(xlsx_path, sheet_name='Complaints', header=3)

    rows = []
    skipped = {'no_order_id': 0, 'no_date': 0, 'no_name': 0}
    cat_unknown_pairs = set()

    for _, r in df.iterrows():
        order_id = r.get('Order ID')
        date_v   = r.get('Date')
        name     = r.get('Customer Name')

        if pd.isna(order_id) or not str(order_id).strip():
            skipped['no_order_id'] += 1
            continue
        if pd.isna(date_v):
            skipped['no_date'] += 1
            continue
        if pd.isna(name) or not str(name).strip():
            skipped['no_name'] += 1
            continue

        phone_raw = r.get('Phone')
        phone = normalize_phone(phone_raw)

        # legacy_sheet_ref = SHA1(Order ID | Date | phone)
        date_iso = pd.to_datetime(date_v, errors='coerce').strftime('%Y-%m-%d')
        ref_key  = f'{str(order_id).strip()}|{date_iso}|{phone or ""}'
        legacy_ref = 'sheet-' + hashlib.sha1(ref_key.encode('utf-8')).hexdigest()[:16]

        channel  = r.get('Channel')
        platform = CHANNEL_MAP.get(str(channel).strip() if isinstance(channel, str) else None) if channel and not pd.isna(channel) else None
        if platform is None and channel and not pd.isna(channel):
            platform = 'other'

        cat = r.get('Issue Category')
        sub = r.get('Issue Sub-Category')
        cat_clean = None if pd.isna(cat) else str(cat).strip()
        sub_clean = None if pd.isna(sub) else str(sub).strip()

        if cat_clean and sub_clean and (cat_clean, sub_clean) in CATALOG:
            issue_subcategory = sub_clean
            issue_sub_custom  = None
        else:
            issue_subcategory = None
            issue_sub_custom  = sub_clean
            if cat_clean and sub_clean:
                cat_unknown_pairs.add((cat_clean, sub_clean))

        rows.append({
            'legacy_sheet_ref':         legacy_ref,
            'created_at':               to_pg_timestamp(date_v),
            'customer_name':            str(name).strip(),
            'customer_phone':           phone,
            'customer_email':           None if pd.isna(r.get('Email'))     else str(r.get('Email')).strip(),
            'platform':                 platform,
            'external_order_id':        str(order_id).strip(),
            'product':                  None if pd.isna(r.get('Product'))   else str(r.get('Product')).strip(),
            'product_sku':              None if pd.isna(r.get('Product Category')) else str(r.get('Product Category')).strip(),
            'issue_category':           cat_clean,
            'issue_subcategory':        issue_subcategory,
            'issue_subcategory_custom': issue_sub_custom,
            'issue_description':        None if pd.isna(r.get('Issue Description')) else str(r.get('Issue Description')).strip(),
        })

    print(f'Parsed: {len(rows)} importable rows', file=sys.stderr)
    print(f'Skipped: {skipped}', file=sys.stderr)
    if cat_unknown_pairs:
        print(f'Unknown (cat,subcat) pairs that went to issue_subcategory_custom: {len(cat_unknown_pairs)} distinct', file=sys.stderr)
        for c, s in sorted(cat_unknown_pairs)[:5]:
            print(f'  • {c} → {s[:80]}', file=sys.stderr)

    # Two-phase emit:
    # - schema.sql: create staging table store._sheet_stage_og
    # - data.NN.sql: compact INSERT INTO _sheet_stage_og VALUES … (one tuple per row, ~250 rows per chunk)
    # - drain.sql: PL/pgSQL DO block that mints seq + inserts into cs_tickets, then DROPs staging
    schema_sql = '''CREATE TABLE IF NOT EXISTS store._sheet_stage_og (
  legacy_sheet_ref text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  customer_name text NOT NULL,
  customer_phone text,
  customer_email text,
  platform text,
  external_order_id text,
  product text,
  product_sku text,
  issue_category text,
  issue_subcategory text,
  issue_subcategory_custom text,
  issue_description text
);
GRANT ALL ON store._sheet_stage_og TO service_role;
'''
    with open(f'{out_path}.00-schema.sql', 'w') as f:
        f.write(schema_sql)

    chunk_size = 40
    chunk_count = 0
    for i in range(0, len(rows), chunk_size):
        chunk_count += 1
        batch = rows[i:i + chunk_size]
        with open(f'{out_path}.{chunk_count:02d}-data.sql', 'w') as f:
            f.write(f'-- chunk {chunk_count}, {len(batch)} rows\n')
            f.write('INSERT INTO store._sheet_stage_og VALUES\n')
            tuples = []
            for r in batch:
                tuples.append('({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})'.format(
                    sql_escape(r['legacy_sheet_ref']),
                    r['created_at'],
                    sql_escape(r['customer_name']),
                    sql_escape(r['customer_phone']),
                    sql_escape(r['customer_email']),
                    sql_escape(r['platform']),
                    sql_escape(r['external_order_id']),
                    sql_escape(r['product']),
                    sql_escape(r['product_sku']),
                    sql_escape(r['issue_category']),
                    sql_escape(r['issue_subcategory']),
                    sql_escape(r['issue_subcategory_custom']),
                    sql_escape(r['issue_description']),
                ))
            f.write(',\n'.join(tuples))
            f.write('\nON CONFLICT (legacy_sheet_ref) DO NOTHING;\n')

    drain_sql = """DO $$
DECLARE
  r RECORD;
  seq bigint;
  inserted_count int := 0;
BEGIN
  FOR r IN
    SELECT * FROM store._sheet_stage_og
    WHERE NOT EXISTS (SELECT 1 FROM store.cs_tickets t WHERE t.legacy_sheet_ref = _sheet_stage_og.legacy_sheet_ref)
    ORDER BY created_at ASC, legacy_sheet_ref ASC
  LOOP
    seq := store.next_cs_ticket_seq('2026');
    INSERT INTO store.cs_tickets (
      ticket_no, created_at, created_by_user_id, created_by_name,
      intake_channel, customer_name, customer_phone, customer_email,
      platform, external_order_id, product, product_sku,
      issue_category, issue_subcategory, issue_subcategory_custom,
      issue_description, disposition, stage, stage_changed_at,
      closed_at, closed_reason, auto_created, legacy_sheet_ref
    ) VALUES (
      'CS-2026-' || LPAD(seq::text, 5, '0'),
      r.created_at, NULL, 'Sheet Import 2026-05-28',
      'sheet', r.customer_name, r.customer_phone, r.customer_email,
      r.platform, r.external_order_id, r.product, r.product_sku,
      r.issue_category, r.issue_subcategory, r.issue_subcategory_custom,
      COALESCE(r.issue_description, ''),
      'no_action', 'closed', r.created_at,
      r.created_at, 'historical_import', true, r.legacy_sheet_ref
    );
    inserted_count := inserted_count + 1;
  END LOOP;
  RAISE NOTICE 'Inserted % historic tickets', inserted_count;
END $$;

DROP TABLE store._sheet_stage_og;
"""
    with open(f'{out_path}.99-drain.sql', 'w') as f:
        f.write(drain_sql)

    print(f'Wrote schema + {chunk_count} data chunks + drain → {out_path}.NN-*.sql', file=sys.stderr)


if __name__ == '__main__':
    main()
