// runGate rcs consent — D2/D3 (S290 hostile-review regression).
// The bug this pins: an explicit rcs opt-IN must NOT outrank an sms opt-OUT — D2 requires
// BOTH, and the SQL twin (comms.marketing_consented) already refused it.
// Run: node test/gate-rcs-consent.test.js
const assert = require('assert');

// Patch BEFORE gate.js is required — it destructures latestConsent at load time.
const consent = require('../src/consent.js');
let CONSENT = {};
consent.latestConsent = async (env, pid, channel) => CONSENT[channel] || 'unknown';
const A = require('../src/auth.js');
A.sbComms = async (path) => {
  if (path.includes('/settings')) return { ok: true, data: [{ test_mode: false, quiet_hours_start: '21:00', quiet_hours_end: '09:00' }] };
  if (path.includes('suppressions')) return { ok: true, data: [] };
  if (path.includes('channel_quiet_hours')) return { ok: true, data: [] };
  if (path.includes('messages')) return { ok: true, data: [] };
  if (path.includes('consume_send_budget')) return { ok: true, data: true };
  return { ok: true, data: [] };
};
const { runGate } = require('../src/gate.js');

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); }
                            catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };
const gate = () => runGate({}, { profileId: 'p1', channel: 'rcs', purpose: 'marketing', to: '+919876543210', isTest: false });

(async () => {
  await t('no rcs consent + sms opted_in → PASSES (D3 resolver)', async () => {
    CONSENT = { sms: 'opted_in' };
    assert.strictEqual((await gate()).pass, true);
  });
  await t('explicit rcs opt-OUT beats the sms opt-in', async () => {
    CONSENT = { rcs: 'opted_out', sms: 'opted_in' };
    const g = await gate();
    assert.strictEqual(g.pass, false); assert.strictEqual(g.reason, 'no_consent');
  });
  await t('THE REGRESSION: explicit rcs opt-in + sms opted_OUT → refused (D2 requires both)', async () => {
    CONSENT = { rcs: 'opted_in', sms: 'opted_out' };
    const g = await gate();
    assert.strictEqual(g.pass, false); assert.strictEqual(g.reason, 'no_consent');
  });
  await t('nothing anywhere → refused', async () => {
    CONSENT = {};
    assert.strictEqual((await gate()).pass, false);
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
