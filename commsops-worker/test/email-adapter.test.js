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

  await t('sends are spaced 120ms apart (~8.3/s under the Resend 10/s ceiling)', async () => {
    email._resetPacing();
    const at = [];
    global.fetch = async () => { at.push(Date.now()); return resp(200, { id: 'e' }); };
    await Promise.all([1, 2].map(() => email.send(MSG, { RESEND_API_KEY: 'k' })));
    global.fetch = realFetch;
    at.sort((a, b) => a - b);
    const gap = at[1] - at[0];
    assert.ok(gap >= 105 && gap < 300, `gap ${gap}`);
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
    // A and B start together → B claims slot t0+120 BEFORE A's 429 lands (fetch mock is instant,
    // so A's 429 is back at ~t0; B is already sleeping toward its slot).
    await Promise.all([email.send({ ...MSG, subject: 'A' }, { RESEND_API_KEY: 'k' }),
      email.send({ ...MSG, subject: 'B' }, { RESEND_API_KEY: 'k' })]);
    global.fetch = realFetch;
    const b = calls.find((c) => c.who === 'B');
    assert.ok(b.at - t0 >= 485, `B fired at +${b.at - t0}ms, inside A's 500ms Retry-After`);
  });

  await t('S400 #3: a QUOTA 429 fails at once — no retries, no isolate hold', async () => {
    email._resetPacing();
    let calls = 0;
    global.fetch = async () => { calls++; return resp(429, { name: 'monthly_quota_exceeded', message: 'You have reached your monthly email sending quota.' }, '5'); };
    const t0 = Date.now();
    const r = await email.send(MSG, { RESEND_API_KEY: 'k' });
    let calls2 = 0;
    global.fetch = async () => { calls2++; return resp(200, { id: 'e' }); };
    await email.send(MSG, { RESEND_API_KEY: 'k' });
    global.fetch = realFetch;
    assert.equal(calls, 1);
    assert.equal(r.status, 'failed');
    assert.ok(/quota/.test(r.reason));
    assert.ok(Date.now() - t0 < 1000, `a quota 429 must not hold the isolate (${Date.now() - t0}ms)`);
  });

  await t('S400 Codex #2: the LAST rate 429 still holds the other senders', async () => {
    email._resetPacing();
    global.fetch = async () => resp(429, { message: 'rl' }, '0.3');
    await email.send(MSG, { RESEND_API_KEY: 'k' });            // 6 attempts; the 6th sets a ≥300ms hold
    const t0 = Date.now();
    const at = [];
    global.fetch = async () => { at.push(Date.now()); return resp(200, { id: 'e' }); };
    await email.send(MSG, { RESEND_API_KEY: 'k' });
    global.fetch = realFetch;
    assert.ok(at[0] - t0 >= 280, `next sender fired ${at[0] - t0}ms after the final 429 — no hold`);
  });

  await t('S400 Codex #1: senders released from a hold are SPACED, not a burst', async () => {
    email._resetPacing();
    const calls = [];
    let first = true;
    global.fetch = async (_u, init) => {
      calls.push(Date.now());
      if (first) { first = false; return resp(429, { message: 'rl' }, '0.4'); }
      return resp(200, { id: 'e' });
    };
    await Promise.all([1, 2, 3, 4].map(() => email.send(MSG, { RESEND_API_KEY: 'k' })));
    global.fetch = realFetch;
    const after = calls.slice(1).sort((a, b) => a - b).filter((x) => x - calls[0] >= 380);
    for (let i = 1; i < after.length; i++)
      assert.ok(after[i] - after[i - 1] >= 105, `post-hold gap ${after[i] - after[i - 1]}ms`);
    assert.ok(after.length >= 3, `expected ≥3 sends after the hold, got ${after.length}`);
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
