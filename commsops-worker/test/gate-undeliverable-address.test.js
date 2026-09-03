// test/gate-undeliverable-address.test.js — S342.
// The gate refuses email addresses that structurally cannot receive mail.
//
// WHY THIS EXISTS: synthetic placeholder addresses were 2,524 of 4,602 bounces (54.85%) in the
// 22–26 Aug 2026 sending window — 14.30% bounce rate, 7.04% once they are excluded (denominator
// = 32,187 delivery attempts). Across ALL email history the three rules matched 2,684 attempts
// and 0 deliveries.
//
// ⭐ THE HALF OF THIS FILE THAT MATTERS IS THE SECOND HALF. A filter that silences a real
// customer is far worse than a bounce, so the "must NOT match" cases are the real test —
// they are the shapes a careless widening of the rules would swallow.
const assert = require('assert');
const A = require('../src/auth.js');
const { runGate, isUndeliverableEmail, _clearSettingsCache } = require('../src/gate.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
const base = { test_mode: false, test_mode_allow: [], frequency_cap_per_day: 3,
  frequency_cap_window_hours: 24, quiet_hours_start: 0, quiet_hours_end: 0 };

// Every shape below was observed in comms.identifiers / comms.messages on 2026-09-03.
const UNDELIVERABLE = [
  'noemail_ph_num_919866467xxx@noemail.magic-checkout.invalid', // Shopify Magic Checkout
  'noemail_ph_num_918837419xxx@gmail.com',                      // real domain, placeholder local
  'noemail@dvara.com',
  'anon_6dbf20be9f727338413@example.com',
  '9058689236@example.com',
  'john.smith@example.com',
  'customer@example.org',
  'x@host.test',
  'noreply@delhivery.com',
  'do-not-reply@somecourier.com',
  'NoEmail_PH_NUM_9198@GMAIL.COM',                              // case-insensitive
  '  noemail@dvara.com  ',                                      // trimmed
];

// ⚠️ These are the false positives that would matter. `notexample.com` and `myexample.com`
// are NOT the reserved domain; `noemailer@` and `no-reply-team@` are not the reserved locals;
// `invalid.com` is a real TLD, not the reserved `.invalid`.
const DELIVERABLE = [
  'afshaan@legendoftoys.com',
  'someone@gmail.com',
  'noemailer@realdomain.com',      // 'noemail' + letters is a WORD, not the placeholder convention
  'noemailmarketing@agency.com',
  'test@notexample.com',
  'test@myexample.com',
  'user@invalid.com',              // real domain whose NAME is 'invalid', not the .invalid TLD
  'no-reply-team@agency.com',      // exact-local rule must not match a longer local part
  'john.noreply@gmail.com',        // ditto — substring match would wrongly catch this
];

(async () => {
  // ── predicate ──────────────────────────────────────────────────────────────
  for (const a of UNDELIVERABLE) {
    await t(`undeliverable: ${a.trim()}`, () => assert.equal(isUndeliverableEmail(a), true));
  }
  for (const a of DELIVERABLE) {
    await t(`deliverable, must NOT be filtered: ${a}`, () =>
      assert.equal(isUndeliverableEmail(a), false));
  }
  await t('null / empty / non-address are not filtered here', () => {
    assert.equal(isUndeliverableEmail(null), false);
    assert.equal(isUndeliverableEmail(''), false);
    assert.equal(isUndeliverableEmail('not-an-address'), false); // adapter's job, not the gate's
    assert.equal(isUndeliverableEmail('@nolocal.com'), false);
  });

  // ── gate wiring ────────────────────────────────────────────────────────────
  A.sbComms = async (path) => {
    if (path.startsWith('/rest/v1/settings')) return { ok: true, data: [base] };
    if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [{ state: 'opted_in' }] };
    if (path.includes('consume_send_budget')) return { ok: true, data: true };
    return { ok: true, data: [] };
  };

  // The load-bearing case: transactional and utility BYPASS consent/cap/quiet-hours, so if the
  // check had been placed with those it would not have covered them. A placeholder address
  // cannot receive an order confirmation either.
  for (const purpose of ['marketing', 'utility', 'transactional', 'service']) {
    await t(`gate refuses undeliverable for purpose=${purpose}`, async () => {
      _clearSettingsCache();
      const g = await runGate({}, { profileId: 'P', channel: 'email', purpose,
        to: 'noemail_ph_num_919@noemail.magic-checkout.invalid' });
      assert.equal(g.pass, false);
      assert.equal(g.reason, 'undeliverable_address');
    });
  }

  await t('gate lets a real address through to the later checks', async () => {
    _clearSettingsCache();
    const g = await runGate({}, { profileId: 'P', channel: 'email', purpose: 'utility',
      to: 'afshaan@legendoftoys.com' });
    assert.equal(g.reason, undefined);
    assert.equal(g.pass, true);
  });

  // Non-email channels must be untouched: '@' shapes are not how phone numbers are addressed,
  // and an SMS/WhatsApp destination must never be judged by an email rule.
  await t('non-email channels are not subject to the email rules', async () => {
    _clearSettingsCache();
    const g = await runGate({}, { profileId: 'P', channel: 'sms', purpose: 'utility',
      to: 'noemail@dvara.com' });
    // Assert the POSITIVE, not merely "not that reason" — a negative assertion would stay
    // green if a future change blocked SMS entirely for some unrelated reason.
    assert.equal(g.pass, true);
    assert.equal(g.reason, undefined);
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
