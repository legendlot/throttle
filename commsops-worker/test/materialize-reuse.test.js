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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
