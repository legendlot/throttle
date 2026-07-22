// test/quiet-hours-bypass.test.js — allowlisted recipients bypass quiet hours (S230).
// The test_mode_allow list is the internal-test list; a late-night end-to-end send test
// must reach the tester's own phone tonight. Non-allowlisted recipients still skip
// (journey sends defer-and-retry on that skip; campaigns surface it).
const assert = require('assert');
const A = require('../src/auth.js');
const { runGate, _clearSettingsCache } = require('../src/gate.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
// quiet_hours 0→24 puts EVERY hour inside the window (h>=0 && h<24) — deterministic at
// any wall-clock time, so these tests never depend on when they run.
const base = { test_mode: false, test_mode_allow: ['@legendoftoys.com', '+917709991011'],
  frequency_cap_per_day: 3, frequency_cap_window_hours: 24, quiet_hours_start: 0, quiet_hours_end: 24 };

function mockDb(settings) {
  A.sbComms = async (path) => {
    if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [settings] };
    if (path.startsWith('/rest/v1/suppressions')) return { ok: true, data: [] };
    if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [{ state: 'opted_in' }] };
    if (path.startsWith('/rest/v1/messages')) return { ok: true, data: [] };
    if (path.includes('consume_send_budget')) return { ok: true, data: true };
    return { ok: true, data: [] };
  };
  _clearSettingsCache();
}

(async () => {
  await t('quiet hours block a non-allowlisted marketing send', async () => {
    mockDb(base);
    const g = await runGate({}, { profileId: 'P', channel: 'email', purpose: 'marketing', to: 'customer@gmail.com' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'quiet_hours');
  });

  await t('allowlisted domain bypasses quiet hours (test_mode OFF)', async () => {
    mockDb(base);
    const g = await runGate({}, { profileId: 'P', channel: 'email', purpose: 'marketing', to: 'afshaan@legendoftoys.com' });
    assert.equal(g.pass, true, `expected pass, got ${JSON.stringify(g)}`);
  });

  await t('allowlisted phone bypasses quiet hours, formatting-insensitive', async () => {
    mockDb(base);
    const g = await runGate({}, { profileId: 'P', channel: 'whatsapp', purpose: 'marketing',
      to: '+91 77099 91011', wa: { mode: 'template', window_open: false, hasTemplate: true } });
    assert.equal(g.pass, true, `expected pass, got ${JSON.stringify(g)}`);
  });

  await t('bypass also works with test_mode ON (the live test-window shape)', async () => {
    mockDb({ ...base, test_mode: true });
    const g = await runGate({}, { profileId: 'P', channel: 'whatsapp', purpose: 'marketing',
      to: '+917709991011', wa: { mode: 'template', window_open: false, hasTemplate: true } });
    assert.equal(g.pass, true, `expected pass, got ${JSON.stringify(g)}`);
  });

  await t('test_mode ON still blocks a non-allowlisted recipient ahead of everything', async () => {
    mockDb({ ...base, test_mode: true });
    const g = await runGate({}, { profileId: 'P', channel: 'email', purpose: 'marketing', to: 'customer@gmail.com' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'test_mode_blocked');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
