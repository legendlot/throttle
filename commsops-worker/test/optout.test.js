// Node unit tests for opt-out keyword detection + the withdrawal writer.
// Run: node test/optout.test.js   (Node 18+ — global fetch)
// Pure detection needs no network; applyOptOut stubs fetch per-case.

const assert = require('assert');
const { detectOptOut, applyOptOut } = require('../src/optout.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ', name); },
    (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
}

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };

// sbComms reads via res.text() then JSON.parse — NOT res.json(). Stubs must honour that.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : null });
    const r = handler ? handler(u) : null;
    return { ok: true, status: 201, text: async () => (r === undefined ? '[]' : r) };
  };
  return calls;
}

(async () => {
  console.log('detectOptOut — opt-out keywords');
  await t('bare STOP', () => assert.equal(detectOptOut('STOP'), 'opt_out'));
  await t('lowercase', () => assert.equal(detectOptOut('stop'), 'opt_out'));
  await t('trailing full stop', () => assert.equal(detectOptOut('Stop.'), 'opt_out'));
  await t('exclamation', () => assert.equal(detectOptOut('STOP!'), 'opt_out'));
  await t('surrounding whitespace', () => assert.equal(detectOptOut('  stop  '), 'opt_out'));
  await t('hyphenated OPT-OUT', () => assert.equal(detectOptOut('OPT-OUT'), 'opt_out'));
  await t('unsubscribe', () => assert.equal(detectOptOut('unsubscribe'), 'opt_out'));
  await t('button title "Stop promotions"', () => assert.equal(detectOptOut('Stop promotions'), 'opt_out'));

  console.log('detectOptOut — opt-in keywords');
  await t('START', () => assert.equal(detectOptOut('START'), 'opt_in'));
  await t('subscribe', () => assert.equal(detectOptOut('subscribe'), 'opt_in'));

  console.log('detectOptOut — MUST NOT false-positive on support messages');
  await t('complaint containing stop', () =>
    assert.equal(detectOptOut('please stop sending me broken cars'), null));
  await t('stop the order', () => assert.equal(detectOptOut('can you stop the order'), null));
  await t('cancel my order is not an opt-out', () =>
    assert.equal(detectOptOut('cancel my order please'), null));
  await t('greeting', () => assert.equal(detectOptOut('Hi'), null));

  console.log('detectOptOut — degenerate input');
  await t('empty', () => assert.equal(detectOptOut(''), null));
  await t('null', () => assert.equal(detectOptOut(null), null));
  await t('undefined', () => assert.equal(detectOptOut(undefined), null));
  await t('emoji only', () => assert.equal(detectOptOut('🛑'), null));
  // KNOWN GAP (accepted 2026-07-17): non-Latin scripts normalise to '' and are never
  // detected. Documented in BACKLOG; the agent-actioned path is the backstop.
  await t('KNOWN GAP: Hindi STOP is not detected', () =>
    assert.equal(detectOptOut('बंद करो'), null));

  console.log('applyOptOut');
  await t('writes consent + event with evidence', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, {
      profile_id: 'p1', channel: 'whatsapp', state: 'opted_out',
      source: 'whatsapp_inbound_keyword', evidence: { keyword: 'STOP' },
    });
    const consent = calls.find((c) => c.url.includes('/rest/v1/consent'));
    const event = calls.find((c) => c.url.includes('/rest/v1/events'));
    assert.ok(consent, 'must POST a consent row');
    assert.equal(consent.body.purpose, 'marketing');
    assert.equal(consent.body.state, 'opted_out');
    assert.equal(consent.body.channel, 'whatsapp');
    assert.deepEqual(consent.body.evidence, { keyword: 'STOP' }, 's.6(10) proof must persist');
    assert.ok(event, 'must mirror as a substrate event');
    assert.equal(event.body.name, 'opted_out');
  });

  await t('NEVER writes a suppression (would kill transactional)', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_out', source: 's' });
    assert.ok(!calls.some((c) => c.url.includes('/rest/v1/suppressions')),
      'a marketing withdrawal must not suppress — order updates must survive it');
  });

  await t('forwards unsubscribe_token when given', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'email', state: 'opted_out',
      source: 'unsubscribe_link', unsubscribe_token: 'tok-1' });
    const consent = calls.find((c) => c.url.includes('/rest/v1/consent'));
    assert.equal(consent.body.unsubscribe_token, 'tok-1', 'token must survive — unsubscribeUrl keys off it');
  });

  await t('opt_in emits opted_in', async () => {
    const calls = stubFetch();
    await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_in', source: 's' });
    assert.equal(calls.find((c) => c.url.includes('/rest/v1/events')).body.name, 'opted_in');
  });

  await t('requires profile_id', async () => {
    stubFetch();
    const r = await applyOptOut(ENV, { channel: 'whatsapp', state: 'opted_out', source: 's' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'profile_id_required');
  });

  await t('rejects a bad state', async () => {
    stubFetch();
    const r = await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'maybe', source: 's' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'bad_state');
  });

  await t('THROWS when the consent write fails (must not silently lose a STOP)', async () => {
    globalThis.fetch = async (url) => String(url).includes('/rest/v1/consent')
      ? { ok: false, status: 500, text: async () => '{"message":"boom"}' }
      : { ok: true, status: 201, text: async () => '[]' };
    await assert.rejects(
      () => applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_out', source: 's' }),
      /consent_write_failed/,
      'a failed withdrawal must throw so the webhook 500s and Meta retries');
  });

  await t('event-mirror failure does NOT throw (consent row is the system of record)', async () => {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('/rest/v1/events'))
        return { ok: false, status: 500, text: async () => '{"message":"events boom"}' };
      return { ok: true, status: 201, text: async () => '[]' };
    };
    const r = await applyOptOut(ENV, { profile_id: 'p1', channel: 'whatsapp', state: 'opted_out', source: 's' });
    assert.equal(r.ok, true, 'a failed mirror must not fail the withdrawal');
    assert.ok(seen.some((u) => u.includes('/rest/v1/consent')), 'consent must still have been written');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
