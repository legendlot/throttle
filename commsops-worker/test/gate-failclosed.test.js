// test/gate-failclosed.test.js — a DB error must BLOCK, never pass.
// Hostile-review finding H1: suppression + freq-cap were failing OPEN on a DB error
// (`sup.ok && ...` / `cnt.ok && ...` silently treated an unreadable table as "no rows").
// Consent already failed closed (defaults to 'unknown' on error); this locks the other two.
const assert = require('assert');
const A = require('../src/auth.js');
const { runGate, _clearSettingsCache } = require('../src/gate.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
// quiet_hours_start/_end both 0 → inQuietHours(0,0) is always false (start>end is false, so it's
// `h>=0 && h<0`, never true) — deterministic at any time of day, so test 2 (marketing) never trips
// the quiet-hours block before reaching the freq-cap check under test.
const base = { test_mode: false, test_mode_allow: [], frequency_cap_per_day: 3, frequency_cap_window_hours: 24, quiet_hours_start: 0, quiet_hours_end: 0 };

(async () => {
  await t('suppression query error → gate_error, not pass', async () => {
    A.sbComms = async (path) => {
      if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [base] };
      if (path.startsWith('/rest/v1/suppressions')) return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };
    };
    _clearSettingsCache();
    const g = await runGate({}, { channel: 'email', purpose: 'utility', to: 'x@y.com' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'gate_error:suppression');
  });

  await t('freq-cap query error → gate_error, not silently uncapped', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [base] };
      if (path.startsWith('/rest/v1/suppressions')) return { ok: true, data: [] };
      if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [{ state: 'opted_in' }] };
      if (path.startsWith('/rest/v1/messages')) return { ok: false, status: 500, data: null };
      if (path.includes('consume_send_budget')) return { ok: true, data: true };
      return { ok: true, data: [] };
    };
    _clearSettingsCache();
    const g = await runGate({}, { profileId: 'P', channel: 'email', purpose: 'marketing', to: 'x@y.com' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'gate_error:freq_cap');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
