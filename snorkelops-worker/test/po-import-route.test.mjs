// Import PO — previewSalesOrderImport (read-only resolve) + learnSkuMappings (sku_map insert-if-absent)
// + the createSalesOrder save-time guard. Harsh #bugs 1793871854.409349; plan
// docs/superpowers/plans/2026-11-09-snorkel-channel-po-import.md.
// Single-file worker, no named exports — the block is lifted out of index.js (as in
// fulfilment-in-chunks.test.mjs) and run against an in-memory fake of the PostgREST reads.
// Partner rows below are the live shapes (store.sales_partners, read 2026-11-09), trimmed.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const BLOCK = [
  lift('const normHsn = ', '\n\n'),
  lift('const IN_CHUNK = ', '\n// Batched loader'),
].join('\n');

const CH = { ZEPTO: 'c722d174-d4da-4155-84bd-aed1fc4306fd', INSTAMART: 'a083042a-dbb5-4f92-81ee-1497d3e41794', FLIPKART_MGD: 'b157d0f6-b090-402c-bad7-5dfe8e1bba43' };
const PARTNERS = [
  { id: 'p-zep-mum', partner_code: 'SP-0160', channel_key: 'ZEPTO', name: 'ZEPTO LIMITED (…) MUM-SS-MH-SHAKTI (MUM175M)', gstin: '27AAICK4821A1ZV', city: 'Bhiwandi', pincode: null, shipping_address: null, billing_address: null },
  { id: 'p-zep-blr', partner_code: 'SP-0159', channel_key: 'ZEPTO', name: 'ZEPTO LIMITED (…) BLR-SS-MH-SUMADHURA (BLR135M)', gstin: '29AAICK4821A1ZR', city: 'Bangalore', pincode: null, shipping_address: null, billing_address: null },
  { id: 'p-im-mum', partner_code: 'SP-0167', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED MUM FC22', gstin: '27AAVCS1691R1Z5', city: 'Mumbai', pincode: '421302', shipping_address: null,
    billing_address: 'SCOOTSY LOGISTICS PRIVATE LIMITED\nMUM FC22, Survey No.26,27,28 C1 Building, Savad Naka Road, , Global Logistics Company, village Janval-Lonad,\nBhiwandi, Thane\nMumbai, Maharashtra, 421302' },
  { id: 'p-im-pun', partner_code: 'SP-0168', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED PUN Delhivery', gstin: '27AAVCS1691R1Z5', city: 'PUNE', pincode: '410507', shipping_address: null,
    billing_address: 'SCOOTSY LOGISTICS PRIVATE LIMITED\nPUN Delhivery, Scootsy Logistics Private Limited, Gat No. 43/1-P and 46-P\nPune, Maharashtra, 410507' },
  { id: 'p-im-hyd1', partner_code: 'SP-0186', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED  HYD IM1', gstin: '36AAVCS1691R2Z5', city: 'Hyderabad', pincode: '501401', shipping_address: null,
    billing_address: 'Survey No.45/A/2, (OLD SY No.45),, Kandlakoya \nHyderabad, Telangana, 501401' },
  { id: 'p-im-hyd2', partner_code: 'SP-0181', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED HYD IM2', gstin: '36AAVCS1691R2Z5', city: 'Hyderabad', pincode: '501401', shipping_address: null,
    billing_address: 'Sy no. 518, 527 , Kistapur Village, opp RDC Concrets, Medchal\nHyderabad, Telangana, 501401' },
  { id: 'p-im-cmq', partner_code: 'SP-0175', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED CMQPO', gstin: '36AAVCS1691R2Z5', city: 'Hyderabad', pincode: '501510', shipping_address: null,
    billing_address: 'On the ground floor, comprised in survey nos., 143E/A1, 143E/A2, 143AA/1, 143AA/5, 143AA/3\nHyderabad, Telangana, 501510' },
  { id: 'p-im-hyd5', partner_code: 'SP-0252', channel_key: 'INSTAMART', name: 'scootsy hyd im5', gstin: '36AAVCS1691R2Z5', city: 'hyderabad', pincode: '501510',
    shipping_address: 'SCOOTSY LOGISTICS PRIVATE LIMITED\nSurvey Nos. 143E/A1, 143E/A2, 143AA/1, 143AA/5, 143AA/3, 143/2, 143A/3, Mangalapally Village, Ibrahimpatnam\nRevenue Mandal, Ranga Reddy Distric', billing_address: null },
  { id: 'p-im-blr4', partner_code: 'SP-0164', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED BLR IM4', gstin: '29AAVCS1691R1Z1', city: 'Bangalore', pincode: '562114', shipping_address: null,
    billing_address: 'SCOOTSY LOGISTICS PRIVATE LIMITED\nBLR IM4, Ground floor, warehouse no- 4 and 5, sy no-95/2 , Anugondahalli village, hobli, Hoskote, Bengaluru Rural,\nKarnataka\nBangalore, Karnataka, 562114' },
  { id: 'p-im-blr1', partner_code: 'SP-0166', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED BLR IM1', gstin: '29AAVCS1691R1Z1', city: 'Bangalore', pincode: '562114', shipping_address: null,
    billing_address: 'SCOOTSY LOGISTICS PRIVATE LIMITED\nBLR IM1, Survey no 95/2 and 4/1, Anugondanahalli village, Hoskote taluk,Bangalore rural,Bangalore,\nBangalore, Karnataka, 562114' },
  { id: 'p-im-blre2', partner_code: 'SP-0176', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED BLR Ecom2', gstin: '29AAVCS1691R1Z1', city: 'Bangalore', pincode: '562114', shipping_address: null,
    billing_address: 'BLR Ecom2, 2/3, 3/1, 3/2, 21/1, 21/3,, Ekarajapura Village,, Sulibele Hobli, Hosakote Taluk\nBangalore, Karnataka, 562114' },
  { id: 'p-im-blrdhl', partner_code: 'SP-0177', channel_key: 'INSTAMART', name: 'SCOOTSY LOGISTICS PRIVATE LIMITED BLR DHL', gstin: '29AAVCS1691R1Z1', city: 'Bangalore', pincode: '562107', shipping_address: null,
    billing_address: 'BLR DHL, Survey Nos. 50, 51/1 to 51/7, 52/2, 53/2 and, part of 311/1, 313/1 to 313/3,, Mayasandra Village, Attibele\nHobli, Anekal Taluk,\nBangalore, Karnataka, 562107' },
  { id: 'p-fk-anekal', partner_code: 'SP-0224', channel_key: 'FLIPKART_MGD', name: 'Flipkart Minutes Anekal Banglore', gstin: '29AABCF8078M1ZX', city: 'BENGALURU', pincode: '562106', shipping_address: null,
    billing_address: 'Survey No 518,519, 520/3, 526/1,526/2 ,521/2 , 521/3 , 521/4 and 521/3 of Madiwala Village Marasurgram panchayat Anekal taluk Bangalore Urban Karnataka 562106 Bangalore Karnataka 562106 India' },
  { id: 'p-fk-kolar', partner_code: 'SP-0239', channel_key: 'FLIPKART_MGD', name: 'FLIPKART INDIA PRIVATE LIMITED KOLAR', gstin: '29AABCF8078M1ZX', city: 'BANGALORE', pincode: '563130',
    shipping_address: 'Marasandra and Madnahatti -Venkatapura Villages, Kasaba Hobli, Malur Taluk ,Dist -Kolar Malur BENGALURU Karnataka 563130 India', billing_address: null },
  { id: 'p-fk-144', partner_code: 'SP-0144', channel_key: 'FLIPKART_MGD', name: 'Flipkart Private India Ltd (Bangalore)', gstin: '29AABCF8078M1ZX', city: 'bangalore', pincode: '562122',
    shipping_address: 'Flipkart India Private Limited, Sy no 18/2, 18/3 situated as Taverekere Venkatapura, Hosakote Taluk, Nadagudi Hobli, Bengaluru 562122 Bengaluru 562122',
    billing_address: '938, Ground Floor 3rd Cross, 1st Block,, Kalyan Nagar,Bengaluru urban, Bengaluru 560043, Karnataka' },
  { id: 'p-fk-223', partner_code: 'SP-0223', channel_key: 'FLIPKART_MGD', name: 'Flipkart Minutes Taverekere Banglore', gstin: '29AABCF8078M1ZX', city: 'BENGALURU', pincode: '562122', shipping_address: null,
    billing_address: 'Sy no 18/2, 18/3, 18/4, 19/1, 19/2, 19/3, 20/1, 20/2, 20/3, 21/2, 22/2, 23/2, 23/3, 23/4 situated as Taverekere Venkatapura, Hosakote Taluk, Nadagudi Hobli, Bengaluru 562122 Bengaluru Karnataka 562122 India' },
  { id: 'p-fk-143', partner_code: 'SP-0143', channel_key: 'FLIPKART_MGD', name: 'flipkart India Private ltd', gstin: '29AABCF8078M1ZX', city: 'bangalore', pincode: '562122',
    shipping_address: 'Flipkart India Private Limited, Sy no 18/2, 18/3 situated as Taverekere Venkatapura, Hosakote Taluk, Nadagudi Hobli, Bengaluru 562122 Bengaluru 562122',
    billing_address: '938, Ground Floor 3rd Cross, 1st Block,, Kalyan Nagar,Bengaluru urban, Bengaluru 560043, Karnataka' },
  { id: 'p-fk-145', partner_code: 'SP-0145', channel_key: 'FLIPKART_MGD', name: 'Flipkart Private India Ltd (Bangalore)', gstin: '29AABCF8078M1ZX', city: 'bangalore', pincode: '562122',
    shipping_address: 'Flipkart India Private Limited, Sy no 18/2, 18/3 situated as Taverekere Venkatapura, Hosakote Taluk, Nadagudi Hobli, Bengaluru 562122 Bengaluru 562122',
    billing_address: '938, Ground Floor 3rd Cross, 1st Block,, Kalyan Nagar,Bengaluru urban, Bengaluru 560043, Karnataka' },
];
const PM = [
  { product_code: 'GHUW', product: 'Ghost', model: 'Underground', color: 'White', sku: 'ghost-underground-white', ean: '5949998516382', hsn_code: '9503', is_active: true, component_type: 'car' },
  { product_code: 'SHAK', product: 'Shadow', model: 'Asphalt', color: 'Black', sku: 'shadow-asphalt-black', ean: '5949999234230', hsn_code: '9503', is_active: true, component_type: 'car' },
  { product_code: 'SHTK', product: 'Shadow', model: 'Tarmac', color: 'Black', sku: 'shadow-tarmac-black', ean: '5949998500299', hsn_code: '9503', is_active: true, component_type: 'car' },
  { product_code: 'GHUK', product: 'Ghost', model: 'Underground', color: 'Black', sku: 'ghost-underground-black', ean: '5949998487842', hsn_code: '9503', is_active: true, component_type: 'car' },
  { product_code: 'FABX', product: 'Fang', model: 'Base', color: 'Excavator', sku: 'fang-base-excavator', ean: '5949998420771', hsn_code: '9503', is_active: true, component_type: 'car' },
  { product_code: 'OLDX', product: 'Ghost', model: 'Retired', color: 'Grey', sku: 'ghost-retired-grey', ean: null, hsn_code: '9503', is_active: false, component_type: 'car' },
  { product_code: 'GHRM', product: 'Ghost', model: 'Remote', color: null, sku: 'ghost-remote', ean: null, hsn_code: '9503', is_active: true, component_type: 'remote' },
];

// In-memory PostgREST: parses just the filters these routes send.
function fakeDb({ skuMap = [], orders = [], dispatch = CH } = {}) {
  const calls = [];
  const inVals = (params, col) => {
    const m = params.match(new RegExp(`[?&]${col}=in\\.\\(([^)]*)\\)`));
    return m ? decodeURIComponent(m[1]).split(',').map(v => v.replace(/^"|"$/g, '')) : null;
  };
  const eq = (params, col) => { const m = params.match(new RegExp(`[?&]${col}=(?:eq|ilike)\\.([^&]*)`)); return m ? decodeURIComponent(m[1]) : null; };
  const store = { sku_map: skuMap.map((r, i) => ({ id: i + 1, ...r })) };
  const query = async (table, params = '') => {
    calls.push(['store', table, params]);
    if (table === 'sales_partners') return { ok: true, data: PARTNERS.filter(p => p.channel_key === eq(params, 'channel_key')) };
    if (table === 'sales_channels') {
      const keys = inVals(params, 'channel_key') || [eq(params, 'channel_key')];
      return { ok: true, data: keys.filter(k => dispatch[k]).map(k => ({ channel_key: k, dispatch_channel_id: dispatch[k] })) };
    }
    if (table === 'sales_orders') {
      const ref = (eq(params, 'partner_po_ref') || '').toLowerCase(), pid = eq(params, 'partner_id'), pids = inVals(params, 'partner_id');
      return { ok: true, data: orders.filter(o => o.status !== 'cancelled' && o.partner_po_ref.toLowerCase() === ref && (!pid || o.partner_id === pid) && (!pids || pids.includes(o.partner_id))) };
    }
    throw new Error('unexpected store read ' + table);
  };
  const queryPublic = async (table, params = '') => {
    calls.push(['public', table, params]);
    assert.equal(table, 'product_master');
    for (const col of ['ean', 'product_code', 'product']) {
      const vals = inVals(params, col);
      if (vals) return { ok: true, data: PM.filter(r => vals.includes(r[col])) };
    }
    throw new Error('unexpected product_master read ' + params);
  };
  const sb = async (path, opts = {}) => {
    calls.push(['sales', path, opts.method || 'GET']);
    assert.equal(opts.headers?.['Accept-Profile'], 'sales');
    if (!opts.method || opts.method === 'GET') {
      const cid = eq(path, 'channel_id'), codes = inVals(path, 'channel_sku');
      return { ok: true, data: store.sku_map.filter(r => r.channel_id === cid && codes.includes(r.channel_sku)) };
    }
    assert.match(path, /on_conflict=channel_id,channel_sku/);
    assert.match(opts.prefer, /resolution=ignore-duplicates/);
    const inserted = [];
    for (const row of JSON.parse(opts.body)) {
      if (store.sku_map.some(r => r.channel_id === row.channel_id && r.channel_sku === row.channel_sku)) continue;   // DO NOTHING
      const r = { id: store.sku_map.length + 1, ...row };
      store.sku_map.push(r); inserted.push(r);
    }
    return { ok: true, data: inserted };
  };
  const hsnMasterAll = async () => new Map([['Ghost', { hsn: '9503', gst: 18 }], ['Shadow', { hsn: '9503', gst: 18 }], ['Fang', { hsn: '9503', gst: 18 }]]);
  return { calls, store, query, queryPublic, sb, hsnMasterAll };
}
function load(db) {
  return new Function('sb', 'query', 'queryPublic', 'hsnMasterAll',
    `${BLOCK}\nreturn { previewSalesOrderImport, learnSkuMappings, resolveImportPartner, importChecksum, importDuplicateRefusal,\n      learnFromImportOrder: typeof learnFromImportOrder === "function" ? learnFromImportOrder : undefined };`)(db.sb, db.query, db.queryPublic, db.hsnMasterAll);
}

const ZEPTO_PO = {
  channel_key: 'ZEPTO', po_no: 'P6150806', po_date: '2026-11-05', delivery_date: '2026-11-06', expiry_date: '2026-12-12',
  ship_to_gstin: '27AAICK4821A1ZV', ship_to_address: 'MUM-SS-MH-SHAKTI (MUM175M), R2,Shakti Logistics Park … Maharashtra 421302', ship_to_pincode: '421302',
  lines: [
    { channel_code: '05285852-99e0-4b15-8ce1-d8dc026e4bf4', ean: '5949999234230', qty: 12, unit_cost_ex_gst: 1203.86, gst_pct: 18, mrp: 3999 },
    { channel_code: '125e53c2-3c24-423d-8388-4ff47200d1ac', ean: '5949998500299', qty: 24, unit_cost_ex_gst: 1203.86, gst_pct: 18, mrp: 3999 },
  ],
  po_total_taxable: 43338.81,
};

test('matched: sku_map hit, EAN fallback, enrichment from the product master, checksum clean', async () => {
  const db = fakeDb({ skuMap: [{ channel_id: CH.ZEPTO, channel_sku: '05285852-99e0-4b15-8ce1-d8dc026e4bf4', product_code: 'SHAK', match_on: 'manual' }] });
  const r = await load(db).previewSalesOrderImport(ZEPTO_PO);
  assert.ok(r.data, r.error);
  const d = r.data;
  assert.equal(d.partner.status, 'matched'); assert.equal(d.partner.via, 'gstin'); assert.equal(d.partner.partner.id, 'p-zep-mum');
  assert.equal(d.lines[0].matched_by, 'sku_map'); assert.equal(d.lines[0].product_code, 'SHAK');
  assert.equal(d.lines[1].matched_by, 'ean');     assert.equal(d.lines[1].product_code, 'SHTK');   // UUID not mapped → EAN
  assert.deepEqual([d.lines[1].product, d.lines[1].model, d.lines[1].color, d.lines[1].sku], ['Shadow', 'Tarmac', 'Black', 'shadow-tarmac-black']);
  assert.equal(d.lines[0].hsn_code, '9503');      // the master's, never the PO's 95030030
  assert.equal(d.lines[0].gst_pct, 18);
  assert.equal(d.lines[0].rate, 1203.86);
  assert.equal(d.unmatched, 0);
  assert.equal(d.checksum.ok, true); assert.equal(d.checksum.so_taxable, 43338.96); assert.equal(d.checksum.diff, 0.15);   // 1203.86 is Zepto's own rounding
  assert.deepEqual(d.po, { po_no: 'P6150806', po_date: '2026-11-05', delivery_date: '2026-11-06', expiry_date: '2026-12-12', ship_to_gstin: '27AAICK4821A1ZV', ship_to_address: ZEPTO_PO.ship_to_address });
  // Batched: no per-line reads — one EAN read, one sku_map read, one product_code read, whatever the line count.
  assert.equal(db.calls.filter(c => c[0] === 'public' && /ean=in/.test(c[2])).length, 1);
  assert.equal(db.calls.filter(c => c[0] === 'sales').length, 1);
  assert.ok(db.calls.every(c => c[2] !== 'POST'), 'preview writes nothing');
});

test('unmatched: an unknown code with no EAN comes back flagged, not guessed', async () => {
  const db = fakeDb();
  const po = { channel_key: 'INSTAMART', po_no: 'CMFPO377563', ship_to_gstin: '27AAVCS1691R1Z5', ship_to_pincode: '421302', ship_to_address: 'MUM FC22, Survey No.26 … Mumbai, Maharashtra, 421302', ship_to_city: 'Mumbai',
    lines: [{ channel_code: '999999', ean: null, title: 'Mystery car', qty: 36, unit_cost_ex_gst: 1135.09932, gst_pct: 18 }], po_total_taxable: 40863.58 };
  const d = (await load(db).previewSalesOrderImport(po)).data;
  assert.equal(d.unmatched, 1);
  const l = d.lines[0];
  assert.equal(l.matched, false); assert.equal(l.product, null); assert.equal(l.hsn_code, null);
  assert.match(l.note, /No product mapped to 999999/);
  assert.equal(l.gst_pct, 18, 'falls back to the PO rate until a product is picked');
  assert.equal(l.rate, 1135.1);
});

test('ambiguous partner: shared GSTIN and nothing singles one out → candidates, no pick', async () => {
  const db = fakeDb({ skuMap: [{ channel_id: CH.INSTAMART, channel_sku: '140019', product_code: 'GHUW' }] });
  const po = { channel_key: 'INSTAMART', po_no: 'HYDPO1', ship_to_gstin: '36AAVCS1691R2Z5', ship_to_address: 'Hyderabad, Telangana, 500001', ship_to_pincode: '500001',
    lines: [{ channel_code: '140019', qty: 1, unit_cost_ex_gst: 1000, gst_pct: 18 }], po_total_taxable: 1000 };
  const api = load(db);
  const d = (await api.previewSalesOrderImport(po)).data;
  assert.equal(d.partner.status, 'ambiguous');
  assert.equal(d.partner.partner, null);
  assert.deepEqual(d.partner.candidates.map(c => c.id).sort(), ['p-im-cmq', 'p-im-hyd1', 'p-im-hyd2', 'p-im-hyd5']);
  // The user picks → the same preview resolves to that partner.
  const d2 = (await api.previewSalesOrderImport({ ...po, partner_id: 'p-im-hyd2' })).data;
  assert.equal(d2.partner.status, 'matched'); assert.equal(d2.partner.via, 'picked'); assert.equal(d2.partner.partner.id, 'p-im-hyd2');
  // A partner from ANOTHER channel cannot be picked.
  const bad = await api.previewSalesOrderImport({ ...po, partner_id: 'p-zep-mum' });
  assert.equal(bad.status, 422);
});

test('shared GSTIN narrowed by PIN / address: Instamart MUM FC22, Flipkart Anekal; identical twins stay ambiguous', () => {
  const { resolveImportPartner } = load(fakeDb());
  const im = PARTNERS.filter(p => p.channel_key === 'INSTAMART');
  const fk = PARTNERS.filter(p => p.channel_key === 'FLIPKART_MGD');
  const mum = resolveImportPartner(im, { ship_to_gstin: '27AAVCS1691R1Z5', ship_to_pincode: '421302', ship_to_address: 'MUM FC22, Survey No.26,27,28 … Mumbai, Maharashtra, 421302' });
  assert.equal(mum.partner.id, 'p-im-mum'); assert.equal(mum.via, 'gstin+pincode');
  const anekal = resolveImportPartner(fk, { ship_to_gstin: '29AABCF8078M1ZX', ship_to_pincode: '562106', ship_to_address: 'Survey No 518,519 … Madiwala Village Marasurgram panchayat Anekal taluk Bangalore Urban Karnataka 562106' });
  assert.equal(anekal.partner.id, 'p-fk-anekal');
  // Address only (no PIN on the PO): "Anekal" is rare across the pool, "taluk"/"bangalore" are not decisive.
  const byWords = resolveImportPartner(fk, { ship_to_gstin: '29AABCF8078M1ZX', ship_to_address: 'Madiwala Village Marasurgram panchayat Anekal taluk Bangalore Urban Karnataka' });
  assert.equal(byWords.partner.id, 'p-fk-anekal'); assert.equal(byWords.via, 'gstin+address');
  const twins = resolveImportPartner(fk, { ship_to_gstin: '29AABCF8078M1ZX', ship_to_pincode: '562122', ship_to_address: 'Taverekere Venkatapura, Hosakote Taluk, Bengaluru 562122' });
  assert.equal(twins.status, 'ambiguous');
  assert.deepEqual(twins.candidates.filter(c => c.pin_match).map(c => c.id).sort(), ['p-fk-143', 'p-fk-144', 'p-fk-145', 'p-fk-223']);
  assert.ok(twins.candidates[0].pin_match);
  // A GSTIN nobody carries is never matched on address alone.
  const koc = resolveImportPartner(im, { ship_to_gstin: '32AAVCS1691R1ZE', ship_to_pincode: '683503', ship_to_address: 'Koc IM1 … Kochi, Kerala, 683503' });
  assert.equal(koc.status, 'none'); assert.match(koc.reason, /32AAVCS1691R1ZE/); assert.equal(koc.candidates.length, im.length);
});

// One channel PO split across two SOs is normal (10+ Flipkart refs carry two confirmed SOs), so a
// repeat is a WARNING the user confirms — never a refusal at preview. Scope = EVERY partner on the
// channel (an FC mis-picked last time is still the same PO), and the warning names the partner.
test('duplicate PO ref: preview WARNS via duplicate_of across every partner on the channel, naming it; cancelled SOs do not count', async () => {
  const orders = [
    { id: 'o1', order_no: 'SO-0901', status: 'confirmed', partner_id: 'p-zep-mum', partner_po_ref: 'p6150806' },
    { id: 'o2', order_no: 'SO-0902', status: 'cancelled', partner_id: 'p-zep-mum', partner_po_ref: 'P6150806' },
    { id: 'o3', order_no: 'SO-0903', status: 'draft', partner_id: 'p-zep-blr', partner_po_ref: 'P6150806' },     // same channel, other FC
    { id: 'o4', order_no: 'SO-0904', status: 'draft', partner_id: 'p-im-mum', partner_po_ref: 'P6150806' },      // other channel
  ];
  const r = await load(fakeDb({ orders })).previewSalesOrderImport(ZEPTO_PO);
  assert.equal(r.error, undefined, 'not refused');
  assert.equal(r.data.partner.partner.id, 'p-zep-mum');
  assert.deepEqual(r.data.duplicate_of.sort(), ['SO-0901', 'SO-0903']);
  const o3 = r.data.duplicate_orders.find(o => o.order_no === 'SO-0903');
  assert.match(o3.partner_name, /BLR-SS-MH-SUMADHURA/, 'the other partner is named');
  assert.equal(r.data.lines.length, 2, 'the pre-fill still comes back');
  const clean = await load(fakeDb({ orders: [orders[1], orders[3]] })).previewSalesOrderImport(ZEPTO_PO);
  assert.deepEqual(clean.data.duplicate_of, [], 'cancelled / other-channel orders are not duplicates');
});

test('save-time duplicate check: channel-wide, refused without confirm_duplicate_po_ref, created with it; manual orders never checked', async () => {
  const orders = [{ id: 'o1', order_no: 'SO-0901', status: 'confirmed', partner_id: 'p-zep-mum', partner_po_ref: 'P6150806' }];
  const db = fakeDb({ orders });
  const { importDuplicateRefusal } = load(db);
  const base = { from_import: true, partner_id: 'p-zep-mum', partner_po_ref: 'P6150806' };
  const no = await importDuplicateRefusal(base, 'ZEPTO');
  assert.equal(no.status, 409);
  assert.match(no.error, /P6150806 is already on SO-0901 \(confirmed, ZEPTO LIMITED.*MUM175M\)\)\. Tick "import it again as a separate order"/);
  assert.equal(await importDuplicateRefusal({ ...base, confirm_duplicate_po_ref: true }, 'ZEPTO'), null, 'confirmed → proceeds');
  assert.notEqual(await importDuplicateRefusal({ ...base, confirm_duplicate_po_ref: 'true' }, 'ZEPTO'), null, 'only a literal true confirms');
  assert.equal(await importDuplicateRefusal({ ...base, partner_po_ref: 'P999' }, 'ZEPTO'), null, 'no duplicate → proceeds');
  const other = await importDuplicateRefusal({ ...base, partner_id: 'p-zep-blr' }, 'ZEPTO');
  assert.equal(other?.status, 409, 'another partner on the SAME channel → still a duplicate');
  assert.match(other.error, /MUM175M/);
  assert.equal(await importDuplicateRefusal({ ...base, partner_id: 'p-im-mum' }, 'INSTAMART'), null, 'other channel → proceeds');
  const reads = db.calls.length;
  assert.equal(await importDuplicateRefusal({ partner_id: 'p-zep-mum', partner_po_ref: 'P6150806' }, 'ZEPTO'), null, 'hand-entered order → not checked');
  assert.equal(db.calls.length, reads, 'and no read made');
});

test('duplicate PO ref with an unresolved partner: listed for the picker and in duplicate_of', async () => {
  const orders = [{ id: 'o1', order_no: 'SO-0950', status: 'draft', partner_id: 'p-im-hyd1', partner_po_ref: 'HYDPO1' }];
  const po = { channel_key: 'INSTAMART', po_no: 'HYDPO1', ship_to_gstin: '36AAVCS1691R2Z5', lines: [{ channel_code: 'x', qty: 1, unit_cost_ex_gst: 1 }], po_total_taxable: 1 };
  const api = load(fakeDb({ orders }));
  const d = (await api.previewSalesOrderImport(po)).data;
  assert.equal(d.partner.status, 'ambiguous');
  assert.deepEqual(d.existing_orders.map(o => o.order_no), ['SO-0950']);
  assert.deepEqual(d.duplicate_of, ['SO-0950']);
  assert.deepEqual((await api.previewSalesOrderImport({ ...po, partner_id: 'p-im-hyd2' })).data.duplicate_of, ['SO-0950'], 'picking a sibling FC does not hide it');
});

test('checksum: within ₹1 is clean, more is a plain-words warning, a missing PO total says so', () => {
  const { importChecksum } = load(fakeDb());
  const lines = [{ qty: 36, rate: 1135.1 }];                 // 40,863.60 vs the PO's 40,863.58
  assert.equal(importChecksum(lines, 40863.58).ok, true);
  const off = importChecksum(lines, 41863.58);
  assert.equal(off.ok, false); assert.equal(off.diff, -999.98);
  assert.match(off.message, /add up to ₹40,863\.60 before GST but the PO says ₹41,863\.58 — ₹999\.98 short/);
  const none = importChecksum(lines, null);
  assert.equal(none.ok, false); assert.match(none.message, /could not be read/);
  assert.equal(importChecksum(lines, '40863.58').ok, true, 'a string total (PostgREST-style) is coerced');
});

test('refuses unsupported channels and empty / oversized POs', async () => {
  const api = load(fakeDb());
  assert.equal((await api.previewSalesOrderImport({ ...ZEPTO_PO, channel_key: 'PEEKO' })).status, 422);
  assert.equal((await api.previewSalesOrderImport({ ...ZEPTO_PO, lines: [] })).status, 422);
  assert.equal((await api.previewSalesOrderImport({ ...ZEPTO_PO, lines: Array(201).fill(ZEPTO_PO.lines[0]) })).status, 422);
});

test('learn mappings: insert-if-absent — new code learned as so_import by the user, an existing mapping is never overwritten', async () => {
  const db = fakeDb({ skuMap: [{ channel_id: CH.INSTAMART, channel_sku: '140019', product_code: 'GHUW', match_on: 'seed', created_by: null }] });
  const { learnSkuMappings } = load(db);
  const r = await learnSkuMappings([
    { channel_key: 'INSTAMART', channel_sku: '777001', product: 'Fang', model: 'Base', color: 'Excavator' },   // new, triple form
    { channel_key: 'INSTAMART', channel_sku: '140019', product_code: 'SHAK' },                                // exists → kept
    { channel_key: 'INSTAMART', channel_sku: '777004', product_code: 'GHUK' },                                // new, code form
    { channel_key: 'INSTAMART', channel_sku: '777002', product: 'Ghost', model: 'Nope', color: 'White' },      // resolves to nothing
    { channel_key: 'INSTAMART', channel_sku: '777003', product_code: 'ZZZZ' },                                // unknown code
  ], 'user-uuid-1', 'INSTAMART');
  assert.deepEqual(r.learned, [{ channel_sku: '777001', product_code: 'FABX' }, { channel_sku: '777004', product_code: 'GHUK' }]);
  const seed = db.store.sku_map.find(x => x.channel_sku === '140019');
  assert.equal(seed.product_code, 'GHUW', 'existing mapping untouched');
  assert.equal(seed.match_on, 'seed');
  const learned = db.store.sku_map.find(x => x.channel_sku === '777001');
  assert.deepEqual([learned.channel_id, learned.match_on, learned.created_by], [CH.INSTAMART, 'so_import', 'user-uuid-1']);
  assert.deepEqual(r.skipped.map(s => [s.channel_sku, s.reason]).sort(), [
    ['140019', 'already mapped — kept the existing mapping'], ['777002', 'no product matches'], ['777003', 'unknown, inactive or remote product_code'],
  ]);
  assert.equal(db.calls.filter(c => c[0] === 'sales' && c[2] === 'POST').length, 1, 'one batched upsert');
  // A learned code now matches on the next preview.
  const d = (await load(db).previewSalesOrderImport({ channel_key: 'INSTAMART', po_no: 'X1', ship_to_gstin: '27AAVCS1691R1Z5', ship_to_pincode: '421302',
    lines: [{ channel_code: '777001', qty: 1, unit_cost_ex_gst: 10 }], po_total_taxable: 10 })).data;
  assert.equal(d.lines[0].matched_by, 'sku_map'); assert.equal(d.lines[0].product_code, 'FABX');
});

test('learn mappings are bound to the order: wrong channel, GT, inactive / remote product codes are dropped', async () => {
  const db = fakeDb();
  const { learnSkuMappings } = load(db);
  const r = await learnSkuMappings([
    { channel_key: 'FLIPKART_MGD', channel_sku: 'RCTHNEWFSN000001', product_code: 'GHUK' },   // a Flipkart code on an INSTAMART order
    { channel_key: 'INSTAMART', channel_sku: '888001', product_code: 'OLDX' },                // inactive
    { channel_key: 'INSTAMART', channel_sku: '888002', product_code: 'GHRM' },                // remote
  ], 'u1', 'INSTAMART');
  assert.deepEqual(r.learned, []);
  assert.deepEqual(r.skipped.map(s => [s.channel_sku, s.reason]).sort(), [
    ['888001', 'unknown, inactive or remote product_code'], ['888002', 'unknown, inactive or remote product_code'],
    ['RCTHNEWFSN000001', "not this order's channel (INSTAMART)"],
  ]);
  const gt = await learnSkuMappings([{ channel_key: 'GT', channel_sku: 'GT-1', product_code: 'GHUK' }], 'u1', 'GT');
  assert.deepEqual(gt.learned, []); assert.match(gt.skipped[0].reason, /not this order's channel/);
  assert.equal(db.calls.filter(c => c[2] === 'POST').length, 0, 'nothing written');
  assert.deepEqual(db.store.sku_map, []);
});

test('learnFromImportOrder: a non-import create with learn_mappings writes nothing; an import learns on its partner channel', async () => {
  const db = fakeDb();
  const { learnFromImportOrder } = load(db);
  const maps = [{ channel_key: 'INSTAMART', channel_sku: '999001', product_code: 'GHUK' }];
  assert.equal(await learnFromImportOrder({ learn_mappings: maps }, { channel_key: 'INSTAMART' }, 'u1'), null);
  assert.equal(db.calls.length, 0, 'not even a read');
  // The order's own channel dropdown cannot widen it — the PARTNER's channel binds.
  const viaDropdown = await learnFromImportOrder({ from_import: true, channel_key: 'INSTAMART', learn_mappings: maps }, { channel_key: 'ZEPTO' }, 'u1');
  assert.deepEqual(viaDropdown.learned, []);
  const ok = await learnFromImportOrder({ from_import: true, learn_mappings: maps }, { channel_key: 'INSTAMART' }, 'u1');
  assert.deepEqual(ok.learned, [{ channel_sku: '999001', product_code: 'GHUK' }]);
});

test('createSalesOrder wiring: save-time duplicate check on the import path, learn after the order exists', () => {
  const i = src.indexOf("case 'createSalesOrder': {");
  const body = src.slice(i, src.indexOf("case 'updateSalesOrder': {", i));
  const guard = body.indexOf('const dupRefusal = await importDuplicateRefusal(d, partner.channel_key);');
  assert.ok(guard > 0 && guard < body.indexOf("nextSeq4('sales_order'"), 'check runs before an SO- number is burned');
  assert.match(body, /if \(dupRefusal\) return err\(dupRefusal\.error, dupRefusal\.status\);/);
  const learn = body.indexOf('learnFromImportOrder(d, partner, userId)');
  assert.ok(learn > body.indexOf("insert('sales_order_lines'"), 'mappings are learned only after the order + lines are written');
  assert.doesNotMatch(body, /learnSkuMappings\(/, 'no direct, unbound learn call left in the route');
  const p = src.indexOf("case 'previewSalesOrderImport': {");
  assert.match(src.slice(p, p + 300), /if \(!canSalesManage\(P\)\) return err\('No permission', 403\);/);
});

// ── resolver: real Scootsy Karnataka / Hyderabad shapes ──
test('resolver: a PO PIN no candidate shares → picker, never an address-word guess', () => {
  const { resolveImportPartner } = load(fakeDb());
  const im = PARTNERS.filter(p => p.channel_key === 'INSTAMART');
  const r = resolveImportPartner(im, { ship_to_gstin: '36AAVCS1691R2Z5', ship_to_pincode: '500100',
    ship_to_address: 'HYD IM2, Sy no. 518, 527, Kistapur Village, opp RDC Concrets, Medchal, Hyderabad, Telangana, 500100' });
  assert.equal(r.status, 'ambiguous'); assert.match(r.reason, /PIN 500100/);
});

test('resolver: only a token ONE candidate holds decides; generic place words cannot', () => {
  const { resolveImportPartner } = load(fakeDb());
  const im = PARTNERS.filter(p => p.channel_key === 'INSTAMART');
  const fk = PARTNERS.filter(p => p.channel_key === 'FLIPKART_MGD');
  // Three BLR FCs share 562114; "im1" / "anugondanahalli" are held by IM1 alone → IM1.
  const im1 = resolveImportPartner(im, { ship_to_gstin: '29AAVCS1691R1Z1', ship_to_pincode: '562114',
    ship_to_address: 'BLR IM1, Survey no 95/2 and 4/1, Anugondanahalli village, Hoskote taluk, Bangalore rural, Bangalore, Karnataka, 562114' });
  assert.equal(im1.status, 'matched'); assert.equal(im1.partner.id, 'p-im-blr1'); assert.equal(im1.via, 'gstin+pincode+address');
  // Only generic words that happen to be on IM4's address alone ("ground", "floor", "warehouse", "rural") → picker.
  const generic = resolveImportPartner(im, { ship_to_gstin: '29AAVCS1691R1Z1', ship_to_pincode: '562114',
    ship_to_address: 'Ground floor, warehouse, Bengaluru Rural, Karnataka, 562114' });
  assert.equal(generic.status, 'ambiguous');
  // Taverekere 562122: four candidates share the PIN and every address word → picker.
  const tav = resolveImportPartner(fk, { ship_to_gstin: '29AABCF8078M1ZX', ship_to_pincode: '562122',
    ship_to_address: 'Sy no 18/2, 18/3 situated as Taverekere Venkatapura, Hosakote Taluk, Nadagudi Hobli, Bengaluru 562122' });
  assert.equal(tav.status, 'ambiguous');
  assert.deepEqual(tav.candidates.filter(c => c.pin_match).map(c => c.id).sort(), ['p-fk-143', 'p-fk-144', 'p-fk-145', 'p-fk-223']);
  // …unless a df===1 token decides. Hyderabad 501510 (CMQPO + hyd im5 share it): "Mangalapally" is SP-0252's alone.
  const hyd5 = resolveImportPartner(im, { ship_to_gstin: '36AAVCS1691R2Z5', ship_to_pincode: '501510',
    ship_to_address: 'Survey Nos. 143E/A1, 143E/A2, Mangalapally Village, Ibrahimpatnam, Telangana, 501510' });
  assert.equal(hyd5.status, 'matched'); assert.equal(hyd5.partner.id, 'p-im-hyd5');
});

// ── matcher: code vs barcode, blank prices ──
test('code and barcode pointing at different products → unmatched with a note, not learned', async () => {
  // sku_map says the UUID is SHAK, but the printed EAN is SHTK's.
  const db = fakeDb({ skuMap: [{ channel_id: CH.ZEPTO, channel_sku: '05285852-99e0-4b15-8ce1-d8dc026e4bf4', product_code: 'SHAK' }] });
  const po = { ...ZEPTO_PO, lines: [{ ...ZEPTO_PO.lines[0], ean: '5949998500299' }] };
  const l = (await load(db).previewSalesOrderImport(po)).data.lines[0];
  assert.equal(l.matched, false); assert.equal(l.product, null);
  assert.match(l.note, /code and barcode point to different products/);
  assert.equal(l.code_mapped, true, 'the code already has a mapping → the page will not learn over it');
});

test('a blank PO price is null, never ₹0', async () => {
  const db = fakeDb();
  const po = { ...ZEPTO_PO, lines: [{ ...ZEPTO_PO.lines[0], unit_cost_ex_gst: null }, { ...ZEPTO_PO.lines[1], unit_cost_ex_gst: '' }] };
  const d = (await load(db).previewSalesOrderImport(po)).data;
  assert.deepEqual(d.lines.map(l => [l.rate, l.unit_cost_ex_gst]), [[null, null], [null, null]]);
  assert.equal(d.checksum.so_taxable, 0);
  assert.equal(d.checksum.ok, false);
});
