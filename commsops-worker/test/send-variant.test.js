// test/send-variant.test.js — variant_id must land on the messages row for EVERY outcome, not just
// successful sends. The per-arm failure-asymmetry check in ab-stats.js reads exactly those
// non-sent rows, so if the stamp were only applied on success that check would silently compare
// nothing. Harness copied from test/send-dedup.test.js.
const assert = require('assert');
const A = require('../src/auth.js');
const { send } = require('../src/send.js');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve().then(fn).then(
  () => { pass++; console.log('  ok  ', name); },
  (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
const origSb = A.sbComms;
const ENV = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };

(async () => {
  await t('variant_id is persisted on a NON-SENT outcome', async () => {
    let posted = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };   // → template_not_found
      if (path.startsWith('/rest/v1/messages') && (opts.method || 'GET') === 'POST') {
        posted = JSON.parse(opts.body);
        return { ok: true, data: [{ id: 'M-VAR' }] };
      }
      return { ok: true, data: [] };
    };
    const r = await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com',
                                templateId: 'T', variantId: 'VAR-B' });
    assert.ok(posted, 'finalize must have written a messages row');
    assert.equal(posted.variant_id, 'VAR-B', 'variant_id missing from the persisted row');
    assert.notEqual(r.status, 'sent');
  });

  await t('variant_id is null when no arm was assigned (every existing caller)', async () => {
    let posted = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };
      if (path.startsWith('/rest/v1/messages') && (opts.method || 'GET') === 'POST') {
        posted = JSON.parse(opts.body);
        return { ok: true, data: [{ id: 'M-NOVAR' }] };
      }
      return { ok: true, data: [] };
    };
    await send(ENV, { channel: 'email', purpose: 'utility', to: 'a@b.com', templateId: 'T' });
    assert.ok(posted, 'finalize must have written a messages row');
    assert.strictEqual(posted.variant_id, null, 'must be null, not undefined — undefined is dropped by JSON.stringify and the column would never be written');
  });

  A.sbComms = origSb;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
