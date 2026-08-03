// Phone rendering for TrustSignal SMS (F1). The naive "last 10 digits" version sends
// international numbers to unrelated Indian mobiles, silently. Live data 2026-08-03:
// 82,964 +91 · 177 non-+91 · 1 malformed +91.
// Run: node test/trustsignal-phone.test.js
const assert = require('assert');
const { renderPhoneForSms } = require('../src/trustsignal-client.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

t('a well-formed +91 renders to bare 10 digits', () => {
  assert.deepStrictEqual(renderPhoneForSms('+919876543210'), { ok: true, value: '9876543210' });
});

t('a US number is REJECTED, never truncated', () => {
  const r = renderPhoneForSms('+14155550123');
  assert.strictEqual(r.ok, false, 'must not send');
  assert.strictEqual(r.reason, 'unsupported_country');
  assert.ok(!('value' in r) || r.value == null, 'must not emit a dialable value');
});

t('a UK number is REJECTED', () => {
  assert.strictEqual(renderPhoneForSms('+447700900123').reason, 'unsupported_country');
});

t('a malformed +91 (wrong length) is REJECTED, not repaired', () => {
  assert.strictEqual(renderPhoneForSms('+9198765').reason, 'invalid_phone');
  assert.strictEqual(renderPhoneForSms('+91987654321012').reason, 'invalid_phone');
});

t('a value with no + is REJECTED — we store canonical E.164 only', () => {
  assert.strictEqual(renderPhoneForSms('9876543210').reason, 'invalid_phone');
});

t('null / empty are REJECTED', () => {
  assert.strictEqual(renderPhoneForSms(null).reason, 'invalid_phone');
  assert.strictEqual(renderPhoneForSms('').reason, 'invalid_phone');
});

t('a +91 with non-digits is REJECTED rather than stripped', () => {
  assert.strictEqual(renderPhoneForSms('+91 98765 43210').reason, 'invalid_phone');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
