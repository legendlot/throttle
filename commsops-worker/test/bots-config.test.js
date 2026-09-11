// S355 — pilot switch is activate-tier only; saveBot cannot flip it. Run: node test/bots-config.test.js
const assert = require('assert');
const B = require('../src/bots.js');
const A = require('../src/auth.js');
assert.deepEqual(B.sanitizeBuilderConfig({ mode: 'public', pilot_numbers: ['1'], greeting_delay: 2 }, { mode: 'pilot', pilot_numbers: ['917709991011'] }),
  { mode: 'pilot', pilot_numbers: ['917709991011'], greeting_delay: 2 });
assert.deepEqual(B.sanitizeBuilderConfig({}, {}), { mode: 'pilot', pilot_numbers: [] });
assert.deepEqual(B.normalizeMode({ mode: 'public', pilot_numbers: ['+91 77099 91011', 'x', '12'] }), { mode: 'public', pilot_numbers: ['917709991011'] });
assert.deepEqual(B.normalizeMode({ mode: 'weird' }), null);

(async () => {
  // Fix round 1, finding 1: a failed shared-bots lookup must not be swallowed into an empty Set —
  // that would lint every subflow step as subflow_target_invalid on a transient 5xx.
  const orig = A.sbComms;
  A.sbComms = async (path) => {
    if (path.startsWith('/rest/v1/bots?id=eq.')) {
      return { ok: true, data: [{ id: 'b1', draft_definition: { entry: 'e', steps: { e: { type: 'end', outcomes: {} } } }, channel: 'web', active_version: null, config: {} }] };
    }
    if (path.startsWith('/rest/v1/bots?channel=eq.shared')) {
      return { ok: false, status: 500, data: { message: 'boom' } };
    }
    return { ok: true, data: [] };
  };
  try {
    const r = await B.publishBot({}, 'b1', 'u');
    assert.deepEqual(r, { ok: false, error: 'shared_lookup_failed' });
  } finally {
    A.sbComms = orig;
  }

  // S377 — saveBot is compare-and-swap on updated_at (stale-tab Publish overwrote newer drafts).
  const STORED = '2026-09-11T13:45:12.098+00:00';
  const calls = [];
  const fake = (patchRows) => async (path, env, opts) => {
    calls.push({ path, method: opts?.method || 'GET' });
    if (!opts?.method) return { ok: true, data: [{ id: 'b1', name: 'x', updated_at: STORED, config: {}, active_version: 1, channel: 'web' }] };
    return { ok: true, data: patchRows };
  };
  const save = (extra) => B.saveBot({}, { id: 'b1', name: 'x', draft_definition: {}, config: {}, channel: 'web', ...extra }, 'u');
  try {
    // a colleague saved after we loaded → refused, nothing written
    calls.length = 0; A.sbComms = fake([{ id: 'b1' }]);
    let r = await save({ expected_updated_at: '2026-09-11T13:00:00.000Z' });
    assert.equal(r.error, 'stale_draft'); assert.equal(r.current_updated_at, STORED);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
    // same instant in a different string form (Z vs +00:00) is NOT a conflict, and the PATCH carries the CAS filter
    calls.length = 0;
    r = await save({ expected_updated_at: '2026-09-11T13:45:12.098Z' });
    assert.equal(r.ok, true);
    assert.ok(calls.find((c) => c.method === 'PATCH').path.includes(`&updated_at=eq.${encodeURIComponent(STORED)}`));
    // a save landing between our read and our write: the CAS PATCH matches zero rows
    A.sbComms = fake([]);
    r = await save({ expected_updated_at: STORED });
    assert.equal(r.error, 'stale_draft');
    // force = the author confirmed the overwrite → no CAS filter, write lands
    calls.length = 0; A.sbComms = fake([{ id: 'b1' }]);
    r = await save({ expected_updated_at: '2026-09-11T13:00:00.000Z', force: true });
    assert.equal(r.ok, true);
    assert.ok(!calls.find((c) => c.method === 'PATCH').path.includes('updated_at=eq.'));
    // no expected_updated_at (cached pre-fix bundle) → old last-write-wins, unguarded
    calls.length = 0;
    r = await save({});
    assert.equal(r.ok, true);
    assert.ok(!calls.find((c) => c.method === 'PATCH').path.includes('updated_at=eq.'));
    // a new bot (POST) is never guarded
    calls.length = 0;
    r = await B.saveBot({}, { name: 'n', draft_definition: {}, config: {}, channel: 'web', expected_updated_at: 'x' }, 'u');
    assert.equal(r.ok, true); assert.equal(calls[0].method, 'POST');
  } finally {
    A.sbComms = orig;
  }
  console.log('bots-config ok');
})();
