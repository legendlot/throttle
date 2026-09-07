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
  console.log('bots-config ok');
})();
