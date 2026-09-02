// test/forms-validate.test.js — the pure validation half of the capture spine (S331 SP1).
// Sync-only, no DB: validateSubmission must never touch the network.
const assert = require('assert');
const { validateSubmission } = require('../src/forms.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

const FORM = {
  slug: 'back-in-stock',
  active: true,
  fields: [
    { key: 'product_code', label: 'Product', type: 'hidden', required: true },
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'phone', label: 'WhatsApp', type: 'tel', required: false },
  ],
  dedupe_keys: ['product_code'],
};

t('honeypot is rejected', () => {
  const r = validateSubmission(FORM, { website: 'bot', email: 'a@b.com', product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'honeypot');
});

t('inactive form is rejected', () => {
  const r = validateSubmission({ ...FORM, active: false }, { email: 'a@b.com', product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'form_inactive');
});

t('a missing required field is rejected, and names the field', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_field:product_code');
});

t('a malformed email is rejected', () => {
  const r = validateSubmission(FORM, { email: 'not-an-email', product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad_email');
});

t('no reachable channel is rejected', () => {
  const r = validateSubmission({ ...FORM, fields: [{ key: 'product_code', type: 'hidden', required: true }] },
    { product_code: 'X' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'email_or_phone_required');
});

t('email only defaults to the email channel', () => {
  const r = validateSubmission(FORM, { email: 'A@B.com ', product_code: 'X' });
  assert.equal(r.ok, true);
  assert.equal(r.email, 'a@b.com');
  assert.deepEqual(r.channels, ['email']);
});

t('email + phone yields both channels, email first', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', phone: '7709991011', product_code: 'X' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels, ['email', 'whatsapp']);
});

t('a channel we cannot reach is dropped, never recorded', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', channels: ['email', 'whatsapp'], product_code: 'X' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels, ['email'], 'whatsapp must be dropped when no phone was given');
});

// ── F3: channels are DEDUPED ──────────────────────────────────────────────────
// ⚠️ `consent` is an append-only ledger, so a duplicated channel is a duplicated ROW. One
// anonymous POST could write hundreds of identical opted_in rows into DPDP evidence.
t('a channel repeated 500 times collapses to one — not 500 consent rows', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', product_code: 'X', channels: new Array(500).fill('email') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels, ['email'],
    '500 entries here become 500 identical rows in the append-only consent ledger');
});

t('deduping keeps every distinct channel, in first-seen order', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', phone: '7709991011', product_code: 'X',
    channels: ['whatsapp', 'email', 'whatsapp', 'email'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels, ['whatsapp', 'email'],
    'dedupe must not drop a real choice, nor reorder what the customer picked');
});

t('payload carries only declared field keys', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', product_code: 'X', evil: 'drop me' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.evil, undefined);
  assert.equal(r.payload.product_code, 'X');
});

// ── dedupeKey ────────────────────────────────────────────────────────────────
// ⚠️ THE BUG THIS EXISTS TO PREVENT: keying on identity alone. The same customer
// legitimately asks to be notified about five different SKUs, and a
// `form:<slug>:<email>` key would silently swallow four of them.
const { dedupeKey } = require('../src/forms.js');

t('dedupe key includes the declared dedupe field', () => {
  const v = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU1' });
  assert.equal(dedupeKey(FORM, v), 'back-in-stock:a@b.com:SKU1');
});

t('same person, different product -> different keys', () => {
  const a = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU1' });
  const b = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU2' });
  assert.notEqual(dedupeKey(FORM, a), dedupeKey(FORM, b));
});

t('same person, same product -> identical keys', () => {
  const a = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU1' });
  const b = validateSubmission(FORM, { email: 'A@B.com', product_code: 'SKU1' });
  assert.equal(dedupeKey(FORM, a), dedupeKey(FORM, b));
});

t('phone-only identity keys on the phone', () => {
  // ⚠️ FORM requires email, so a phone-only body would be REJECTED and dedupeKey would then be
  // handed {ok:false} with no .payload. Use a form where email is optional (caught 2026-09-02
  // by running this suite against the implementation — it threw a TypeError).
  const F = { ...FORM, fields: FORM.fields.map((f) => (f.key === 'email' ? { ...f, required: false } : f)) };
  const v = validateSubmission(F, { phone: '7709991011', product_code: 'SKU1' });
  assert.equal(v.ok, true, 'fixture must validate before a key can be derived');
  assert.equal(dedupeKey(F, v), 'back-in-stock:+917709991011:SKU1');
});

t('dedupeKey refuses an invalid submission instead of throwing', () => {
  const bad = validateSubmission(FORM, { product_code: 'SKU1' });   // no email -> {ok:false}
  assert.equal(bad.ok, false);
  assert.equal(dedupeKey(FORM, bad), null, 'must not read .payload off a rejected submission');
});

t('no dedupe_keys -> null, so every submission is kept', () => {
  const f = { ...FORM, dedupe_keys: [] };
  const v = validateSubmission(f, { email: 'a@b.com', product_code: 'SKU1' });
  assert.equal(dedupeKey(f, v), null);
});

t('identity precedence is email-first, so adding a phone later does not fork the key', () => {
  const emailOnly = validateSubmission(FORM, { email: 'a@b.com', product_code: 'SKU1' });
  const withPhone = validateSubmission(FORM, { email: 'a@b.com', phone: '7709991011', product_code: 'SKU1' });
  assert.equal(dedupeKey(FORM, emailOnly), dedupeKey(FORM, withPhone),
    'adding a phone must not change the key, or the same person dedupes twice');
  assert.equal(dedupeKey(FORM, withPhone), 'back-in-stock:a@b.com:SKU1');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
