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
  // ── S400: rate limiting across shards ──────────────────────────────────────────────────
  const MSG = { from: 'a <a@b.c>', to: 'x@y.com', subject: 's', html: '<p>h</p>' };
  const resp = (status, body, retryAfter) => ({
    status, ok: status >= 200 && status < 300, json: async () => body,
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) },
  });

  await t('429 then 200 → sent on the retry (a rate limit is not a lost customer)', async () => {
    email._resetPacing();
    let calls = 0;
    global.fetch = async () => (++calls === 1
      ? resp(429, { message: 'Too many requests. You can only make 10 requests per second.' }, '0.001')
      : resp(200, { id: 'em_1' }));
    const r = await email.send(MSG, { RESEND_API_KEY: 'k' });
    global.fetch = realFetch;
    assert.equal(calls, 2);
    assert.equal(r.status, 'sent');
    assert.equal(r.provider_message_id, 'em_1');
  });

  await t('persistent 429 → 1 + 5 attempts, then an honest failure with Resend\'s reason', async () => {
    email._resetPacing();
    let calls = 0;
    global.fetch = async () => { calls++; return resp(429, { message: 'Too many requests.' }, '0.001'); };
    const r = await email.send(MSG, { RESEND_API_KEY: 'k' });
    global.fetch = realFetch;
    assert.equal(calls, 6);
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'Too many requests.');
  });

  await t('non-429 errors are NOT retried (a 422 bad address stays one call)', async () => {
    email._resetPacing();
    let calls = 0;
    global.fetch = async () => { calls++; return resp(422, { message: 'Invalid `to` field.' }); };
    const r = await email.send(MSG, { RESEND_API_KEY: 'k' });
    global.fetch = realFetch;
    assert.equal(calls, 1);
    assert.equal(r.status, 'failed');
  });

  await t('paceShare=3 spaces sends 3× wider (6 shards must not each take the full 10/s)', async () => {
    email._resetPacing();
    const at = [];
    global.fetch = async () => { at.push(Date.now()); return resp(200, { id: 'e' }); };
    await Promise.all([1, 2, 3].map(() => email.send(MSG, { RESEND_API_KEY: 'k' }, { paceShare: 3 })));
    global.fetch = realFetch;
    at.sort((a, b) => a - b);
    // 120ms × 3 = 360ms per slot; allow 15ms timer slop.
    assert.ok(at[1] - at[0] >= 345, `gap1 ${at[1] - at[0]}`);
    assert.ok(at[2] - at[1] >= 345, `gap2 ${at[2] - at[1]}`);
  });

  await t('no paceShare → the old 120ms spacing (journeys/transactional unchanged)', async () => {
    email._resetPacing();
    const at = [];
    global.fetch = async () => { at.push(Date.now()); return resp(200, { id: 'e' }); };
    await Promise.all([1, 2].map(() => email.send(MSG, { RESEND_API_KEY: 'k' })));
    global.fetch = realFetch;
    at.sort((a, b) => a - b);
    const gap = at[1] - at[0];
    assert.ok(gap >= 105 && gap < 300, `gap ${gap}`);
  });

  await t('garbage paceShare clamps: 0/NaN → 1, 1000 → 10 (never a multi-minute stall)', async () => {
    for (const [share, lo, hi] of [[0, 105, 300], ['x', 105, 300], [1000, 1185, 1500]]) {
      email._resetPacing();
      const at = [];
      global.fetch = async () => { at.push(Date.now()); return resp(200, { id: 'e' }); };
      await Promise.all([1, 2].map(() => email.send(MSG, { RESEND_API_KEY: 'k' }, { paceShare: share })));
      global.fetch = realFetch;
      at.sort((a, b) => a - b);
      const gap = at[1] - at[0];
      assert.ok(gap >= lo && gap < hi, `share ${share}: gap ${gap}`);
    }
  });

  await t('a 429 holds back the OTHER senders in the isolate too', async () => {
    email._resetPacing();
    const calls = [];
    global.fetch = async (_u, init) => {
      const who = JSON.parse(init.body).subject;
      calls.push({ who, at: Date.now() });
      return (who === 'A' && calls.filter((c) => c.who === 'A').length === 1)
        ? resp(429, { message: 'rl' }, '0.5') : resp(200, { id: 'e' });
    };
    const t0 = Date.now();
    // B arrives 200ms AFTER A's 429 — without the shared push-back it would fire at ~t0+200.
    await Promise.all([email.send({ ...MSG, subject: 'A' }, { RESEND_API_KEY: 'k' }),
      new Promise((r) => setTimeout(r, 200)).then(() => email.send({ ...MSG, subject: 'B' }, { RESEND_API_KEY: 'k' }))]);
    global.fetch = realFetch;
    const b = calls.find((c) => c.who === 'B');
    assert.ok(b.at - t0 >= 485, `B fired at +${b.at - t0}ms, inside A's 500ms Retry-After`);
  });

  await t('a sender ALREADY sleeping toward its slot also waits out the 429 hold', async () => {
    email._resetPacing();
    const calls = [];
    global.fetch = async (_u, init) => {
      const who = JSON.parse(init.body).subject;
      calls.push({ who, at: Date.now() });
      return (who === 'A' && calls.filter((c) => c.who === 'A').length === 1)
        ? resp(429, { message: 'rl' }, '0.5') : resp(200, { id: 'e' });
    };
    const t0 = Date.now();
    // A and B start together at paceShare 3 → B claims slot t0+360 BEFORE A's 429 lands.
    await Promise.all([email.send({ ...MSG, subject: 'A' }, { RESEND_API_KEY: 'k' }, { paceShare: 3 }),
      email.send({ ...MSG, subject: 'B' }, { RESEND_API_KEY: 'k' }, { paceShare: 3 })]);
    global.fetch = realFetch;
    const b = calls.find((c) => c.who === 'B');
    assert.ok(b.at - t0 >= 485, `B fired at +${b.at - t0}ms, inside A's 500ms Retry-After`);
  });

  await t('backoffMs: Retry-After honoured (capped 5s), else exponential capped 4s, + ≤300ms jitter', () => {
    const r0 = () => 0, r1 = () => 0.999;
    assert.equal(email.backoffMs(0, '2', r0), 2000);
    assert.equal(email.backoffMs(0, '60', r0), 5000);
    assert.equal(email.backoffMs(0, null, r0), 400);
    assert.equal(email.backoffMs(2, null, r0), 1600);
    assert.equal(email.backoffMs(9, null, r0), 4000);
    assert.equal(email.backoffMs(0, 'garbage', r0), 400);
    assert.ok(email.backoffMs(0, null, r1) <= 699);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
