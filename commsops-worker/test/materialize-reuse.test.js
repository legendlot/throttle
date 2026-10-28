// reachableCount reuses a segment rebuild done moments ago against the same rule (2026-10-28).
// Pure decision; the fetch around it is one PostgREST read.
const assert = require('assert');
const { isFreshMaterialization, MATERIALIZE_REUSE_MS } = require('../src/campaigns.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

const NOW = Date.parse('2026-10-28T11:33:33Z');
const def = { none: [{ op: 'within_days', attr: 'last_order_at', value: '15' }] };
const seg = (over = {}) => ({
  kind: 'dynamic', definition: def, materialized_def: def,
  materialized_at: new Date(NOW - 5 * 60 * 1000).toISOString(), ...over,
});

t('fresh rebuild of the same rule → reuse', () => assert.strictEqual(isFreshMaterialization(seg(), NOW), true));
t('older than the window → rebuild', () =>
  assert.strictEqual(isFreshMaterialization(seg({ materialized_at: new Date(NOW - MATERIALIZE_REUSE_MS - 1).toISOString() }), NOW), false));
t('exactly at the window → reuse', () =>
  assert.strictEqual(isFreshMaterialization(seg({ materialized_at: new Date(NOW - MATERIALIZE_REUSE_MS).toISOString() }), NOW), true));
t('rule edited since the rebuild → rebuild', () =>
  assert.strictEqual(isFreshMaterialization(seg({ definition: { none: [{ op: 'within_days', attr: 'last_order_at', value: '30' }] } }), NOW), false));
t('never materialized → rebuild', () => assert.strictEqual(isFreshMaterialization(seg({ materialized_at: null, materialized_def: null }), NOW), false));
t('static segment → never "fresh" (materialize is a no-op for it anyway)', () =>
  assert.strictEqual(isFreshMaterialization(seg({ kind: 'static' }), NOW), false));
t('materialized_at in the future (clock skew) → rebuild', () =>
  assert.strictEqual(isFreshMaterialization(seg({ materialized_at: new Date(NOW + 60 * 1000).toISOString() }), NOW), false));
t('unparseable timestamp → rebuild', () => assert.strictEqual(isFreshMaterialization(seg({ materialized_at: 'yesterday' }), NOW), false));
t('no row (segment missing / read failed) → rebuild', () => assert.strictEqual(isFreshMaterialization(null, NOW), false));
t('null definitions on both sides compare equal only when both null', () => {
  assert.strictEqual(isFreshMaterialization(seg({ definition: null, materialized_def: null }), NOW), true);
  assert.strictEqual(isFreshMaterialization(seg({ definition: null }), NOW), false);
});

// ── the skip path through reachableCount itself, with the worker's Supabase client stubbed ──
const A = require('../src/auth.js');
const CAMP = require('../src/campaigns.js');
const CAMPAIGN = { id: 'C', segment_id: 'S', channel: 'whatsapp', purpose: 'marketing',
  exclude_segment_ids: ['SEG-X', 'SEG-Y'], exclude_campaign_ids: [], exclude_contacted_hours: 24 };
const freshRow = { kind: 'dynamic', definition: def, materialized_def: def, materialized_at: new Date(Date.now() - 60 * 1000).toISOString() };
const stub = (segmentsReply) => {
  const materialized = [];
  A.sbComms = async (path, env, opts = {}) => {
    if (path.startsWith('/rest/v1/segments?id=eq.S')) return segmentsReply;
    if (path.includes('/rpc/materialize_segment')) { materialized.push(JSON.parse(opts.body).p_segment_id); return { ok: true, data: 1 }; }
    if (path.includes('/rpc/campaign_reach')) return { ok: true, data: [{ total: 100, reachable: 90, excluded: 40, sendable: 50 }] };
    return { ok: true, data: [] };
  };
  return materialized;
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};
(async () => {
  await ta('fresh target row → target NOT rebuilt, exclusions still rebuilt, count unchanged', async () => {
    const m = stub({ ok: true, data: [freshRow] });
    const r = await CAMP.reachableCount({}, CAMPAIGN);
    assert.deepEqual(m, ['SEG-X', 'SEG-Y']);
    assert.deepEqual(r, { total: 100, reachable: 90, excluded: 40, sendable: 50 });
  });
  await ta('segments read fails → target rebuilt as before', async () => {
    const m = stub({ ok: false, status: 500, data: null });
    await CAMP.reachableCount({}, CAMPAIGN);
    assert.deepEqual(m, ['S', 'SEG-X', 'SEG-Y']);
  });
  await ta('segments read returns an object, not an array → target rebuilt', async () => {
    const m = stub({ ok: true, data: freshRow });
    await CAMP.reachableCount({}, CAMPAIGN);
    assert.deepEqual(m, ['S', 'SEG-X', 'SEG-Y']);
  });
  await ta('stale target row → target rebuilt', async () => {
    const m = stub({ ok: true, data: [{ ...freshRow, materialized_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }] });
    await CAMP.reachableCount({}, CAMPAIGN);
    assert.deepEqual(m, ['S', 'SEG-X', 'SEG-Y']);
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
