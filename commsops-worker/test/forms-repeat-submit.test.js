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
//
// ⭐ Since 0073 the dedupe lives INSIDE comms.form_capture (ON CONFLICT + a row lock), so the
// tests drive the in-memory emulation of that function and assert on the rows it commits.
const assert = require('assert');
const A = require('../src/auth.js');
const { handleFormSubmit } = require('../src/forms.js');
const { createFakeFormsDb } = require('./_fake-forms-rpc.js');
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
const KEY = 'back-in-stock:a@b.com:V1';

// `existing` seeds a submission with this dedupe key ALREADY in the table, carrying `storedChannels`.
function db({ existing = false, storedChannels = ['email'] } = {}) {
  const d = createFakeFormsDb({ forms: [FORM] });
  if (existing) d.seedSubmission({ form_id: FORM.id, profile_id: 'P1', dedupe_key: KEY, channels: storedChannels });
  A.sbComms = async (path, env, opts) => {
    const rpc = await d.route(path, opts);
    if (rpc) return rpc;
    if (path.startsWith('/rest/v1/forms')) return { ok: true, data: [FORM] };
    if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
    return { ok: true, data: [] };
  };
  return d;
}
const ENV = { TURNSTILE_SECRET: 's', FORM_IP_HASH_SALT: 'salt' };
const submit = () => handleFormSubmit(ENV,
  { json: async () => ({ form: 'back-in-stock', turnstile_token: 'tok',
      email: 'a@b.com', product_code: 'V1' }),
    headers: { get: (h) => (String(h).toLowerCase() === 'cf-connecting-ip' ? '203.0.113.9' : null) } });
const submitBoth = () => handleFormSubmit(ENV,
  { json: async () => ({ form: 'back-in-stock', turnstile_token: 'tok', email: 'a@b.com',
      phone: '+919876543210', product_code: 'V1', channels: ['email', 'whatsapp'] }),
    headers: { get: () => null } });

(async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });

  await t('FIRST submit writes consent and inserts', async () => {
    const d = db({ existing: false });
    const r = await submit();
    assert.equal(r.submitted, true);
    assert.equal(d.consent.length, 1, 'first submit must record consent');
    assert.equal(d.submissions.length, 1);
    assert.equal(d.submissions[0].dedupe_key, KEY);
  });

  await t('REPEAT submit writes NO consent row (the production defect)', async () => {
    const d = db({ existing: true });
    const r = await submit();
    assert.equal(r.ok, true, 'the customer still sees success');
    assert.equal(r.deduped, true);
    assert.equal(d.consent.length, 0, 'a repeat submit must not append a duplicate opted_in row');
  });

  // Was "does not even attempt the insert" — the separate insert call is gone; the insert now
  // happens ON CONFLICT DO NOTHING inside the function. The intent is the outcome: one row, untouched.
  await t('REPEAT submit leaves exactly ONE submission row, its channels untouched', async () => {
    const d = db({ existing: true });
    await submit();
    assert.equal(d.submissions.length, 1);
    assert.deepEqual(d.submissions[0].channels, ['email']);
  });

  // ⭐ 0073 (e), the half the old read-then-act check could never close: two simultaneous FIRST
  // submits both read "nothing on file" and both wrote consent. The unique index + row lock now
  // serialise them: one inserts, the other is a repeat.
  await t('two concurrent FIRST submits write ONE submission and ONE consent row', async () => {
    const d = db({ existing: false });
    const [r1, r2] = await Promise.all([submit(), submit()]);
    assert.equal(d.submissions.length, 1);
    assert.equal(d.consent.length, 1, `two simultaneous first submits wrote ${d.consent.length} consent rows`);
    assert.deepEqual([r1, r2].map((r) => !!r.deduped).sort(), [false, true], 'one lands, one is the repeat');
  });

  // Was "an UNREADABLE dupe check fails OPEN". There is no separate dupe read to fail any more, so
  // the intent — a genuine first signup is never silently lost to the dedupe machinery — becomes:
  // a failed capture is LOUD (502, never a false ok), leaves nothing, and the retry lands in full.
  await t('a failed first capture is 502 with no rows, and the retry lands the signup exactly once', async () => {
    const d = db({ existing: false });
    d.failNext('form_capture', 'consent');
    const r1 = await submit();
    assert.deepEqual(r1, { ok: false, error: 'capture_failed', status: 502 });
    assert.equal(d.submissions.length + d.consent.length, 0, 'a failure must not half-land');
    const r2 = await submit();
    assert.equal(r2.submitted, true, 'the rolled-back row must not make the retry look like a repeat');
    assert.equal(d.submissions.length, 1);
    assert.equal(d.consent.length, 1);
  });

  // ⛔ THE CASE THAT MAKES THE SHORT-CIRCUIT SAFE (hostile-review finding 1). Channels are NOT in
  // the dedupe key, so "same key" does not mean "same request". A customer who returns and ticks
  // WhatsApp must get a whatsapp consent row — otherwise the phone is attached, the gate refuses
  // the alert, and the widget still says "You're on the list".
  await t('repeat + a NEW channel is NOT short-circuited — consent for the new channel only', async () => {
    const d = db({ existing: true, storedChannels: ['email'] });
    const r = await submitBoth();
    assert.notEqual(r.deduped, true, 'must NOT short-circuit when a new channel is requested');
    assert.deepEqual(d.callsTo('form_capture')[0].args.p_channels, ['email', 'whatsapp'],
      'the handler hands the function the FULL choice; the function works out what is new');
    assert.deepEqual(d.consent.map((c) => c.channel), ['whatsapp'],
      'exactly the NEW channel — never re-writing the one already on file');
    assert.equal(d.consent[0].purpose, 'service');
  });

  await t('the stored row is widened to the union, so it stops disagreeing with consent', async () => {
    const d = db({ existing: true, storedChannels: ['email'] });
    await submitBoth();
    assert.equal(d.submissions.length, 1, 'widened in place, not a second row');
    assert.deepEqual(d.submissions[0].channels, ['email', 'whatsapp']);
  });

  // Replaces the old widen-PATCH path: widen + its consent row are one transaction now, so a
  // failure between them can no longer leave a widened row with no whatsapp consent (or vice versa).
  await t('a widen that fails mid-transaction leaves the row AND the ledger as they were', async () => {
    const d = db({ existing: true, storedChannels: ['email'] });
    d.failNext('form_capture', 'consent');
    const r = await submitBoth();
    assert.deepEqual(r, { ok: false, error: 'capture_failed', status: 502 });
    assert.deepEqual(d.submissions[0].channels, ['email'], 'widen rolled back with the consent insert');
    assert.equal(d.consent.length, 0);
  });

  await t('repeat with the SAME channels still short-circuits', async () => {
    const d = db({ existing: true, storedChannels: ['email'] });
    const r = await submit();
    assert.deepEqual(r, { ok: true, deduped: true });
    assert.equal(d.consent.length, 0);
  });

  A.sbComms = orig; globalThis.fetch = origFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
