// test/forms-repeat-submit.test.js — S342.
// A REPEAT submit of the same (form, identity, dedupe fields) must write NOTHING — not a second
// submission row, and not a second consent row.
//
// ⭐ FOUND IN PRODUCTION, NOT IN REVIEW. The first real end-to-end test of the capture spine
// (2026-09-03) submitted the same email+product twice. The `on_conflict` insert correctly refused
// the second SUBMISSION — but the consent loop runs before it and unconditionally, so the ledger
// got TWO identical `website_form:back-in-stock` opted_in rows for one person and one product.
// The customer's consent STATE was never wrong; `consent` is an append-only evidence ledger, so
// the damage is an inflated count of "who opted in via this form" and a muddied audit trail.
//
// This is the across-request half of the S331 within-request fix (`Array(500).fill('email')` → Set).
const assert = require('assert');
const A = require('../src/auth.js');
const { handleFormSubmit } = require('../src/forms.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms, origFetch = globalThis.fetch;

const FORM = {
  id: 'form-1', slug: 'back-in-stock', active: true, requires_confirmation: false,
  consent_copy_version: 1, dedupe_keys: ['product_code'],
  fields: [
    { key: 'product_code', type: 'hidden', required: true },
    { key: 'email', type: 'email', required: true },
    { key: 'phone', type: 'tel', required: false },
  ],
};

// `existing` models whether a submission with this dedupe key is ALREADY in the table.
function db({ existing = false, dupeReadFails = false, storedChannels = ['email'] } = {}) {
  const w = { consent: 0, inserts: 0, dupeReads: 0, consentChannels: [], widened: null };
  A.sbComms = async (path, env, opts) => {
    if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [FORM] };
    if (path.startsWith('/rest/v1/form_submissions?form_id=') && !opts) {
      w.dupeReads++;
      // ⚠️ data is NON-EMPTY on the failure fixture, deliberately (S342 hostile review):
      // with `data: null` the `dupe.ok &&` guard was untested — dropping it left the suite green,
      // because null is falsy either way. A 500 that still carries a body is the real hazard.
      // ⚠️ The garbage body must look like a COVERING match (channels ⊇ requested), or the
      // channel-aware fall-through masks the missing `dupe.ok` guard and the test goes vacuous
      // again — which is exactly what happened on the first attempt at hardening this.
      if (dupeReadFails) return { ok: false, status: 500, data: [{ id: 'garbage', channels: ['email'] }] };
      return { ok: true, data: existing ? [{ id: 'existing-row', channels: storedChannels }] : [] };
    }
    if (path.startsWith('/rest/v1/form_submissions') && opts?.method === 'POST') {
      w.inserts++; return { ok: true, data: existing ? [] : [{ id: 'new-row' }] };
    }
    if (path.startsWith('/rest/v1/consent')) {
      w.consent++; w.consentChannels.push(JSON.parse(opts.body).channel); return { ok: true, data: [{}] };
    }
    if (path.startsWith('/rest/v1/form_submissions?id=') && opts?.method === 'PATCH') {
      w.widened = JSON.parse(opts.body).channels; return { ok: true, data: [{}] };
    }
    return { ok: true, data: [] };
  };
  return w;
}
const submit = () => handleFormSubmit(
  { TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt' },
  { json: async () => ({ form: 'back-in-stock', turnstile_token: 'tok',
      email: 'a@b.com', product_code: 'V1' }),
    headers: { get: (h) => (String(h).toLowerCase() === 'cf-connecting-ip' ? '203.0.113.9' : null) } });

(async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });

  await t('FIRST submit writes consent and inserts', async () => {
    const w = db({ existing: false });
    const r = await submit();
    assert.equal(r.ok, true);
    assert.equal(w.consent, 1, 'first submit must record consent');
    assert.equal(w.inserts, 1);
  });

  await t('REPEAT submit writes NO consent row (the production defect)', async () => {
    const w = db({ existing: true });
    const r = await submit();
    assert.equal(r.ok, true, 'the customer still sees success');
    assert.equal(r.deduped, true);
    assert.equal(w.consent, 0, 'a repeat submit must not append a duplicate opted_in row');
  });

  await t('REPEAT submit does not even attempt the insert', async () => {
    const w = db({ existing: true });
    await submit();
    assert.equal(w.inserts, 0);
  });

  // The check is a nicety, not a security control: losing a real signup because a SELECT failed
  // is strictly worse than the duplicate row it exists to avoid.
  await t('an UNREADABLE dupe check fails OPEN — the signup still lands', async () => {
    const w = db({ existing: false, dupeReadFails: true });
    const r = await submit();
    assert.equal(r.ok, true);
    assert.equal(w.consent, 1, 'must not drop a genuine first submission on a read failure');
    assert.equal(w.inserts, 1);
  });

  // ⛔ THE CASE THAT MAKES THE SHORT-CIRCUIT SAFE (hostile-review finding 1). Channels are NOT in
  // the dedupe key, so "same key" does not mean "same request". A customer who returns and ticks
  // WhatsApp must get a whatsapp consent row — otherwise the phone is attached, the gate refuses
  // the alert, and the widget still says "You're on the list".
  await t('repeat + a NEW channel is NOT short-circuited — consent for the new channel only', async () => {
    const w = db({ existing: true, storedChannels: ['email'] });
    const r = await handleFormSubmit(
      { TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt' },
      { json: async () => ({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com',
          phone: '+919876543210', product_code: 'V1', channels: ['email', 'whatsapp'] }),
        headers: { get: () => null } });
    assert.notEqual(r.deduped, true, 'must NOT short-circuit when a new channel is requested');
    assert.deepEqual(w.consentChannels, ['whatsapp'],
      'exactly the NEW channel — never re-writing the one already on file');
  });

  await t('the stored row is widened to the union, so it stops disagreeing with consent', async () => {
    const w = db({ existing: true, storedChannels: ['email'] });
    await handleFormSubmit(
      { TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt' },
      { json: async () => ({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com',
          phone: '+919876543210', product_code: 'V1', channels: ['email', 'whatsapp'] }),
        headers: { get: () => null } });
    assert.deepEqual(w.widened, ['email', 'whatsapp']);
  });

  await t('repeat with the SAME channels still short-circuits', async () => {
    const w = db({ existing: true, storedChannels: ['email'] });
    const r = await submit();
    assert.equal(r.deduped, true);
    assert.equal(w.consent, 0);
  });

  A.sbComms = orig; globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
