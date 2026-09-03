// test/forms-submit.test.js — the write path of the public capture surface (S331 SP1).
// The four tables a submission can touch: profiles, identifiers (via resolve_identity),
// consent, form_submissions. A refused submission must write to NONE of them.
const assert = require('assert');
const A = require('../src/auth.js');
const { handleFormSubmit } = require('../src/forms.js');

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

// Records every write so a test can assert on what was NOT written.
function mockDb(writes, opts = {}) {
  A.sbComms = async (path, env, o = {}) => {
    const method = o.method || 'GET';
    if (method !== 'GET') writes.push({ path, method, headers: o.headers || {}, body: o.body ? JSON.parse(o.body) : null });
    if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [opts.form || FORM_ROW] };
    if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
    if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E1' }] };
    if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [] };
    // ⚠️ TWO DIFFERENT CALLS hit this table and they must not share one answer (S342).
    // The GET is the repeat-submit dupe check — answering it with a row makes EVERY submission
    // look like a duplicate and silently short-circuits the whole write path. Only the POST is
    // the insert. (An over-broad stub hid a new code path here; the same thing happened to
    // forms-turnstile's DOM stub in the same session.)
    if (path.startsWith('/rest/v1/form_submissions')) {
      return method === 'POST'
        ? { ok: true, data: [{ id: 'S1' }] }   // the insert
        : { ok: true, data: [] };              // dupe check: nothing on file yet
    }
    if (path.startsWith('/rest/v1/profiles')) return { ok: true, data: [{ attributes: {} }] };
    return { ok: true, data: [] };
  };
}
const req = (body, headers = {}) => new Request('https://x/f/submit', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const turnstile = (success) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ success }) }); };
const wrote = (writes, frag) => writes.filter((w) => w.path.includes(frag));

(async () => {
  await t('a happy submission writes an event, a consent row and a submission', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.equal(wrote(writes, '/events').length, 1);
    assert.equal(wrote(writes, '/consent').length, 1);
    assert.equal(wrote(writes, '/form_submissions').length, 1);
  });

  await t('consent is purpose `service`, opted_in, with versioned evidence', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    const c = wrote(writes, '/consent')[0].body;
    assert.equal(c.purpose, 'service', 'a requested alert is `service` — NOT a new product_alert purpose');
    assert.equal(c.state, 'opted_in');
    assert.equal(c.source, 'website_form:back-in-stock');
    assert.equal(c.evidence.consent_copy_version, 2);
    assert.equal(c.evidence.turnstile_ok, true);
  });

  await t('a FAILED turnstile writes NOTHING to any of the four tables', async () => {
    const writes = []; mockDb(writes); turnstile(false);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'bad', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, false);
    assert.equal(r.error, 'challenge_failed');
    assert.equal(writes.length, 0, `expected zero writes, got ${JSON.stringify(writes)}`);
  });

  await t('the honeypot lies to the bot and writes nothing', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1', website: 'spam' }));
    assert.equal(r.ok, true, 'must look like success so the bot learns nothing');
    assert.equal(writes.length, 0);
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
    const writes = []; mockDb(writes); turnstile(true);
    let sentIds = null;
    const sb = A.sbComms;
    A.sbComms = async (path, env, o = {}) => {
      if (path.includes('resolve_identity')) { sentIds = JSON.parse(o.body).p_identifiers; return { ok: true, data: 'EXISTING' }; }
      return sb(path, env, o);
    };
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.deepEqual(sentIds, [{ type: 'email', value: 'a@b.com', is_verified: false }],
      'identity must go through resolve_identity — never a second resolver');
    assert.equal(wrote(writes, '/form_submissions')[0].body.profile_id, 'EXISTING');
  });

  await t('the dedupe key reaches BOTH the ingest key and the submission row', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(wrote(writes, '/events')[0].body.idempotency_key, 'form:back-in-stock:a@b.com:SKU1');
    assert.equal(wrote(writes, '/form_submissions')[0].body.dedupe_key, 'back-in-stock:a@b.com:SKU1');
    const sub = wrote(writes, '/form_submissions')[0];
    assert.ok(sub.path.includes('on_conflict=form_id,dedupe_key'),
      'without on_conflict PostgREST infers the PK (a fresh uuid) and dedupe silently never fires');
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
    const writes = []; mockDb(writes, { form: { ...FORM_ROW, requires_confirmation: true } }); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.equal(wrote(writes, '/consent').length, 0, 'consent must wait for confirmation');
    assert.ok(wrote(writes, '/form_submissions')[0].body.confirm_token, 'must mint a confirm token');
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
    const writes = []; mockDb(writes); turnstile(true);
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
  });

  // -- F5: a failed submission insert must not be reported as success ----------
  await t('a failed form_submissions insert is reported as a failure, not ok:true', async () => {
    const writes = []; mockDb(writes); turnstile(true);
    const sb = A.sbComms;
    A.sbComms = async (path, env, o = {}) => {
      if (path.startsWith('/rest/v1/form_submissions') && (o.method || 'GET') !== 'GET') {
        return { ok: false, status: 500, data: { message: 'could not write' } };
      }
      return sb(path, env, o);
    };
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, false,
      'the consent row (the DPDP claim) is already written and the submission row is where its ' +
      'evidence lives - an orphaned claim must never be answered with success');
    assert.equal(r.error, 'capture_failed');
    assert.equal(r.status, 502);
  });

  // ── confirmation ───────────────────────────────────────────────────────────
  const { handleFormConfirm } = require('../src/forms.js');

  await t('confirming stamps confirmed_at and writes the consent row', async () => {
    const writes = [];
    A.sbComms = async (path, env, o = {}) => {
      const method = o.method || 'GET';
      if (method !== 'GET') writes.push({ path, method, headers: o.headers || {}, body: o.body ? JSON.parse(o.body) : null });
      if (path.startsWith('/rest/v1/form_submissions')) {
        return { ok: true, data: [{ id: 'S1', form_id: 'F1', profile_id: 'P1', confirmed_at: null,
          payload: { email: 'a@b.com' }, source_url: null,
          submitted_at: '2026-09-02T09:00:00Z',
          forms: { slug: 'news', consent_copy_version: 3 } }] };
      }
      if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.equal(r.ok, true);
    const c = writes.filter((w) => w.path.includes('/consent'))[0].body;
    assert.equal(c.state, 'opted_in');
    assert.equal(c.purpose, 'marketing', 'a confirmed ENROLMENT is marketing, unlike a requested alert');
    assert.ok(c.evidence.confirmed_at, 'evidence must carry BOTH timestamps');
    assert.ok(c.evidence.submitted_at);
    assert.ok(writes.some((w) => w.method === 'PATCH' && w.body.confirmed_at));
  });

  await t('an unknown token is refused and writes nothing', async () => {
    const writes = [];
    A.sbComms = async (path, env, o = {}) => {
      if ((o.method || 'GET') !== 'GET') writes.push({ path });
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'nope');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_token');
    assert.equal(writes.length, 0);
  });

  await t('confirming twice is idempotent — no second consent row', async () => {
    const writes = [];
    A.sbComms = async (path, env, o = {}) => {
      if ((o.method || 'GET') !== 'GET') writes.push({ path });
      if (path.startsWith('/rest/v1/form_submissions')) {
        return { ok: true, data: [{ id: 'S1', form_id: 'F1', profile_id: 'P1',
          confirmed_at: '2026-09-02T10:00:00Z', payload: { email: 'a@b.com' },
          forms: { slug: 'news', consent_copy_version: 3 } }] };
      }
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.equal(r.ok, true);
    assert.equal(writes.filter((w) => w.path.includes('/consent')).length, 0);
  });

  // -- F2: confirmation must never invent a channel the customer declined -------
  // /!\ THE BUG THIS EXISTS TO PREVENT: reconstructing the chosen channels from field
  // PRESENCE at confirm time. Someone who typed BOTH an email and a WhatsApp number but
  // ticked only "email" was written a whatsapp/marketing/opted_in row they had declined --
  // fabricated DPDP evidence. Choice is not derivable from presence; it must be persisted
  // (migration 0060) and read back.
  await t('capture persists the CHOSEN channels on the submission row', async () => {
    const writes = []; mockDb(writes, { form: { ...FORM_BOTH, requires_confirmation: true } }); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok',
      email: 'a@b.com', phone: '7709991011', product_code: 'SKU1', channels: ['email'] }));
    assert.equal(r.ok, true);
    const sub = wrote(writes, '/form_submissions')[0].body;
    assert.deepEqual(sub.channels, ['email'],
      'without this column confirm can only guess, and guessing opts people into what they refused');
    assert.equal(wrote(writes, '/consent').length, 0, 'still no consent until they confirm');
  });

  await t('confirm writes exactly ONE consent row, on the channel actually chosen', async () => {
    // The row is the one capture just wrote (channels:['email']) even though the payload
    // carries BOTH an email and a phone -- which is precisely what the old derivation read.
    const writes = [];
    const captured = { id: 'S1', form_id: 'F1', profile_id: 'P1', confirmed_at: null,
      payload: { email: 'a@b.com', phone: '+917709991011', product_code: 'SKU1' },
      channels: ['email'], source_url: null, submitted_at: '2026-09-02T09:00:00Z',
      forms: { slug: 'news', consent_copy_version: 3 } };
    A.sbComms = async (path, env, o = {}) => {
      const method = o.method || 'GET';
      if (method !== 'GET') writes.push({ path, method, body: o.body ? JSON.parse(o.body) : null });
      if (path.startsWith('/rest/v1/form_submissions')) return { ok: true, data: [captured] };
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'tok123');
    assert.equal(r.ok, true);
    const consents = writes.filter((w) => w.path.includes('/consent'));
    assert.equal(consents.length, 1,
      'the payload has a phone too - deriving from presence writes a whatsapp row they declined');
    assert.equal(consents[0].body.channel, 'email');
    assert.equal(consents[0].body.purpose, 'marketing');
  });

  await t('a pre-0060 row (channels null) still falls back to presence, so old links keep working', async () => {
    const writes = [];
    A.sbComms = async (path, env, o = {}) => {
      const method = o.method || 'GET';
      if (method !== 'GET') writes.push({ path, method, body: o.body ? JSON.parse(o.body) : null });
      if (path.startsWith('/rest/v1/form_submissions')) {
        return { ok: true, data: [{ id: 'S2', form_id: 'F1', profile_id: 'P1', confirmed_at: null,
          channels: null, payload: { email: 'a@b.com' }, submitted_at: '2026-09-01T09:00:00Z',
          forms: { slug: 'news', consent_copy_version: 3 } }] };
      }
      return { ok: true, data: [] };
    };
    const r = await handleFormConfirm(ENV, 'old-token');
    assert.equal(r.ok, true);
    const consents = writes.filter((w) => w.path.includes('/consent'));
    assert.equal(consents.length, 1);
    assert.equal(consents[0].body.channel, 'email');
  });

  A.sbComms = origSb; globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
