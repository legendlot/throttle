// validateSignup — the pure gatekeeper for the public /subscribe seam. Everything that
// reaches ingest/consent flows through this, so its edges ARE the endpoint's edges.
const assert = require('assert');
const { validateSignup } = require('../src/subscribe.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n        ', e.message); }
};

t('email-only signup → email channel', () => {
  const v = validateSignup({ list: 'drift2-launch', email: 'A@B.co' });
  assert.equal(v.ok, true);
  assert.equal(v.email, 'a@b.co');
  assert.deepEqual(v.channels, ['email']);
});

t('phone-only signup → whatsapp channel', () => {
  const v = validateSignup({ list: 'drift2-launch', phone: '7709991011' });
  assert.equal(v.ok, true);
  assert.ok(v.phone && v.phone.includes('7709991011'));
  assert.deepEqual(v.channels, ['whatsapp']);
});

t('both identifiers default to both channels', () => {
  const v = validateSignup({ list: 'x1', email: 'a@b.co', phone: '7709991011' });
  assert.deepEqual(v.channels, ['email', 'whatsapp']);
});

t('requested whatsapp without a phone is dropped, email kept', () => {
  const v = validateSignup({ list: 'x1', email: 'a@b.co', channels: ['whatsapp', 'email'] });
  assert.deepEqual(v.channels, ['email']);
});

t('whatsapp-only request without a phone → no_usable_channel', () => {
  const v = validateSignup({ list: 'x1', email: 'a@b.co', channels: ['whatsapp'] });
  assert.equal(v.error, 'no_usable_channel');
});

t('list slug is normalized + validated', () => {
  assert.equal(validateSignup({ list: 'Drift2-Launch', email: 'a@b.co' }).list, 'drift2-launch');
  assert.equal(validateSignup({ list: 'bad slug!', email: 'a@b.co' }).error, 'bad_list');
  assert.equal(validateSignup({ email: 'a@b.co' }).error, 'bad_list');
});

t('bad email rejected; missing both identifiers rejected', () => {
  assert.equal(validateSignup({ list: 'x1', email: 'not-an-email' }).error, 'bad_email');
  assert.equal(validateSignup({ list: 'x1' }).error, 'email_or_phone_required');
});

t('honeypot field trips silently', () =>
  assert.equal(validateSignup({ list: 'x1', email: 'a@b.co', website: 'http://spam' }).error, 'honeypot'));

t('unknown channel names are ignored, not fatal', () => {
  const v = validateSignup({ list: 'x1', email: 'a@b.co', channels: ['carrier_pigeon', 'email'] });
  assert.deepEqual(v.channels, ['email']);
});

t('name + source_url pass through trimmed/capped', () => {
  const v = validateSignup({ list: 'x1', email: 'a@b.co', name: '  Afshaan  ', source_url: 'https://legendoftoys.com/pages/drift2' });
  assert.equal(v.name, 'Afshaan');
  assert.equal(v.source_url, 'https://legendoftoys.com/pages/drift2');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
