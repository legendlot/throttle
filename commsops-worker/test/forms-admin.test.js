// Forms admin reads (Relay /forms, 2026-09-11) — the pure helpers behind listForms /
// getFormSubmissions, plus one stubbed-fetch pass over getFormSubmissions that pins the two
// properties most likely to regress quietly:
//   1. enrichment is BATCHED — the number of DB calls does not grow with the page (no per-row await);
//   2. a count comes out of Content-Range, never the returned array's length.
const test = require('node:test');
const assert = require('assert');
const F = require('../src/forms-admin.js');

const NOW = Date.parse('2026-09-11T06:30:00Z');   // 12:00 IST

test('istDay: an instant before 05:30 IST lands on the IST date, not the UTC one', () => {
  // 2026-09-10T20:00Z = 11 Sep 01:30 IST.
  assert.equal(F.istDay('2026-09-10T20:00:00Z'), '2026-09-11');
  assert.equal(F.istDay('2026-09-10T18:29:00Z'), '2026-09-10');
  assert.equal(F.istDay('not a date'), null);
});

test('lastIstDays: 30 days, oldest first, ending on today (IST)', () => {
  const d = F.lastIstDays(NOW, 30);
  assert.equal(d.length, 30);
  assert.equal(d[29], '2026-09-11');
  assert.equal(d[0], '2026-08-13');
});

test('contactKey: profile first, then the typed address, normalised', () => {
  assert.equal(F.contactKey({ id: 's1', profile_id: 'p1', payload: { email: 'A@x.com' } }), 'p:p1');
  assert.equal(F.contactKey({ id: 's1', payload: { email: ' A@X.com ' } }), 'e:a@x.com');
  assert.equal(F.contactKey({ id: 's1', payload: { phone: '+91 77099-91011' } }), 't:917709991011');
  assert.equal(F.contactKey({ id: 's1', payload: {} }), 's:s1');
});

test('subChannels: stored column wins; NULL (pre-0060) falls back to field presence', () => {
  assert.deepEqual(F.subChannels({ channels: ['email', 'email', 'sms'], payload: { phone: '1' } }), ['email']);
  assert.deepEqual(F.subChannels({ channels: null, payload: { email: 'a@x', phone: '1' } }), ['email', 'whatsapp']);
  assert.deepEqual(F.subChannels({ channels: [], payload: {} }), []);
});

test('subSku: variant_sku only — a legacy product_code (a Shopify variant id) is not a SKU', () => {
  assert.equal(F.subSku({ payload: { variant_sku: 'shadow-tarmac-black' } }), 'shadow-tarmac-black');
  assert.equal(F.subSku({ payload: { product_code: '47351925669940' } }), null);
  assert.equal(F.subSku({ payload: { variant_sku: '  ' } }), null);
});

test('alertStatus: waiting / queued / retrying / stuck / alerted', () => {
  assert.equal(F.alertStatus(null), 'waiting');
  assert.equal(F.alertStatus({ attempts: '0' }), 'queued');
  assert.equal(F.alertStatus({ attempts: '2', last_error: 'x' }), 'retrying');
  assert.equal(F.alertStatus({ attempts: '5', last_error: 'x' }), 'stuck');   // numeric-as-string
  assert.equal(F.alertStatus({ attempts: '5', event_emitted_at: '2026-09-10T00:00:00Z' }), 'alerted');
});

test('inList: quoted and encoded, so a + or comma cannot corrupt the filter', () => {
  assert.equal(F.inList(['a+b@x.com', 'c,d']), '("a%2Bb%40x.com","c%2Cd")');
  // a trailing backslash cannot escape the closing quote (S372 review)
  assert.equal(F.inList(['sku\\']), '("sku")');
});

test('chunk: splits at the size and keeps every value', () => {
  const c = F.chunk(Array.from({ length: 250 }, (_, i) => i), 100);
  assert.deepEqual(c.map((x) => x.length), [100, 100, 50]);
});

test('summarise: distinct contacts, per-day (IST), channels, top products, sampled flag', () => {
  const rows = [
    { id: '1', profile_id: 'p1', payload: { email: 'a@x', variant_sku: 'sku-a' }, channels: ['email'], submitted_at: '2026-09-11T01:00:00Z' },
    { id: '2', profile_id: 'p1', payload: { email: 'a@x', phone: '9', variant_sku: 'sku-b' }, channels: ['email', 'whatsapp'], submitted_at: '2026-09-10T20:00:00Z' },
    { id: '3', profile_id: null, payload: { email: 'b@x', variant_sku: 'sku-a' }, channels: null, submitted_at: '2026-09-09T09:30:00Z' },
    { id: '4', profile_id: null, payload: { email: 'c@x', product_code: '4735' }, channels: ['email'], submitted_at: '2026-07-01T00:00:00Z' },
  ];
  const s = F.summarise(rows, { now: NOW, total: 4, skuToCode: { 'sku-a': 'SHTK' } });
  assert.equal(s.distinct_contacts, 3);
  const day = (d) => s.per_day.find((x) => x.day === d).count;
  assert.equal(day('2026-09-11'), 2);   // both of p1's rows are 11 Sep IST
  assert.equal(day('2026-09-09'), 1);
  assert.equal(s.per_day.reduce((a, x) => a + x.count, 0), 3);   // the July row is outside 30 days
  assert.deepEqual(s.channels, { email: 4, whatsapp: 1 });
  assert.deepEqual(s.top_products[0], { sku: 'sku-a', product_code: 'SHTK', count: 2 });
  assert.equal(s.no_sku, 1);
  assert.equal(s.sampled, false);
  assert.equal(F.summarise(rows, { now: NOW, total: 9000 }).sampled, true);
  assert.equal(F.summarise(rows, { now: NOW, total: null }).sampled, false);
  // total unreadable but the capped read came back full → still flagged as sampled (S372 review)
  assert.equal(F.summarise(Array.from({ length: F.SUMMARY_CAP }, () => rows[0]), { now: NOW, total: null }).sampled, true);
});

test('pickContact: what the customer typed wins; profile identifiers are the fallback', () => {
  const idents = [{ type: 'email', value: 'newest@x' }, { type: 'phone', value: '777' }];
  assert.deepEqual(F.pickContact({ payload: { email: 'typed@x' } }, { display_name: 'Asha' }, idents),
    { name: 'Asha', email: 'typed@x', phone: '777' });
  assert.deepEqual(F.pickContact({ payload: {} }, null, []), { name: null, email: null, phone: null });
});

// ── stubbed-fetch pass over getFormSubmissions ────────────────────────────────────────────
const FORM_ID = 'eb12aa70-43e8-4e47-b291-22b28a5e69e7';
const env = { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' };

function stubFetch(nRows) {
  const calls = [];
  const subs = Array.from({ length: nRows }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    profile_id: i % 2 ? `p${i}` : null,
    payload: { email: `u${i}@x.com`, variant_sku: 'shadow-tarmac-black' },
    channels: ['email'], submitted_at: '2026-09-10T10:00:00Z',
  }));
  global.fetch = async (u, opts) => {
    const url = decodeURIComponent(String(u));
    calls.push({ url, method: opts.method || 'GET', profile: opts.headers['Accept-Profile'] });
    let body = [], range = '0-0/*';
    if (url.includes('/forms?')) body = [{ id: FORM_ID, slug: 'back-in-stock', name: 'Back in stock' }];
    else if (url.includes('/form_submissions?') && opts.method === 'HEAD') range = '*/7';
    else if (url.includes('/form_submissions?')) { body = subs; range = `0-${nRows - 1}/12345`; }
    else if (url.includes('/profiles?')) body = [{ id: 'p1', display_name: 'Asha' }];
    else if (url.includes('/restock_notifications?') && opts.method === 'HEAD') range = '*/0';
    else if (url.includes('/restock_notifications?')) body = [{ submission_id: subs[0].id, event_emitted_at: null, attempts: '1', last_error: null }];
    else if (url.includes('/sku_map?')) body = [{ channel_sku: 'shadow-tarmac-black', product_code: 'SHTK' }];
    return { ok: true, status: 200, text: async () => (opts.method === 'HEAD' ? '' : JSON.stringify(body)),
      headers: { get: (k) => (k.toLowerCase() === 'content-range' ? range : null) } };
  };
  return calls;
}

test('getFormSubmissions: DB calls do not grow with the page (batched, never per row)', async () => {
  const small = stubFetch(4);
  await F.getFormSubmissions(env, { formId: FORM_ID, limit: 4, offset: 0, now: NOW });
  const smallN = small.length;
  const big = stubFetch(90);
  await F.getFormSubmissions(env, { formId: FORM_ID, limit: 90, offset: 0, now: NOW });
  assert.equal(big.length, smallN, `4 rows → ${smallN} calls, 90 rows → ${big.length} calls`);
});

test('getFormSubmissions: total from Content-Range, enrichment joined, sku_map read from sales', async () => {
  const calls = stubFetch(3);
  const r = await F.getFormSubmissions(env, { formId: FORM_ID, limit: 3, offset: 0, now: NOW });
  assert.equal(r.total, 12345);            // the header, not rows.length (3)
  assert.equal(r.summary.last_7_days, 7);
  assert.equal(r.summary.alerted, 0);
  assert.equal(r.summary.sampled, true);   // 3 rows seen of 12,345
  assert.equal(r.rows[0].alert.status, 'queued');
  assert.equal(r.rows[1].alert.status, 'waiting');
  assert.equal(r.rows[1].name, 'Asha');
  assert.equal(r.rows[0].product_code, 'SHTK');
  const page = calls.find((c) => c.url.includes('/form_submissions?') && c.url.includes('offset=0'));
  assert.match(page.url, /order=submitted_at\.desc,id\.desc/);
  assert.equal(calls.find((c) => c.url.includes('/sku_map?')).profile, 'sales');
});

test('getFormSubmissions: summary only on the first page; bad ids refused before the DB', async () => {
  stubFetch(3);
  const r = await F.getFormSubmissions(env, { formId: FORM_ID, limit: 3, offset: 3, now: NOW });
  assert.equal(r.summary, null);
  assert.deepEqual(await F.getFormSubmissions(env, { formId: '' }), { error: 'form_id_required', status: 400 });
  assert.deepEqual(await F.getFormSubmissions(env, { formId: 'abc' }), { error: 'form_id_invalid', status: 400 });
});

test('listForms: per-form counts from count headers, alerted only for back-in-stock', async () => {
  stubFetch(2);
  const r = await F.listForms(env, { now: NOW });
  assert.equal(r.forms.length, 1);
  const c = r.forms[0].counts;
  assert.equal(c.total, 12345);
  assert.equal(c.last_30_days, 7);
  assert.equal(c.alerted, 0);
  assert.equal(c.distinct_contacts_sampled, true);
});
