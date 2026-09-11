// test/forms-submit.test.js — the write path of the public capture surface (S331 SP1).
// The four tables a submission can touch: profiles, identifiers (via resolve_identity),
// consent, form_submissions. A refused submission must write to NONE of them.
const assert = require('assert');
const A = require('../src/auth.js');
const { handleFormSubmit } = require('../src/forms.js');
const { createFakeFormsDb } = require('./_fake-forms-rpc.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const origSb = A.sbComms, origFetch = globalThis.fetch;
const ENV = { TURNSTILE_SECRET: 's3cret' };

const FORM_ROW = {
  id: 'F1', slug: 'back-in-stock', name: 'Notify me', kind: 'form', active: true,
  requires_confirmation: false, consent_copy_version: 2,
  fields: [
    { key: 'product_code', type: 'hidden', required: true },
    { key: 'email', type: 'email', required: true },
  ],
  dedupe_keys: ['product_code'],
};

// Records every write so a test can assert on what was NOT written. The submission + consent
// rows now come from ONE rpc (comms.form_capture, 0073), emulated in-memory by the fake — so the
// row assertions read `db.submissions` / `db.consent`, i.e. what the transaction committed.
function mockDb(writes, opts = {}) {
  const db = createFakeFormsDb({ forms: [opts.form || FORM_ROW] });
  A.sbComms = async (path, env, o = {}) => {
    const method = o.method || 'GET';
    if (method !== 'GET') writes.push({ path, method, headers: o.headers || {}, body: o.body ? JSON.parse(o.body) : null });
    const rpc = await db.route(path, o);
    if (rpc) return rpc;
    if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [opts.form || FORM_ROW] };
    if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
    if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E1' }] };
    if (path.startsWith('/rest/v1/profiles')) return { ok: true, data: [{ attributes: {} }] };
    return { ok: true, data: [] };
  };
  return db;
}
const req = (body, headers = {}) => new Request('https://x/f/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const turnstile = (success) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ success }) }); };
const wrote = (writes, frag) => writes.filter((w) => w.path.includes(frag));

(async () => {
  await t('a happy submission writes an event, a consent row and a submission', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.deepEqual(r, { ok: true, submitted: true, slug: 'back-in-stock', channels: ['email'] });
    assert.equal(wrote(writes, '/events').length, 1);
    assert.equal(db.consent.length, 1);
    assert.equal(db.submissions.length, 1);
    assert.equal(wrote(writes, '/rpc/form_capture').length, 1, 'submission + consent are ONE transaction');
    assert.equal(wrote(writes, '/rest/v1/consent').length + wrote(writes, '/rest/v1/form_submissions').length, 0,
      'a direct REST write to either table is the pre-0073 split write that could half-land');
  });

  await t('consent is purpose `service`, opted_in, with versioned evidence', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(db.callsTo('form_capture')[0].args.p_consent_purpose, 'service',
      'a non-confirmation form asks the function for `service` consent');
    const c = db.consent[0];
    assert.equal(c.purpose, 'service', 'a requested alert is `service` — NOT a new product_alert purpose');
    assert.equal(c.state, 'opted_in');
    assert.equal(c.source, 'website_form:back-in-stock');
    assert.equal(c.evidence.consent_copy_version, 2);
    assert.equal(c.evidence.turnstile_ok, true);
  });

  await t('a FAILED turnstile writes NOTHING to any of the four tables', async () => {
    const writes = []; const db = mockDb(writes); turnstile(false);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'bad', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'challenge_failed');
    assert.equal(writes.length, 0, `expected zero writes, got ${JSON.stringify(writes)}`);
    assert.equal(db.submissions.length + db.consent.length, 0);
  });

  await t('the honeypot lies to the bot and writes nothing', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1', website: 'spam' }));
    assert.equal(r.ok, true, 'must look like success so the bot learns nothing');
    assert.equal(writes.length, 0);
    assert.equal(db.submissions.length + db.consent.length, 0);
  });

  await t('an unknown form slug is refused, with no writes', async () => {
    const writes = []; turnstile(true);
    A.sbComms = async (path, env, o = {}) => {
      if ((o.method || 'GET') !== 'GET') writes.push({ path });
      if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    const r = await handleFormSubmit(ENV, req({ form: 'nope', turnstile_token: 'tok', email: 'a@b.com' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'form_not_found');
    assert.equal(writes.length, 0);
  });

  await t('an existing profile resolves via identifiers rather than a second profile', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    let sentIds = null;
    const sb = A.sbComms;
    A.sbComms = async (path, env, o = {}) => {
      if (path.includes('resolve_identity')) { sentIds = JSON.parse(o.body).p_identifiers; return { ok: true, data: 'EXISTING' }; }
      return sb(path, env, o);
    };
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.deepEqual(sentIds, [{ type: 'email', value: 'a@b.com', is_verified: false }],
      'identity must go through resolve_identity — never a second resolver');
    assert.equal(db.submissions[0].profile_id, 'EXISTING');
    assert.equal(db.consent[0].profile_id, 'EXISTING');
  });

  await t('the dedupe key reaches BOTH the ingest key and the submission row', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(wrote(writes, '/events')[0].body.idempotency_key, 'form:back-in-stock:a@b.com:SKU1');
    assert.equal(db.callsTo('form_capture')[0].args.p_dedupe_key, 'back-in-stock:a@b.com:SKU1',
      'form_capture dedupes ON CONFLICT (form_id, dedupe_key) — a missing key means it never fires');
    assert.equal(db.submissions[0].dedupe_key, 'back-in-stock:a@b.com:SKU1');
    assert.equal(db.submissions[0].form_id, 'F1');
  });

  await t('a failed challenge does not even LOOK UP the form (no slug probing)', async () => {
    const reads = [];
    A.sbComms = async (path) => { reads.push(path); return { ok: true, data: [] }; };
    turnstile(false);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'bad', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'challenge_failed');
    assert.equal(reads.length, 0, 'the form lookup must happen AFTER the challenge, or an unchallenged caller can probe which slugs exist');
  });

  await t('a confirmation-required form writes NO consent row at capture', async () => {
    const writes = []; const db = mockDb(writes, { form: { ...FORM_ROW, requires_confirmation: true } }); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.equal(db.callsTo('form_capture')[0].args.p_consent_purpose, null,
      'NULL purpose is what tells form_capture to write no consent until /f/confirm');
    assert.equal(db.consent.length, 0, 'consent must wait for confirmation');
    assert.equal(db.submissions.length, 1);
    assert.ok(db.submissions[0].confirm_token, 'must mint a confirm token');
  });

  // -- F1: an anonymous stranger must never be able to MERGE two profiles ------
  // /!\ THE BUG THIS EXISTS TO PREVENT: pushing both email and phone into one
  // resolve_identity call. Both are STRONG types in comms.resolve_identity (0049); two strong
  // identifiers landing on two DIFFERENT existing profiles trigger merge_profiles, which
  // reassigns identifiers/events/consent/suppressions and DELETES the losing profile row.
  // `is_verified:false` does not help -- the merge decision never reads it. It needs no
  // attacker: a shared household phone (two people, two emails, one WhatsApp number) fuses
  // two real customers and deletes one, from an unauthenticated public endpoint.
  const FORM_BOTH = { ...FORM_ROW, fields: [
    { key: 'product_code', type: 'hidden', required: true },
    { key: 'email', type: 'email', required: true },
    { key: 'phone', type: 'tel', required: false },
  ] };

  await t('email+phone sends exactly ONE identifier to resolve_identity - never a merge', async () => {
    const writes = []; mockDb(writes, { form: FORM_BOTH }); turnstile(true);
    let sentIds = null;
    const sb = A.sbComms;
    A.sbComms = async (path, env, o = {}) => {
      if (path.includes('resolve_identity')) sentIds = JSON.parse(o.body).p_identifiers;
      return sb(path, env, o);
    };
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok',
      email: 'a@b.com', phone: '7709991011', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.equal(sentIds.length, 1,
      'TWO strong identifiers let an anonymous POST force merge_profiles, which DELETES a profile row');
    assert.deepEqual(sentIds, [{ type: 'email', value: 'a@b.com', is_verified: false }],
      'email is the primary - it is also dedupeKey identity precedence, so the two must agree');
  });

  await t('the second identifier is attached directly, with ignore-duplicates so it is never stolen', async () => {
    const writes = []; mockDb(writes, { form: FORM_BOTH }); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok',
      email: 'a@b.com', phone: '7709991011', product_code: 'SKU1' }));
    const ids = wrote(writes, '/rest/v1/identifiers');
    assert.equal(ids.length, 1, 'the phone must still reach the profile - just not through the resolver');
    assert.equal(ids[0].method, 'POST');
    assert.equal(ids[0].body.profile_id, 'P1', 'attached to the profile ingest resolved, not re-resolved');
    assert.equal(ids[0].body.type, 'phone');
    assert.equal(ids[0].body.value, '+917709991011');
    assert.equal(ids[0].body.is_verified, false, 'nobody proved they own this number');
    assert.equal(ids[0].body.source, 'website_form');
    assert.ok(/resolution=ignore-duplicates/.test(ids[0].headers.Prefer || ''),
      'if that phone already belongs to someone else we LEAVE IT ALONE - we never steal an identifier');
    assert.ok(ids[0].path.includes('on_conflict=type,value'),
      'without naming identifiers_type_value_uniq, PostgREST infers the PK (a fresh uuid), ' +
      'ignore-duplicates never fires, and a phone owned by someone else raises a raw 23505');
  });

  await t('email-only attaches no second identifier at all', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(wrote(writes, '/rest/v1/identifiers').length, 0);
  });

  await t('phone-only resolves on the phone, with no second identifier', async () => {
    const F = { ...FORM_BOTH, fields: FORM_BOTH.fields.map((f) => (f.key === 'email' ? { ...f, required: false } : f)) };
    const writes = []; mockDb(writes, { form: F }); turnstile(true);
    let sentIds = null;
    const sb = A.sbComms;
    A.sbComms = async (path, env, o = {}) => {
      if (path.includes('resolve_identity')) sentIds = JSON.parse(o.body).p_identifiers;
      return sb(path, env, o);
    };
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', phone: '7709991011', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.deepEqual(sentIds, [{ type: 'phone', value: '+917709991011', is_verified: false }]);
    assert.equal(wrote(writes, '/rest/v1/identifiers').length, 0);
  });

  // -- F4: no PostgREST internals in a public error body -----------------------
  await t('a failed ingest returns a generic error - never the submitter email back to the caller', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    const sb = A.sbComms;
    A.sbComms = async (path, env, o = {}) => {
      if (path.startsWith('/rest/v1/events')) {
        return { ok: false, status: 409, data: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "events_idempotency_key_key"',
          details: 'Key (idempotency_key)=(form:back-in-stock:a@b.com:SKU1) already exists.',
        } };
      }
      return sb(path, env, o);
    };
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'capture_failed');
    assert.equal(r.status, 502, 'the submission was well-formed; OUR write failed - 502, not 400');
    const body = JSON.stringify(r);
    assert.ok(!body.includes('a@b.com'), `the submitter email must not be echoed to an anonymous caller: ${body}`);
    assert.ok(!/idempotency_key|constraint|23505/.test(body), `no DB internals in a public body: ${body}`);
    assert.equal(db.callsTo('form_capture').length, 0, 'no profile, so nothing may be captured against one');
  });

  // -- F5 / 0073 (e): a failed capture is a failure, and it leaves NOTHING behind -
  // Pre-0073 this was "a failed form_submissions insert is not ok:true" — consent had ALREADY been
  // written by then, so the failure left an orphaned DPDP claim with no submission (its evidence).
  // form_capture is one transaction: the consent insert raising AFTER the submission insert must
  // roll back both, answer 502, and let the customer's retry write exactly one set.
  await t('a capture that raises mid-transaction returns 502 and leaves NO submission or consent row', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    db.failNext('form_capture', 'consent');
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.deepEqual(r, { ok: false, error: 'capture_failed', status: 502 });
    assert.equal(db.callsTo('form_capture').length, 1, 'the function ran - and failed');
    assert.equal(db.submissions.length, 0, 'the submission insert must roll back with the consent');
    assert.equal(db.consent.length, 0, 'an orphaned consent claim with no evidence row');
    assert.ok(!/a@b\.com|23503|constraint/.test(JSON.stringify(r)), 'PostgREST detail stays in the log');
  });

  await t('the retry after a failed capture writes exactly ONE submission and ONE consent row', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    db.failNext('form_capture', 'consent');
    const body = { form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' };
    await handleFormSubmit(ENV, req(body));
    const r = await handleFormSubmit(ENV, req(body));
    assert.equal(r.submitted, true, 'the retry is a FIRST submit, not a dedupe against a rolled-back row');
    assert.equal(db.submissions.length, 1);
    assert.equal(db.consent.length, 1);
  });

  await t('an rpc the database never ran (5xx) is also 502 capture_failed, with no rows', async () => {
    const writes = []; const db = mockDb(writes); turnstile(true);
    db.failNext('form_capture', 'call');
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.deepEqual(r, { ok: false, error: 'capture_failed', status: 502 });
    assert.equal(db.submissions.length + db.consent.length, 0);
  });

  // ── confirmation ───────────────────────────────────────────────────────────
  // Confirm is ONE rpc (comms.form_confirm, 0073). The fake holds the submission row the token
  // points at; assertions read the rows the transaction committed.
  const { handleFormConfirm } = require('../src/forms.js');
  const NEWS = { id: 'F9', slug: 'news', consent_copy_version: 3 };
  const confirmDb = (row) => {
    const db = createFakeFormsDb({ forms: [NEWS] });
    const writes = [];
    if (row) db.seedSubmission({ form_id: 'F9', profile_id: 'P1', confirm_token: 'tok123', ...row });
    A.sbComms = async (path, env, o = {}) => {
      if ((o.method || 'GET') !== 'GET') writes.push({ path });
      const rpc = await db.route(path, o);
      if (rpc) return rpc;
      return { ok: true, data: [] };
    };
    return { db, writes };
  };

  await t('confirming stamps confirmed_at and writes the consent row', async () => {
    const { db, writes } = confirmDb({ payload: { email: 'a@b.com' }, channels: ['email'],
      submitted_at: '2026-09-02T09:00:00Z' });
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.deepEqual(r, { ok: true, confirmed: true });
    assert.deepEqual(db.callsTo('form_confirm').map((c) => c.args), [{ p_token: 'tok123' }]);
    assert.deepEqual(writes.map((w) => w.path), ['/rest/v1/rpc/form_confirm'],
      'stamp + consent are ONE transaction - no separate PATCH/POST that can half-land');
    assert.equal(db.consent.length, 1);
    const c = db.consent[0];
    assert.equal(c.state, 'opted_in');
    assert.equal(c.purpose, 'marketing', 'a confirmed ENROLMENT is marketing, unlike a requested alert');
    assert.equal(c.source, 'website_form:news');
    assert.equal(c.evidence.consent_copy_version, 3);
    assert.ok(c.evidence.confirmed_at, 'evidence must carry BOTH timestamps');
    assert.ok(c.evidence.submitted_at);
    assert.ok(db.submissions[0].confirmed_at, 'confirmed_at must be stamped');
  });

  await t('an unknown token is refused (404) and writes nothing', async () => {
    const { db } = confirmDb({ payload: { email: 'a@b.com' }, channels: ['email'] });
    const r = await handleFormConfirm(ENV, 'nope');
    assert.deepEqual(r, { ok: false, error: 'invalid_token', status: 404 });
    assert.equal(db.consent.length, 0);
    assert.equal(db.submissions[0].confirmed_at, null, 'someone else\'s row must be untouched');
  });

  await t('an empty token never reaches the database', async () => {
    const { db } = confirmDb(null);
    const r = await handleFormConfirm(ENV, '   ');
    assert.deepEqual(r, { ok: false, error: 'invalid_token', status: 400 });
    assert.equal(db.calls.length, 0);
  });

  await t('confirming twice is idempotent — no second consent row', async () => {
    const { db } = confirmDb({ confirmed_at: '2026-09-02T10:00:00Z', payload: { email: 'a@b.com' }, channels: ['email'] });
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.deepEqual(r, { ok: true, confirmed: true, already: true });
    assert.equal(db.consent.length, 0);
    assert.equal(db.submissions[0].confirmed_at, '2026-09-02T10:00:00Z', 'the first stamp is the evidence - never moved');
  });

  // -- F2: confirmation must never invent a channel the customer declined -------
  // /!\ THE BUG THIS EXISTS TO PREVENT: reconstructing the chosen channels from field
  // PRESENCE at confirm time. Someone who typed BOTH an email and a WhatsApp number but
  // ticked only "email" was written a whatsapp/marketing/opted_in row they had declined --
  // fabricated DPDP evidence. Choice is not derivable from presence; it must be persisted
  // (migration 0060) and read back.
  await t('capture persists the CHOSEN channels on the submission row', async () => {
    const writes = []; const db = mockDb(writes, { form: { ...FORM_BOTH, requires_confirmation: true } }); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok',
      email: 'a@b.com', phone: '7709991011', product_code: 'SKU1', channels: ['email'] }));
    assert.equal(r.ok, true);
    assert.deepEqual(db.callsTo('form_capture')[0].args.p_channels, ['email'],
      'p_channels is the CHOICE, not every identifier the payload carries');
    assert.deepEqual(db.submissions[0].channels, ['email'],
      'without this column confirm can only guess, and guessing opts people into what they refused');
    assert.equal(db.consent.length, 0, 'still no consent until they confirm');
  });

  await t('confirm writes exactly ONE consent row, on the channel actually chosen', async () => {
    // The row carries channels:['email'] even though the payload has BOTH an email and a phone
    // -- which is precisely what the old derivation read.
    const { db } = confirmDb({ payload: { email: 'a@b.com', phone: '+917709991011', product_code: 'SKU1' },
      channels: ['email'], submitted_at: '2026-09-02T09:00:00Z' });
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.equal(r.ok, true);
    assert.equal(db.consent.length, 1,
      'the payload has a phone too - deriving from presence writes a whatsapp row they declined');
    assert.equal(db.consent[0].channel, 'email');
    assert.equal(db.consent[0].purpose, 'marketing');
  });

  await t('capture -> confirm end to end: the minted token confirms the chosen channel only', async () => {
    const writes = []; const db = mockDb(writes, { form: { ...FORM_BOTH, requires_confirmation: true } }); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok',
      email: 'a@b.com', phone: '7709991011', product_code: 'SKU1', channels: ['whatsapp'] }));
    const token = db.submissions[0].confirm_token;
    assert.match(token, /^[0-9a-f]{32}$/);
    const r = await handleFormConfirm(ENV, token);
    assert.deepEqual(r, { ok: true, confirmed: true });
    assert.deepEqual(db.consent.map((c) => [c.channel, c.purpose, c.profile_id]), [['whatsapp', 'marketing', 'P1']]);
  });

  await t('a pre-0060 row (channels null) still falls back to presence, so old links keep working', async () => {
    const { db } = confirmDb({ channels: null, payload: { email: 'a@b.com' }, submitted_at: '2026-09-01T09:00:00Z' });
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.equal(r.ok, true);
    assert.equal(db.consent.length, 1);
    assert.equal(db.consent[0].channel, 'email');
  });

  A.sbComms = origSb; globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
