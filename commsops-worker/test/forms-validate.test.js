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

t('payload carries only declared field keys', () => {
  const r = validateSubmission(FORM, { email: 'a@b.com', product_code: 'X', evil: 'drop me' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.evil, undefined);
  assert.equal(r.payload.product_code, 'X');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
