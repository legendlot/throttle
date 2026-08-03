// TrustSignal error shapes + credential redaction.
// Run: node test/trustsignal-client.test.js
const assert = require('assert');
const { normalizeError, redact } = require('../src/trustsignal-client.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

t('shape A — structured errors[]', () => {
  const r = normalizeError({ success: false, errors: [{ code: '114', codeMsg: 'INVALID_SENDERID', message: 'Invalid senderid' }] });
  assert.deepStrictEqual(r, { code: '114', codeMsg: 'INVALID_SENDERID', message: 'Invalid senderid' });
});

t('shape B — flat message', () => {
  const r = normalizeError({ success: false, message: 'Wrong OTP' });
  assert.strictEqual(r.message, 'Wrong OTP');
  assert.strictEqual(r.code, null);
});

t('shape C — single error string', () => {
  const r = normalizeError({ success: false, error: 'Webhook URL is missing' });
  assert.strictEqual(r.message, 'Webhook URL is missing');
});

t('an unknown shape still yields a message rather than throwing', () => {
  const r = normalizeError({ success: false, weird: true });
  assert.ok(typeof r.message === 'string' && r.message.length > 0);
});

t('a null body does not throw', () => {
  assert.ok(normalizeError(null).message);
});

t('redact removes the api_key VALUE from a url', () => {
  const out = redact('https://sms.trustsignal.io/v1/sms?api_key=SUPERSECRET123&to=99');
  assert.ok(!out.includes('SUPERSECRET123'), 'key must not survive');
  assert.ok(out.includes('api_key=[redacted]'));
  assert.ok(out.includes('to=99'), 'other params must survive');
});

t('redact handles the key anywhere in the string, not just as first param', () => {
  const out = redact('failed: to=9&api_key=abc123 (500)');
  assert.ok(!out.includes('abc123'));
});

t('redact is safe on non-strings', () => {
  assert.strictEqual(redact(null), '');
  assert.strictEqual(redact(undefined), '');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
