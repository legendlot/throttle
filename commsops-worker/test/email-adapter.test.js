// test/email-adapter.test.js
const assert = require('assert');
const email = require('../src/adapters/email.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const realFetch = global.fetch;
(async () => {
  await t('network error → failed result, never a throw', async () => {
    global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.resend.com'); };
    const r = await email.send({ from: 'a <a@b.c>', to: 'x@y.com', subject: 's', html: '<p>h</p>' }, { RESEND_API_KEY: 'k' });
    global.fetch = realFetch;
    assert.equal(r.status, 'failed');
    assert.ok(String(r.reason).startsWith('resend_network:'));
    assert.strictEqual(r.provider_message_id, null);
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
