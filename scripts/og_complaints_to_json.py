#!/usr/bin/env python3
"""
Emit OG Product Complaints rows as a single JSON array, ready to POST to
store.import_sheet_rows(rows jsonb).

Usage: og_complaints_to_json.py <input.xlsx> <output.json>
"""
import sys
import json
import re
import hashlib
import pandas as pd

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

CATALOG = set()
# Pulled from store.cs_issue_catalog at plan time
for line in """\
Battery & Charging Issues|Battery not charging
Battery & Charging Issues|Battery drains quickly
Battery & Charging Issues|Battery overheating
Battery & Charging Issues|Charging port not working
Battery & Charging Issues|Loose charging port
Battery & Charging Issues|Charging cable defective
Customer Experience Issues|Incomplete information provided
Customer Experience Issues|Multiple follow-ups required
Customer Experience Issues|Support not responding
Customer Experience Issues|Incorrect resolution shared
Damage / Defective|Indicator light not turning on
Damage / Defective|Not powering on
Damage / Defective|Not pairing
Damage / Defective|Intermittent connection
Damage / Defective|No movement
Damage / Defective|Forward/Reverse not working
Damage / Defective|Steering not working
Damage / Defective|Speed control not working
Damage / Defective|Body damaged / cracked
Damage / Defective|Wheel broken / loose
Damage / Defective|Steering wheel damaged
Damage / Defective|Lever broken
Damage / Defective|Lights not working
Damage / Defective|Oil leakage
Damage / Defective|Remote damaged
Damage / Defective|Buttons not working
Delivery / Shipment Issues|Delayed delivery
Delivery / Shipment Issues|Shipment not delivered
Delivery / Shipment Issues|Fake delivery attempt
Delivery / Shipment Issues|Delivery rejected
Delivery / Shipment Issues|RTO (Return to Origin)
Delivery / Shipment Issues|Incorrect address
Delivery / Shipment Issues|Pincode not serviceable
Delivery / Shipment Issues|Package damaged in transit
Delivery / Shipment Issues|Partial delivery received
Drone-Specific Issues|Broken propellers
Drone-Specific Issues|Broken arms
Drone-Specific Issues|Camera not working
Drone-Specific Issues|Drone not taking off
Drone-Specific Issues|Drone not stable / drifting
Drone-Specific Issues|Short flight time
Drone-Specific Issues|Missing propellers
Drone-Specific Issues|Missing user manual
General Queries|General queries
Missing Accessories|Missing remote
Missing Accessories|Missing spare tyres
Missing Accessories|Missing cones
Missing Accessories|Missing rechargeable batteries
Missing Accessories|Missing remote batteries
Missing Accessories|Missing charging cable
Missing Accessories|Missing screwdriver
Missing Accessories|Missing accessories set
Missing Accessories|Missing user manual
Payment & Refund Issues|Refund failed
Returns & Replacement Issues|Return pickup not scheduled
Returns & Replacement Issues|Pickup failed
Returns & Replacement Issues|Replacement delayed
Returns & Replacement Issues|Replacement out of stock
Returns & Replacement Issues|Wrong replacement received
Returns & Replacement Issues|Return rejected
Used / Dirty Product|Used tyres
Used / Dirty Product|Hair strands present
Used / Dirty Product|Dust accumulation
Used / Dirty Product|Scratches
Used / Dirty Product|Fingerprints
Used / Dirty Product|Signs of prior usage
Used / Dirty Product|Opened or resealed packaging
Used / Dirty Product|Poor packaging
Website / Order Issues|Incorrect product ordered
Wrong Item / Switcheroo|Wrong product delivered
Wrong Item / Switcheroo|Wrong model / variant
Wrong Item / Switcheroo|Wrong color
""".strip().splitlines():
    cat, sub = line.split('|')
    CATALOG.add((cat, sub))


def normalize_phone(raw):
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None
    d = re.sub(r'\D', '', str(raw))
    if not d:
        return None
    if len(d) == 10:
        return f'+91{d}'
    if len(d) == 12 and d.startswith('91'):
        return f'+{d}'
    return f'+{d}'


def s(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    return str(v).strip()


def main():
    xlsx_path, out_path = sys.argv[1], sys.argv[2]
    df = pd.read_excel(xlsx_path, sheet_name='Complaints', header=3)

    rows = []
    for _, r in df.iterrows():
        order_id = s(r.get('Order ID'))
        date_v   = r.get('Date')
        name     = s(r.get('Customer Name'))
        if not order_id or pd.isna(date_v) or not name:
            continue

        phone = normalize_phone(r.get('Phone'))
        date_iso = pd.to_datetime(date_v, errors='coerce').strftime('%Y-%m-%d')
        ref_key  = f'{order_id}|{date_iso}|{phone or ""}'
        legacy_ref = 'sheet-' + hashlib.sha1(ref_key.encode('utf-8')).hexdigest()[:16]

        channel  = s(r.get('Channel'))
        platform = CHANNEL_MAP.get(channel) if channel else None
        if platform is None and channel:
            platform = 'other'

        cat = s(r.get('Issue Category'))
        sub = s(r.get('Issue Sub-Category'))
        if cat and sub and (cat, sub) in CATALOG:
            issue_subcategory = sub
            issue_sub_custom  = None
        else:
            issue_subcategory = None
            issue_sub_custom  = sub

        rows.append({
            'legacy_sheet_ref':         legacy_ref,
            'created_at':               date_iso + 'T00:00:00Z',
            'customer_name':            name,
            'customer_phone':           phone,
            'customer_email':           s(r.get('Email')),
            'platform':                 platform,
            'external_order_id':        order_id,
            'product':                  s(r.get('Product')),
            'product_sku':              s(r.get('Product Category')),
            'issue_category':           cat,
            'issue_subcategory':        issue_subcategory,
            'issue_subcategory_custom': issue_sub_custom,
            'issue_description':        s(r.get('Issue Description')),
        })

    # Dedupe within the file — last write wins
    seen = {}
    for r in rows:
        seen[r['legacy_sheet_ref']] = r
    deduped = list(seen.values())

    with open(out_path, 'w') as f:
        json.dump({'rows': deduped}, f)

    print(f'Wrote {len(deduped)} rows (out of {len(rows)} raw) → {out_path}', file=sys.stderr)


if __name__ == '__main__':
    main()
