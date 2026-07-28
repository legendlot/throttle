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
const { recordConsent, latestConsent } = require('../src/consent.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(
  () => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const ENV = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const orig = A.sbComms;

// Stub: GET (latestConsent lookup) returns `latestState`; POST (the actual consent write)
// records that it was called and returns ok. Pass latestState = 'READ_FAIL' to simulate
// the underlying read itself failing (r.ok:false) — distinct from latestState = null
// (read succeeds, genuinely no prior row).
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
      // GET (latestConsent / _latestConsentRaw)
      if (latestState === 'READ_FAIL') return { ok: false, status: 500, data: null };
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

  // Review follow-up (2026-07-22): a failed latest-row read must NOT be treated as
  // "no prior row" — that would fail OPEN and let an unknown land above a known row on
  // a transient DB error. Skipping is always safe (unknown rows are never load-bearing;
  // the next successful delivery re-attempts).
  await t('latest-row read FAILS -> unknown write is SKIPPED (fails closed, not open)', async () => {
    const spy = stub('READ_FAIL');
    const r = await recordConsent(ENV, { profile_id: 'P7', channel: 'email', purpose: 'marketing', state: 'unknown', source: 'shopify_webhook' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), false, 'a failed read must not be treated as "safe to write"');
    assert.equal(r.ok, true);
    assert.equal(r.skipped, 'unknown_no_override_read_failed');
  });

  await t('opted_out always writes (even over a known opted_in)', async () => {
    const spy = stub('opted_in');
    const r = await recordConsent(ENV, { profile_id: 'P6', channel: 'email', purpose: 'marketing', state: 'opted_out', source: 'wa_inbound' });
    A.sbComms = orig;
    assert.equal(spy.wasPosted(), true);
    assert.equal(r.ok, true);
    assert.equal(spy.getBody().state, 'opted_out');
  });


  // ── 2026-07-28: the ORDERING race the write-guard cannot catch ──────────────────────────
  // Shopify stamps captured_at=now(); Shopflo's genuine opt-in carries its own EARLIER
  // timestamp and lands a few seconds later. No opt-in existed when the unknown was written,
  // so the guard correctly allowed it — then the opt-in arrived underneath and lost the sort.
  // Fix: exclude `unknown` from the effective-state read entirely.
  await t('the read EXCLUDES unknown rows (state=neq.unknown on the query)', async () => {
    let seenPath = null;
    A.sbComms = async (path) => { seenPath = path; return { ok: true, data: [] }; };
    await latestConsent(ENV, 'P-ord', 'whatsapp', 'marketing');
    A.sbComms = orig;
    assert.ok(seenPath.includes('state=neq.unknown'),
      'unknown rows must not be able to win the effective state');
  });

  await t('a buried opt-in is visible again (unknown on top no longer wins)', async () => {
    // The filtered query can only return the opted_in, which is the whole point.
    A.sbComms = async () => ({ ok: true, data: [{ state: 'opted_in', captured_at: '2026-07-28T00:28:40Z' }] });
    const s = await latestConsent(ENV, 'P-buried', 'whatsapp', 'marketing');
    A.sbComms = orig;
    assert.equal(s, 'opted_in');
  });

  await t('FAIL-CLOSED preserved: only-unknown rows still resolve to unknown', async () => {
    A.sbComms = async () => ({ ok: true, data: [] });   // filtered out → empty
    const s = await latestConsent(ENV, 'P-only-unknown', 'whatsapp', 'marketing');
    A.sbComms = orig;
    assert.equal(s, 'unknown', 'must still block at the gate');
  });

  await t('a real opt-out is NEVER hidden by the filter', async () => {
    A.sbComms = async () => ({ ok: true, data: [{ state: 'opted_out', captured_at: '2026-07-27T12:59:45Z' }] });
    const s = await latestConsent(ENV, 'P-out', 'whatsapp', 'marketing');
    A.sbComms = orig;
    assert.equal(s, 'opted_out');
  });

  await t('read failure still fails closed to unknown', async () => {
    A.sbComms = async () => ({ ok: false, status: 500, data: null });
    const s = await latestConsent(ENV, 'P-err', 'whatsapp', 'marketing');
    A.sbComms = orig;
    assert.equal(s, 'unknown');
  });

  await t('created_at tiebreaker present (same-ms rows must be deterministic)', async () => {
    let seenPath = null;
    A.sbComms = async (path) => { seenPath = path; return { ok: true, data: [] }; };
    await latestConsent(ENV, 'P-tie', 'email', 'marketing');
    A.sbComms = orig;
    assert.ok(seenPath.includes('created_at.desc'), 'same-timestamp rows resolved non-deterministically');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
