// test/forms-confirm-race.test.js — S342, capture-spine SP1 residuals (b) + (d).
//
// (d) CONFIRM IDEMPOTENCY. The early `if (sub.confirmed_at) return already` is a read, and a
// read cannot serialise anything. Two concurrent confirms (double-click, a mail client
// prefetching the link, a retry after a timeout) both saw NULL and both wrote consent. The
// conditional PATCH — `?confirmed_at=is.null` — is now the mutex; Postgres arbitrates.
//
// (b) IP HASH. A plain SHA-256 of an IPv4 is reversible by brute force (2^32 inputs), so the
// digest is salted, and with no salt configured we store nothing rather than the reversible form.
const assert = require('assert');
const A = require('../src/auth.js');
const { handleFormConfirm, handleFormSubmit } = require('../src/forms.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const SUB = {
  id: 'sub-1', profile_id: 'prof-1', confirmed_at: null, channels: ['email'],
  payload: { email: 'a@b.com' }, submitted_at: '2026-09-03T00:00:00Z',
  forms: { slug: 'back-in-stock', consent_copy_version: 1 },
};

// A fake that models the ONE thing that matters: the conditional PATCH matches at most once,
// exactly as Postgres would. Everything else is a stub.
function makeDb({ claimedAlready = false } = {}) {
  const state = { claimed: claimedAlready, consentWrites: 0, patches: [] };
  A.sbComms = async (path, env, opts) => {
    if (path.startsWith('/rest/v1/form_submissions?confirm_token='))
      return { ok: true, data: [SUB] };
    if (path.startsWith('/rest/v1/form_submissions?id=') && opts?.method === 'PATCH') {
      state.patches.push(path);
      const conditional = path.includes('confirmed_at=is.null');
      if (conditional && state.claimed) return { ok: true, data: [] };  // lost the race
      state.claimed = true;
      return { ok: true, data: [{ ...SUB, confirmed_at: 'now' }] };
    }
    if (path.startsWith('/rest/v1/consent')) { state.consentWrites++; return { ok: true, data: [{}] }; }
    return { ok: true, data: [] };
  };
  return state;
}

(async () => {
  // ── (d) the mutex ──────────────────────────────────────────────────────────
  await t('the confirm PATCH is conditional on confirmed_at IS NULL', async () => {
    const s = makeDb();
    await handleFormConfirm({}, 'tok');
    assert.equal(s.patches.length, 1);
    assert.ok(s.patches[0].includes('confirmed_at=is.null'),
      `PATCH was unconditional: ${s.patches[0]}`);
  });

  await t('first confirm wins: consent recorded once', async () => {
    const s = makeDb();
    const r = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r, { ok: true, confirmed: true });
    assert.equal(s.consentWrites, 1);
  });

  await t('THE RACE: loser writes NO consent and reports already', async () => {
    // Another request confirmed between our read and our write, so the conditional matches 0 rows.
    const s = makeDb({ claimedAlready: true });
    const r = await handleFormConfirm({}, 'tok');
    assert.deepEqual(r, { ok: true, confirmed: true, already: true });
    assert.equal(s.consentWrites, 0, 'loser must not write a second set of consent rows');
  });

  await t('two concurrent confirms produce exactly ONE set of consent rows', async () => {
    const s = makeDb();
    const [r1, r2] = await Promise.all([handleFormConfirm({}, 'tok'), handleFormConfirm({}, 'tok')]);
    assert.equal(s.consentWrites, 1, `expected 1 consent write, got ${s.consentWrites}`);
    assert.ok([r1, r2].some((r) => r.already === true), 'one of the two must report already');
  });

  await t('a failed claim fails CLOSED — no consent recorded', async () => {
    let consentWrites = 0;
    A.sbComms = async (path, env, opts) => {
      if (path.startsWith('/rest/v1/form_submissions?confirm_token=')) return { ok: true, data: [SUB] };
      if (opts?.method === 'PATCH') return { ok: false, status: 500, data: null };
      if (path.startsWith('/rest/v1/consent')) { consentWrites++; return { ok: true, data: [{}] }; }
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm({}, 'tok');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'confirm_failed');
    assert.equal(consentWrites, 0, 'must not record consent it cannot evidence');
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
    let stored = null;
    A.sbComms = async (path, _e, opts) => {
      if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [{
        slug: 'f', active: true, fields: [{ key: 'email', type: 'email', required: true }],
        dedupe_keys: [], double_optin: false, consent_copy_version: 1 }] };
      if (path.startsWith('/rest/v1/form_submissions') && opts?.method === 'POST') {
        stored = JSON.parse(opts.body); return { ok: true, data: [{ id: 'x' }] };
      }
      return { ok: true, data: [] };
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
    const request = { json: async () => ({ form: 'f', turnstile_token: 'tok', email: 'a@b.com' }),
      headers: { get: (h) => (String(h).toLowerCase() === 'cf-connecting-ip' ? '203.0.113.9' : null) } };
    const res = await handleFormSubmit(env, request);
    return { stored, res };
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
