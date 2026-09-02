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
    if (method !== 'GET') writes.push({ path, method, body: o.body ? JSON.parse(o.body) : null });
    if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [opts.form || FORM_ROW] };
    if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
    if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E1' }] };
    if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [] };
    if (path.startsWith('/rest/v1/form_submissions')) return { ok: true, data: [{ id: 'S1' }] };
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
  });

  await t('a confirmation-required form writes NO consent row at capture', async () => {
    const writes = []; mockDb(writes, { form: { ...FORM_ROW, requires_confirmation: true } }); turnstile(true);
    const r = await handleFormSubmit(ENV, req({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com', product_code: 'SKU1' }));
    assert.equal(r.ok, true);
    assert.equal(wrote(writes, '/consent').length, 0, 'consent must wait for confirmation');
    assert.ok(wrote(writes, '/form_submissions')[0].body.confirm_token, 'must mint a confirm token');
  });

  A.sbComms = origSb; globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
