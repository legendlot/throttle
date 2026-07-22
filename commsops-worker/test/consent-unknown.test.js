// Node unit tests for the "unknown never overrides a known state" consent guard
// (Afshaan-approved 2026-07-22, closes the Shopify unknown-consent hostile-review item).
//
// Bug: comms.consent is append-only, latest-wins. Shopify's customers/create|update
// webhook (and the backfill) map indeterminate Shopify consent to state:'unknown' and
// recordConsent appended it unconditionally — so a genuine opted_in got clobbered by a
// later unknown. Live evidence: Afshaan's own opted_in (2026-06-30) was overridden by a
// shopify_webhook unknown on 2026-07-16, causing no_consent send-skips.
//
// Policy: an `unknown` write is appended ONLY when no prior KNOWN state (opted_in/
// opted_out) exists for that (profile, channel, purpose). A known state may ALWAYS write
// (a real withdrawal arrives as opted_out, never unknown — see optout.js — so this guard
// cannot block a genuine opt-out).
//
// Run: node test/consent-unknown.test.js   (Node 18+)

const assert = require('assert');
const A = require('../src/auth.js');
const { recordConsent } = require('../src/consent.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(
  () => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const ENV = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const orig = A.sbComms;

// Stub: GET (latestConsent lookup) returns `latestState`; POST (the actual consent write)
// records that it was called and returns ok.
function stub(latestState) {
  let posted = false;
  let postedBody = null;
  A.sbComms = async (path, env, opts = {}) => {
    if (path.startsWith('/rest/v1/consent')) {
      if (opts.method === 'POST') {
        posted = true;
        postedBody = JSON.parse(opts.body);
        return { ok: true, status: 201, data: [postedBody] };
      }
      // GET (latestConsent)
      if (latestState === null) return { ok: true, status: 200, data: [] };
      return { ok: true, status: 200, data: [{ state: latestState, captured_at: '2026-07-20T00:00:00Z' }] };
    }
    return { ok: true, data: [] };
  };
  return { wasPosted: () => posted, getBody: () => postedBody };
}

(async () => {
  await t('unknown does NOT write over a latest opted_in', async () => {
    const spy = stub('opted_in');
    const r = await recordConsent(ENV, { profile_id: 'P1', channel: 'email', purpose: 'marketing', state: 'unknown', source: 'shopify_webhook' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), false, 'must not POST a consent row');
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'unknown_no_override');
  });

  await t('unknown does NOT write over a latest opted_out', async () => {
    const spy = stub('opted_out');
    const r = await recordConsent(ENV, { profile_id: 'P2', channel: 'whatsapp', purpose: 'marketing', state: 'unknown', source: 'shopify_webhook' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), false, 'must not POST a consent row');
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'unknown_no_override');
  });

  await t('unknown DOES write when no prior row exists', async () => {
    const spy = stub(null);
    const r = await recordConsent(ENV, { profile_id: 'P3', channel: 'email', purpose: 'marketing', state: 'unknown', source: 'shopify_webhook' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), true, 'must POST — nothing known to protect');
    assert.equal(r.ok, true);
    assert.equal(spy.getBody().state, 'unknown');
  });

  // Policy choice: unknown-over-unknown is allowed to write (dedup upstream already
  // collapses identical rows on (profile,channel,purpose,state,source,captured_at); the
  // invariant we enforce is only "unknown must never land above a KNOWN row").
  await t('unknown DOES write when prior latest is also unknown', async () => {
    const spy = stub('unknown');
    const r = await recordConsent(ENV, { profile_id: 'P4', channel: 'email', purpose: 'marketing', state: 'unknown', source: 'shopify_webhook' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), true, 'unknown-over-unknown is not guarded — only known rows are protected');
    assert.equal(r.ok, true);
  });

  await t('opted_in still writes over unknown', async () => {
    const spy = stub('unknown');
    const r = await recordConsent(ENV, { profile_id: 'P5', channel: 'email', purpose: 'marketing', state: 'opted_in', source: 'internal_test' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), true);
    assert.equal(r.ok, true);
    assert.equal(spy.getBody().state, 'opted_in');
  });

  await t('opted_out always writes (even over a known opted_in)', async () => {
    const spy = stub('opted_in');
    const r = await recordConsent(ENV, { profile_id: 'P6', channel: 'email', purpose: 'marketing', state: 'opted_out', source: 'wa_inbound' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), true);
    assert.equal(r.ok, true);
    assert.equal(spy.getBody().state, 'opted_out');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
