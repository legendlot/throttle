// test/forms-turnstile.test.js — the bot gate on the public capture surface (S331 SP1).
// ⚠️ EVERY failure path must return false. A challenge that fails OPEN is not a challenge.
const assert = require('assert');
const { verifyTurnstile } = require('../src/forms.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const origFetch = globalThis.fetch;
const ENV = { TURNSTILE_SECRET: 's3cret' };

(async () => {
  await t('a valid token passes', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), true);
  });

  await t('an invalid token fails', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: false }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('an absent token fails without calling out', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({ success: true }) }; };
    assert.equal(await verifyTurnstile(ENV, '', '1.2.3.4'), false);
    assert.equal(called, false, 'must not call siteverify with an empty token');
  });

  await t('a network error fails CLOSED', async () => {
    globalThis.fetch = async () => { throw new Error('boom'); };
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('a non-200 from siteverify fails CLOSED', async () => {
    // ⚠️ The body deliberately says success:true. If the `!r.ok` guard were deleted, this
    // would return TRUE — which is exactly the regression this test exists to catch. A mock
    // returning {} passes with or without the guard and therefore proves nothing.
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile(ENV, 'tok', '1.2.3.4'), false);
  });

  await t('an unconfigured secret fails CLOSED, never open', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    assert.equal(await verifyTurnstile({}, 'tok', '1.2.3.4'), false);
  });

  globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
