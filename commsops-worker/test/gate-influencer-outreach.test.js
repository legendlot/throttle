// test/gate-influencer-outreach.test.js — the `influencer_outreach` purpose (S327).
//
// The class only earns its existence if it is STRICTER than 'service' in the one place that
// matters: it bypasses the opted_in requirement (a cold business contact has never opted in)
// but it must still refuse anyone who explicitly opted OUT. Those two together are the whole
// contract, and test 1 + test 2 are the pair that proves it.
//
// ⚠️ The opt-out lives on a CONSENT row, not a suppression (optout.js writes consent so a STOP
// doesn't also kill order updates), so the suppression step cannot catch it. If test 2 ever
// goes green-to-red, cold outreach is reaching people who told us to stop.
const assert = require('assert');
const A = require('../src/auth.js');
const { runGate, _clearSettingsCache } = require('../src/gate.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

// quiet_hours 0/0 → never quiet (see gate-failclosed.test.js for why), so these tests are
// deterministic at any time of day and never trip the quiet-hours block under test elsewhere.
const base = {
  test_mode: false, test_mode_allow: [],
  frequency_cap_per_day: 3, frequency_cap_window_hours: 24,
  quiet_hours_start: 0, quiet_hours_end: 0,
};

// Default happy-path stub: nothing suppressed, no consent rows, no prior messages, budget ok.
// `consent` returns [] = no row at all, which for outreach must mean PASS.
function stub({ consent = [], consentOk = true, messages = [], budget = true, suppressions = [] } = {}) {
  return async (path, env, opts = {}) => {
    if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [base] };
    if (path.startsWith('/rest/v1/suppressions')) return { ok: true, data: suppressions };
    if (path.startsWith('/rest/v1/consent')) return consentOk ? { ok: true, data: consent } : { ok: false, data: null };
    if (path.startsWith('/rest/v1/channel_quiet_hours')) return { ok: true, data: [] };
    if (path.startsWith('/rest/v1/messages')) return { ok: true, data: messages };
    if (path.includes('consume_send_budget')) return { ok: true, data: budget };
    return { ok: true, data: [] };
  };
}
const OUTREACH = { profileId: 'P', channel: 'email', purpose: 'influencer_outreach', to: 'x@y.com' };

(async () => {
  await t('no consent row at all → PASSES (the whole point: cold contact, never opted in)', async () => {
    A.sbComms = stub();
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, true, `expected pass, got ${g.reason}`);
  });

  await t('explicit opted_out → REFUSED (bypassing consent must not mean ignoring a withdrawal)', async () => {
    A.sbComms = stub({ consent: [{ state: 'opted_out' }] });
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'opted_out');
  });

  await t('opted_in → passes (an influencer who DID opt in is not penalised)', async () => {
    A.sbComms = stub({ consent: [{ state: 'opted_in' }] });
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, true, `expected pass, got ${g.reason}`);
  });

  // The fail-closed twin of test 1. latestConsent() collapses "no row" and "read failed" into
  // 'unknown'; a purpose that PASSES on no-row would therefore treat a DB outage as permission
  // to send. The gate uses _latestConsentRaw precisely so this case blocks.
  await t('consent read FAILS → gate_error, never a free pass', async () => {
    A.sbComms = stub({ consentOk: false });
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'gate_error:consent');
  });

  // Without a profile there is no consent row to read, so the opt-out check above cannot run —
  // and suppression won't catch it either, because withdrawals are consent rows, not
  // suppressions. Refusing is the only fail-closed answer.
  await t('no profileId → REFUSED (an opt-out would be undiscoverable)', async () => {
    A.sbComms = stub();
    _clearSettingsCache();
    const g = await runGate({}, { ...OUTREACH, profileId: null });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'no_profile');
  });

  await t('suppression still applies (every purpose, no exceptions)', async () => {
    A.sbComms = stub({ suppressions: [{ id: 1 }] });
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'suppressed');
  });

  // Shared pressure counter: 3 prior MARKETING sends must exhaust the outreach allowance too,
  // so an influencer who is also a customer cannot receive a full allowance of each.
  await t('freq cap counts marketing + outreach together (no 3+3 stacking)', async () => {
    A.sbComms = stub({ messages: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'freq_cap');
  });

  await t('freq-cap query asks for BOTH purposes, not just marketing', async () => {
    let asked = null;
    const inner = stub();
    A.sbComms = async (path, env, opts) => {
      if (path.startsWith('/rest/v1/messages')) asked = path;
      return inner(path, env, opts);
    };
    _clearSettingsCache();
    await runGate({}, OUTREACH);
    assert.ok(asked, 'freq-cap query never ran');
    assert.ok(asked.includes('marketing') && asked.includes('influencer_outreach'),
      `freq-cap query did not span both purposes: ${asked}`);
  });

  await t('freq-cap read failure → gate_error, not silently uncapped', async () => {
    const inner = stub();
    A.sbComms = async (path, env, opts) => {
      if (path.startsWith('/rest/v1/messages')) return { ok: false, data: null };
      return inner(path, env, opts);
    };
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'gate_error:freq_cap');
  });

  await t('consumes the send budget → budget_exhausted when spent', async () => {
    A.sbComms = stub({ budget: false });
    _clearSettingsCache();
    const g = await runGate({}, OUTREACH);
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'budget_exhausted');
  });

  // Regression guard on the neighbours: this change must not have altered any existing purpose.
  await t('REGRESSION — marketing still REQUIRES opted_in (no row ⇒ no_consent)', async () => {
    A.sbComms = stub();
    _clearSettingsCache();
    const g = await runGate({}, { ...OUTREACH, purpose: 'marketing' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'no_consent');
  });

  await t('REGRESSION — transactional still bypasses consent entirely, even opted_out', async () => {
    A.sbComms = stub({ consent: [{ state: 'opted_out' }] });
    _clearSettingsCache();
    const g = await runGate({}, { ...OUTREACH, purpose: 'transactional' });
    assert.equal(g.pass, true, `expected pass, got ${g.reason}`);
  });

  await t('REGRESSION — service still bypasses consent (opted_out does not block a CSAT)', async () => {
    A.sbComms = stub({ consent: [{ state: 'opted_out' }] });
    _clearSettingsCache();
    const g = await runGate({}, { ...OUTREACH, purpose: 'service' });
    assert.equal(g.pass, true, `expected pass, got ${g.reason}`);
  });

  // isTest short-circuits the outreach flags exactly as it does marketing's, so a test send
  // to an allowlisted internal address is never blocked by a stranger's opt-out state.
  await t('test send to an ALLOWLISTED address bypasses the outreach gates', async () => {
    const inner = stub({ consent: [{ state: 'opted_out' }] });
    A.sbComms = async (path, env, opts) => {
      if (path.startsWith('/rest/v1/settings'))
        return { ok: true, data: [{ ...base, test_mode_allow: ['@legendoftoys.com'] }] };
      return inner(path, env, opts);
    };
    _clearSettingsCache();
    const g = await runGate({}, { ...OUTREACH, isTest: true, to: 'me@legendoftoys.com' });
    assert.equal(g.pass, true, `expected pass, got ${g.reason}`);
  });

  await t('test send to a NON-allowlisted address is still hard-locked out', async () => {
    A.sbComms = stub();
    _clearSettingsCache();
    const g = await runGate({}, { ...OUTREACH, isTest: true, to: 'stranger@example.com' });
    assert.equal(g.pass, false);
    assert.equal(g.reason, 'test_recipient_not_allowlisted');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
