// Instant-load helpers for the Odo dashboard ((auth)/page.js) — src/lib/dashboard.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOT_KEY, VARIANTS_KEY, channelArg, selectionKeys, slimBootstrap, slimVariants, packSales, unpackSales,
  slimSeg, slimAccessories, forSel, need, freshFor, exportGate, istStamp, pageFreshness, shouldRefreshOnReturn,
  EmptyReadError, EXPORT_WAIT, EXPORT_FAILED, panelAsOf, withTimeout, FETCH_TIMEOUT_MS,
} from '../src/lib/dashboard.mjs';
import { rangePresetsAt, rollPreset } from '../src/lib/ranges.mjs';

// useCachedQuery state shapes, as the page reads them.
const q = (o = {}) => ({ data: undefined, error: null, loading: false, refreshing: false, updatedAt: null, ...o });
const boom = new Error('Worker 502');
const NOV = { from: '2026-11-01', to: '2026-11-14', prior: { from: '2026-10-18', to: '2026-10-31' } };

test('keys: range change, channel change and channel order', () => {
  const a = selectionKeys({ ...NOV, sel: [] });
  assert.equal(a.sales, 'odo:dashboard:sales:2026-11-01:2026-11-14:all');
  assert.equal(a.salesPrev, 'odo:dashboard:sales:2026-10-18:2026-10-31:all');
  assert.equal(a.seg, 'odo:dashboard:segregation:2026-11-01:2026-11-14:all');
  assert.equal(a.segPrev, 'odo:dashboard:segregation:2026-10-18:2026-10-31:all');
  assert.equal(a.acc, 'odo:dashboard:accessories:2026-11-01:2026-11-14:all');
  assert.equal(a.ch, '');
  // Range change → every key changes (one day on the end is a different answer).
  const b = selectionKeys({ from: '2026-11-01', to: '2026-11-13', sel: [], prior: { from: '2026-10-19', to: '2026-10-31' } });
  for (const f of ['sales', 'salesPrev', 'seg', 'segPrev', 'acc']) assert.notEqual(a[f], b[f], f);
  // Channel change → every key changes.
  const c = selectionKeys({ ...NOV, sel: ['uuid-b'] });
  const d = selectionKeys({ ...NOV, sel: ['uuid-b', 'uuid-a'] });
  for (const f of ['sales', 'salesPrev', 'seg', 'segPrev', 'acc']) {
    assert.notEqual(a[f], c[f], f); assert.notEqual(c[f], d[f], f);
  }
  // Channel order (and a duplicate) does not: same set, same request, same key.
  const e = selectionKeys({ ...NOV, sel: ['uuid-a', 'uuid-b', 'uuid-a'] });
  assert.deepEqual(d, e);
  assert.equal(d.ch, 'uuid-a,uuid-b');
  assert.equal(channelArg([3, 1, 2]), '1,2,3');
  assert.equal(channelArg(undefined), '');
  // Data sources never share a key.
  assert.equal(new Set([a.sales, a.seg, a.acc, BOOT_KEY, VARIANTS_KEY]).size, 5);
});

test('a payload is only ever read under the key it was fetched for', () => {
  const k = selectionKeys({ ...NOV, sel: [] }).sales;
  const other = selectionKeys({ ...NOV, sel: ['x'] }).sales;
  const data = packSales(other, []);
  assert.equal(forSel(q({ data }), k), undefined);              // previous selection's numbers: refused
  assert.equal(forSel(q({ data }), other), data);
  assert.equal(forSel(q(), k), undefined);
});

test('sales pack/unpack is lossless for every field the page reads, incl. null vs absent', () => {
  const rows = [
    { sale_date: '2026-11-01', channel_id: 'c1', product_code: 'P1', grp_label: 'Gator · Green', units: '3', gross_value: '1200.50', discount_value: '0', tax_value: '183.13', returned_units: 0, returned_value: '0', extra: 'dropped' },
    { sale_date: '2026-11-01', channel_id: 'c2', product_code: 'P1', grp_label: null, units: 1, gross_value: 400, discount_value: null, tax_value: null, returned_units: 1, returned_value: '400' },
    { sale_date: '2026-11-02', channel_id: 'c1', product_code: 'P2', units: 2, gross_value: '', tax_value: '' },
  ];
  const p = packSales('k', rows);
  assert.equal(p.k, 'k');
  const back = unpackSales(JSON.parse(JSON.stringify(p)));      // through the cache's JSON
  const pick = ({ extra, ...r }) => r;
  assert.deepEqual(back[0], pick(rows[0]));
  assert.deepEqual(back[1], rows[1]);
  // Row 3: absent grp_label stays absent; absent numerics come back null (Number(null)||0 === Number(undefined)||0).
  assert.equal('grp_label' in back[2], false);
  assert.equal(back[2].tax_value, '');                         // '' is kept ('' is "absent" to hybridHeadline)
  assert.equal(back[2].discount_value, null);
  assert.deepEqual(unpackSales(undefined), []);
  // A month (~3,000 rows) fits the 300k cache cap packed.
  const month = Array.from({ length: 3000 }, (_, i) => ({ sale_date: `2026-10-${String(1 + (i % 31)).padStart(2, '0')}`, channel_id: `00000000-0000-0000-0000-0000000000${i % 15}`, product_code: `LOT-${i % 120}`, grp_label: `Product ${i % 120} · Colour`, units: '2', gross_value: '2598.00', discount_value: '120.00', tax_value: '396.31', returned_units: 0, returned_value: '0' }));
  assert.ok(JSON.stringify(packSales('k', month)).length < 300000);
});

test('slimmers keep what the page reads and drop the rest', () => {
  const b = slimBootstrap(BOOT_KEY, {
    channels: [{ id: 'c1', name: 'Amazon', type: 'ecom', extra: 1 }],
    connectors: [{ channel_id: 'c1', name: 'Amazon', enabled: true, last_ok_at: 't', last_error: null, cursor: 'x', last_run: { status: 'ok', log: 'big' } },
      { channel_id: 'c2', name: 'Site', enabled: false, last_run: null }],
    unmapped_count: 7, roles: [{ role_key: 'r' }], accessUsers: [{ full_name: 'A Person' }],
  });
  assert.deepEqual(b.channels, [{ channel_id: 'c1', name: 'Amazon', type: 'ecom' }]);
  assert.deepEqual(b.connectors[0], { channel_id: 'c1', name: 'Amazon', enabled: true, last_ok_at: 't', last_error: null, last_run: { status: 'ok' } });
  assert.equal(b.connectors[1].last_run, null);
  assert.equal(b.unmapped_count, 7);
  assert.equal(b.roles, undefined); assert.equal(b.accessUsers, undefined);
  assert.equal(slimBootstrap(BOOT_KEY, { channels: [{ id: 'c1' }] }).unmapped_count, 0);
  assert.deepEqual(slimVariants(VARIANTS_KEY, { rows: [{ product_code: 'P1' }] }), { k: VARIANTS_KEY, rows: [{ product_code: 'P1' }] });
  const s = slimSeg('k', { rows: [{ sale_date: 'd', channel_id: 'c', gross: '10', tax_ingest: '1', adapter_kind: 'shopify', junk: 1 }], channels: [{}] });
  assert.deepEqual(s, { k: 'k', rows: [{ sale_date: 'd', channel_id: 'c', gross: '10', tax_ingest: '1', adapter_kind: 'shopify' }] });
  assert.equal('tax' in s.rows[0], false);                      // absent stays absent
  const a = slimAccessories('k', { rows: [{ bucket: 'Spares' }, { bucket: 'Gift wrap' }, { bucket: 'Spares' }], total: { units: 3, gross: 900, skus: 2 } });
  assert.deepEqual(a, { k: 'k', buckets: ['Spares', 'Gift wrap'], total: { units: 3, gross: 900, skus: 2 } });
  assert.deepEqual(slimAccessories('k', {}).total, { units: 0, gross: 0, skus: 0 });
});

test('need(): a delta / share renders only when every input is in for THIS selection', () => {
  const K1 = selectionKeys({ ...NOV, sel: [] });
  const K2 = selectionKeys({ ...NOV, sel: ['c9'] });
  const cur = q({ data: packSales(K2.sales, []) });
  const prevOld = q({ data: packSales(K1.salesPrev, []) });    // prior period of the OLD selection
  const prevNew = q({ data: packSales(K2.salesPrev, []) });
  assert.equal(need([[cur, K2.sales], [prevOld, K2.salesPrev]]).state, 'loading');
  assert.equal(need([[cur, K2.sales], [prevNew, K2.salesPrev]]).state, 'ready');
  // Half a pair (current in, prior still loading) is not a figure.
  assert.equal(need([[cur, K2.sales], [q({ loading: true }), K2.salesPrev]]).state, 'loading');
  // A failure with nothing for this key is an error, with only the failed input to retry.
  const failed = q({ error: boom });
  const g = need([[cur, K2.sales], [failed, K2.salesPrev]]);
  assert.equal(g.state, 'error');
  assert.equal(g.retry.length, 1); assert.equal(g.retry[0][0], failed); assert.equal(g.retry[0][1], K2.salesPrev);
  // Error outranks loading; a retry in flight (error cleared by the hook) is loading again.
  assert.equal(need([[q({ loading: true }), 'a'], [failed, 'b']]).state, 'error');
  assert.equal(need([[q({ loading: true }), 'a']]).state, 'loading');
  // Stale data kept through a failed refresh still renders (the freshness line warns).
  assert.equal(need([[q({ data: { k: 'a' }, error: boom }), 'a']]).state, 'ready');
  assert.equal(need([]).state, 'ready');
});

test('export: only on a fresh, complete result for this selection', () => {
  const k = 'odo:dashboard:sales:a:b:all';
  const started = 1000;
  const fresh = q({ data: packSales(k, [{}]), updatedAt: 2000 });
  const base = { salesQ: fresh, salesKey: k, salesStartedAt: started, rowCount: 5, filterActive: false, variantsQ: q(), variantsStartedAt: null };
  assert.equal(exportGate(base).ok, true);
  assert.equal(exportGate({ ...base, salesQ: q({ data: packSales(k, []), updatedAt: 900 }) }).ok, false);   // cache seed, older than the ask
  assert.equal(exportGate({ ...base, salesQ: { ...fresh, refreshing: true } }).ok, false);                  // refresh in flight
  assert.deepEqual(exportGate({ ...base, salesQ: { ...fresh, error: boom } }), { ok: false, why: EXPORT_FAILED });   // failed refresh: say so
  assert.deepEqual(exportGate({ ...base, salesQ: q({ error: boom }) }), { ok: false, why: EXPORT_FAILED });
  assert.deepEqual(exportGate({ ...base, salesQ: q({ loading: true }) }), { ok: false, why: EXPORT_WAIT });
  assert.equal(exportGate({ ...base, salesKey: 'odo:dashboard:sales:a:c:all' }).ok, false);                 // other selection's data
  assert.equal(exportGate({ ...base, salesStartedAt: undefined }).ok, false);                              // never asked this page
  assert.equal(exportGate({ ...base, rowCount: 0 }).ok, false);                                             // nothing to export (as before)
  // With a product/category filter, the variants behind it must be fresh too.
  assert.equal(exportGate({ ...base, filterActive: true }).ok, false);
  const v = q({ data: slimVariants(VARIANTS_KEY, { rows: [{ product_code: 'P1' }] }), updatedAt: 3000 });
  assert.equal(exportGate({ ...base, filterActive: true, variantsQ: { ...v, error: boom }, variantsStartedAt: 2500 }).why, EXPORT_FAILED);
  assert.equal(exportGate({ ...base, filterActive: true, variantsQ: v, variantsStartedAt: 2500 }).ok, true);
  assert.equal(exportGate({ ...base, filterActive: true, variantsQ: v, variantsStartedAt: 3500 }).ok, false);
  assert.equal(freshFor(q(), k, 0), false);
});

test('IST stamp: time today, date + time otherwise', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');                    // 15:30 IST
  assert.equal(istStamp(Date.parse('2026-11-13T09:04:00Z'), now), '14:34');
  assert.equal(istStamp(Date.parse('2026-11-12T15:34:00Z'), now), '12 Nov 21:04');
  assert.equal(istStamp(Date.parse('2026-11-12T23:00:00Z'), now), '04:30');
});

test('page freshness: when the PAGE fetched — "Loaded", never "As of"', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const t1 = Date.parse('2026-11-13T09:30:00Z');                     // 15:00 IST
  const t2 = Date.parse('2026-11-13T09:45:00Z');                     // 15:15 IST
  const old = Date.parse('2026-11-12T15:34:00Z');                    // 12 Nov 21:04 IST
  const d = (k) => ({ k });
  assert.deepEqual(pageFreshness([[q(), 'a']], now), { text: '', warn: false });
  assert.equal(pageFreshness([[q({ loading: true }), 'a']], now).text, 'Updating…');
  assert.equal(pageFreshness([[q({ data: d('a'), updatedAt: t1, refreshing: true }), 'a'], [q({ data: d('b'), updatedAt: t2 }), 'b']], now).text, 'Updating… (showing 15:00)');
  assert.deepEqual(pageFreshness([[q({ data: d('a'), updatedAt: t2 }), 'a']], now), { text: 'Loaded 15:15', warn: false });
  assert.equal(pageFreshness([[q({ data: d('a'), updatedAt: old }), 'a']], now).text, 'Loaded 12 Nov 21:04');
  assert.deepEqual(pageFreshness([[q({ data: d('a'), updatedAt: t2, error: boom }), 'a']], now), { text: "Couldn't refresh — showing 15:15", warn: true });
  assert.deepEqual(pageFreshness([[q({ error: boom }), 'a']], now), { text: "Couldn't refresh", warn: true });
  // Another selection's data contributes no stamp.
  assert.equal(pageFreshness([[q({ data: d('old'), updatedAt: t1 }), 'a'], [q({ data: d('b'), updatedAt: t2 }), 'b']], now).text, 'Loaded 15:15');
});

test('refresh on return: once, only after more than 5 minutes hidden', () => {
  const t = 1_000_000;
  assert.equal(shouldRefreshOnReturn(null, t), false);
  assert.equal(shouldRefreshOnReturn(t - 5 * 60 * 1000, t), false);
  assert.equal(shouldRefreshOnReturn(t - 5 * 60 * 1000 - 1, t), true);
  assert.equal(shouldRefreshOnReturn(t - 60 * 1000, t), false);
});

test('a worker false-empty (DB failure answered as []) is a failure, never cached as "nothing"', () => {
  assert.throws(() => slimVariants(VARIANTS_KEY, { rows: [] }), EmptyReadError);
  assert.throws(() => slimVariants(VARIANTS_KEY, null), EmptyReadError);
  assert.throws(() => slimBootstrap(BOOT_KEY, { channels: [], connectors: [], unmapped_count: 0 }), EmptyReadError);
  assert.throws(() => slimBootstrap(BOOT_KEY, null), EmptyReadError);
  // Selection reads CAN be legitimately empty (a quiet day, one channel) — those never throw.
  assert.deepEqual(packSales('k', []).rows, []);
  assert.deepEqual(slimSeg('k', { rows: [] }).rows, []);
});

test('bootstrap / variants stamp their own section, not the header', () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const t = Date.parse('2026-11-13T09:30:00Z');                      // 15:00 IST
  assert.equal(panelAsOf(q(), BOOT_KEY, now), null);
  assert.equal(panelAsOf(q({ error: boom }), BOOT_KEY, now), null);
  assert.deepEqual(panelAsOf(q({ data: { k: BOOT_KEY }, updatedAt: t }), BOOT_KEY, now), { text: 'as of 15:00', warn: false });
  assert.deepEqual(panelAsOf(q({ data: { k: BOOT_KEY }, updatedAt: t, error: boom }), BOOT_KEY, now), { text: "Couldn't refresh — as of 15:00", warn: true });
});

test('a request that never answers fails after the timeout (injected timer)', async () => {
  let fire = null, cleared = 0;
  const timers = { set: (fn, ms) => { assert.equal(ms, FETCH_TIMEOUT_MS); fire = fn; return 7; }, clear: (id) => { assert.equal(id, 7); cleared++; } };
  const hung = withTimeout(new Promise(() => {}), FETCH_TIMEOUT_MS, 'getSales', timers);
  fire();
  await assert.rejects(hung, /getSales did not answer within 90 s/);
  assert.equal(cleared, 1);
  // An answer in time wins, and its timer is cleared.
  const okT = { set: () => 8, clear: () => { cleared++; } };
  assert.equal(await withTimeout(Promise.resolve(42), FETCH_TIMEOUT_MS, 'x', okT), 42);
  assert.equal(cleared, 2);
  // A failure in time is passed through untouched.
  await assert.rejects(withTimeout(Promise.reject(boom), FETCH_TIMEOUT_MS, 'x', okT), boom);
  // Real timers, short timeout.
  await assert.rejects(withTimeout(new Promise(() => {}), 5, 'getBootstrap'), /getBootstrap did not answer/);
});

test('presets roll over IST midnight; custom ranges are left alone', () => {
  const before = Date.parse('2026-11-30T18:29:00Z');                 // 23:59 IST, 30 Nov
  const after = Date.parse('2026-11-30T18:31:00Z');                  // 00:01 IST, 1 Dec
  const P0 = rangePresetsAt(before), P1 = rangePresetsAt(after);
  const get = (P, k) => P.find(p => p.key === k);
  assert.deepEqual(get(P0, 'mtd'), { key: 'mtd', label: 'MTD', from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(get(P0, 'today'), { key: 'today', label: 'Today', from: '2026-11-30', to: '2026-11-30' });
  assert.deepEqual(get(P0, 'lm'), { key: 'lm', label: 'Last mo', from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(get(P0, '7d'), { key: '7d', label: '7D', from: '2026-11-24', to: '2026-11-30' });
  assert.deepEqual(get(P0, 'fy'), { key: 'fy', label: 'FY', from: '2026-04-01', to: '2026-11-30' });
  // The tab still holds the 30 Nov ranges after midnight → each preset rolls to its 1 Dec range.
  for (const k of ['today', '7d', '30d', '90d', 'mtd', 'lm', 'fy']) {
    const { from, to } = get(P0, k);
    assert.deepEqual(rollPreset(k, from, to, P1), { from: get(P1, k).from, to: get(P1, k).to }, k);
  }
  assert.deepEqual(rollPreset('mtd', '2026-11-01', '2026-11-30', P1), { from: '2026-12-01', to: '2026-12-01' });
  assert.deepEqual(rollPreset('lm', '2026-10-01', '2026-10-31', P1), { from: '2026-11-01', to: '2026-11-30' });
  // Same day → nothing moves; custom range ('' preset) → never touched; unknown preset → null.
  assert.equal(rollPreset('mtd', '2026-11-01', '2026-11-30', P0), null);
  assert.equal(rollPreset('', '2026-11-01', '2026-11-30', P1), null);
  assert.equal(rollPreset('nope', '2026-11-01', '2026-11-30', P1), null);
  // Year boundary: Jan → last month is December of the year before; FY stays in its April year.
  const jan = rangePresetsAt(Date.parse('2027-01-01T00:00:00Z'));    // 05:30 IST 1 Jan 2027
  assert.deepEqual(get(jan, 'lm'), { key: 'lm', label: 'Last mo', from: '2026-12-01', to: '2026-12-31' });
  assert.equal(get(jan, 'fy').from, '2026-04-01');
});

test('withTimeout default timers do not depend on `this` (browser setTimeout throws Illegal invocation otherwise)', async () => {
  // Simulate the browser: a setTimeout that refuses any receiver other than globalThis/undefined.
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return realSet(fn, ms); };
  globalThis.clearTimeout = function (id) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return realClear(id); };
  try {
    const { withTimeout } = await import('../src/lib/dashboard.mjs');
    assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'probe'), 'ok');
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }
});
