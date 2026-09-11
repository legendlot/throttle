// test/forms-confirm-race.test.js — S342, capture-spine SP1 residuals (b) + (d).
//
// (d) CONFIRM IDEMPOTENCY. The early `if (sub.confirmed_at) return already` is a read, and a
// read cannot serialise anything. Two concurrent confirms (double-click, a mail client
// prefetching the link, a retry after a timeout) both saw NULL and both wrote consent.
// S342 made a conditional PATCH the mutex; 0073 (S377) replaced the whole claim/write/rollback
// sequence with ONE transaction, comms.form_confirm, which locks the row FOR UPDATE — the
// rollback it needed had two holes of its own: (i) a partial consent failure re-wrote the rows
// that HAD landed on retry, (ii) a failed rollback left confirmed_at set with no consent.
//
// (b) IP HASH. A plain SHA-256 of an IPv4 is reversible by brute force (2^32 inputs), so the
// digest is salted, and with no salt configured we store nothing rather than the reversible form.
const assert = require('assert');
const A = require('../src/auth.js');
const { handleFormConfirm, handleFormSubmit } = require('../src/forms.js');
const { createFakeFormsDb } = require('./_fake-forms-rpc.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const FORM = { id: 'form-1', slug: 'back-in-stock', consent_copy_version: 1 };
const SUB = {
  form_id: 'form-1', profile_id: 'prof-1', confirmed_at: null, channels: ['email'],
  payload: { email: 'a@b.com' }, submitted_at: '2026-09-03T00:00:00Z', confirm_token: 'tok',
};

// The in-memory form_confirm (see _fake-forms-rpc.js): one call runs to completion before the
// next, which is what the FOR UPDATE lock gives Postgres. `writes` is every non-GET path sent.
function makeDb(row = {}) {
  const db = createFakeFormsDb({ forms: [FORM] });
  const sub = db.seedSubmission({ ...SUB, ...row });
  const writes = [];
  A.sbComms = async (path, env, opts = {}) => {
    if ((opts.method || 'GET') !== 'GET') writes.push(path);
    const rpc = await db.route(path, opts);
    if (rpc) return rpc;
    return { ok: true, data: [] };
  };
  return { db, sub, writes };
}

(async () => {
  // ── (d) the mutex ──────────────────────────────────────────────────────────
  // Was "the confirm PATCH is conditional on confirmed_at IS NULL". The PATCH is gone; the
  // mutex is the row lock inside the function. What must hold is that the handler sends
  // nothing BUT that one call — any direct table write is back outside the transaction.
  await t('confirm is ONE rpc/form_confirm call with {p_token} — no direct table writes', async () => {
    const { db, writes } = makeDb();
    await handleFormConfirm({}, ' tok ');
    assert.deepEqual(writes, ['/rest/v1/rpc/form_confirm']);
    assert.deepEqual(db.callsTo('form_confirm')[0].args, { p_token: 'tok' }, 'the token is trimmed before it is sent');
  });

  await t('first confirm wins: consent recorded once', async () => {
    const { db, sub } = makeDb();
    const r = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r, { ok: true, confirmed: true });
    assert.equal(db.consent.length, 1);
    assert.ok(sub.confirmed_at);
  });

  await t('THE RACE: loser writes NO consent and reports already', async () => {
    // Another request confirmed first; the function re-reads the row under the lock and sees it.
    const { db } = makeDb({ confirmed_at: '2026-09-03T00:05:00Z' });
    const r = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r, { ok: true, confirmed: true, already: true });
    assert.equal(db.consent.length, 0, 'loser must not write a second set of consent rows');
  });

  await t('two back-to-back confirms produce exactly ONE set of consent rows (sequential in the fake — true concurrency is the 0073 FOR UPDATE lock, untested here)', async () => {
    const { db } = makeDb({ channels: ['email', 'whatsapp'], payload: { email: 'a@b.com', phone: '+917709991011' } });
    const [r1, r2] = await Promise.all([handleFormConfirm({}, 'tok'), handleFormConfirm({}, 'tok')]);
    assert.equal(db.consent.length, 2, `expected one row per chosen channel (2), got ${db.consent.length}`);
    assert.deepEqual(db.consent.map((c) => c.channel).sort(), ['email', 'whatsapp']);
    assert.ok([r1, r2].some((r) => r.already === true), 'one of the two must report already');
  });

  // Was "a failed claim fails CLOSED". There is no separate claim: the call as a whole fails.
  await t('an rpc that never ran fails CLOSED — 502, no consent, nothing stamped', async () => {
    const { db, sub } = makeDb();
    db.failNext('form_confirm', 'call');
    const r = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r, { ok: false, error: 'confirm_failed', status: 502 });
    assert.equal(db.consent.length, 0, 'must not record consent it cannot evidence');
    assert.equal(sub.confirmed_at, null);
  });

  // ⭐ Was "consent-write failure RELEASES the claim" (a rollback PATCH). The hole it guarded —
  // confirmed_at set with no consent, so the next click says "You are subscribed" over nothing —
  // is now closed by the transaction: the consent insert raising AFTER the stamp undoes the stamp.
  await t('consent failure AFTER the stamp rolls the stamp back — the link stays clickable', async () => {
    const { db, sub } = makeDb({ channels: ['email', 'whatsapp'], payload: { email: 'a@b.com', phone: '+917709991011' } });
    db.failNext('form_confirm', 'consent');
    const r = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r, { ok: false, error: 'confirm_failed', status: 502 },
      'must not report success when consent was not written');
    assert.equal(sub.confirmed_at, null, 'hole (ii): a stamp with no consent behind it');
    assert.equal(db.consent.length, 0);
    assert.ok(!/a@b\.com|23503|constraint/.test(JSON.stringify(r)), 'PostgREST detail stays in the log');
  });

  await t('the retry after a failed confirm writes exactly ONE set of consent rows', async () => {
    const { db, sub } = makeDb({ channels: ['email', 'whatsapp'], payload: { email: 'a@b.com', phone: '+917709991011' } });
    db.failNext('form_confirm', 'consent');
    await handleFormConfirm({}, 'tok');
    const r = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r, { ok: true, confirmed: true }, 'the retry must confirm, not answer `already`');
    assert.equal(db.consent.length, 2, 'hole (i): rows from the failed attempt written a second time');
    assert.ok(sub.confirmed_at);
  });

  // Was "the rollback can only unclaim OUR OWN stamp, never a later confirm". There is no
  // rollback PATCH to aim wrong any more; the intent — a failed confirm can never undo a
  // successful one — is asserted on the outcome of a failed + a successful concurrent confirm.
  await t('a failed confirm racing a successful one never disturbs the winner', async () => {
    const { db, sub } = makeDb();
    db.failNext('form_confirm', 'consent');
    const [r1, r2] = await Promise.all([handleFormConfirm({}, 'tok'), handleFormConfirm({}, 'tok')]);
    assert.deepEqual([r1.ok, r2.ok], [false, true]);
    assert.ok(sub.confirmed_at, 'the winner\'s stamp must survive the loser\'s failure');
    assert.equal(db.consent.length, 1);
    const r3 = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r3, { ok: true, confirmed: true, already: true });
    assert.equal(db.consent.length, 1);
  });

  await t('an unknown token is 404 invalid_token and touches no row', async () => {
    const { db, sub } = makeDb();
    const r = await handleFormConfirm({}, 'not-a-token');
    assert.deepEqual(r, { ok: false, error: 'invalid_token', status: 404 });
    assert.equal(sub.confirmed_at, null);
    assert.equal(db.consent.length, 0);
  });

  // ── (b) the salt ───────────────────────────────────────────────────────────
  // Driven through the public submit path, since hashIp is private.
  // ⚠️ An earlier cut of these two guarded every assertion behind `if (stored)` — and `stored`
  // was ALWAYS null (the token field is `turnstile_token`, so the challenge failed and the
  // handler returned 403 before ever hashing). Both "passed" while asserting nothing. Every
  // assertion below is unconditional, and the first one asserts the row was captured at all,
  // so this can never silently go vacuous again.
  const origFetch = globalThis.fetch;
  const submitWith = async (env) => {
    const db = createFakeFormsDb();
    A.sbComms = async (path, _e, opts) => {
      const rpc = await db.route(path, opts);
      if (rpc) return rpc;
      if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [{
        id: 'form-f', slug: 'f', active: true, fields: [{ key: 'email', type: 'email', required: true }],
        dedupe_keys: [], double_optin: false, consent_copy_version: 1 }] };
      return { ok: true, data: [] };
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    const request = { json: async () => ({ form: 'f', turnstile_token: 'tok', email: 'a@b.com' }),
      headers: { get: (h) => (String(h).toLowerCase() === 'cf-connecting-ip' ? '203.0.113.9' : null) } };
    const res = await handleFormSubmit(env, request);
    return { stored: db.submissions[0] || null, res };
  };

  await t('no salt configured → ip_hash is null, NOT the reversible digest', async () => {
    const { stored, res } = await submitWith({ TURNSTILE_SECRET: 's' });
    assert.ok(stored, `submission was never written — test is vacuous (handler said ${JSON.stringify(res)})`);
    assert.equal(stored.ip_hash ?? null, null, `stored a hash with no salt: ${stored.ip_hash}`);
  });

  await t('salt is actually keyed into the digest', async () => {
    const a = await submitWith({ TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt-one' });
    const b = await submitWith({ TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt-two' });
    assert.ok(a.stored && b.stored, 'submissions were never written — test is vacuous');
    assert.match(a.stored.ip_hash, /^[0-9a-f]{16}$/);
    assert.notEqual(a.stored.ip_hash, b.stored.ip_hash, 'same IP + different salt must differ');
  });

  await t('same salt + same IP is stable (abuse triage still works)', async () => {
    const a = await submitWith({ TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt-one' });
    const b = await submitWith({ TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt-one' });
    assert.ok(a.stored && b.stored, 'submissions were never written — test is vacuous');
    assert.equal(a.stored.ip_hash, b.stored.ip_hash);
  });

  globalThis.fetch = origFetch;

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
