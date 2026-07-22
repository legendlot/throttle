// Node unit tests for the Shopflo webhook consent hardening (hostile-review C3).
// A Shopflo opt-OUT must never be silently lost while the handler acks 200: a failed
// consent write must surface as non-2xx (Shopflo retries), and consent must be
// attempted on EVERY delivery, including a deduped event retry (append-only ledger —
// a duplicate consent row is cosmetic, a lost opt-out is not).
// Run: node test/shopflo-consent.test.js   (Node 18+)

const assert = require('assert');
const A = require('../src/auth.js');
const { handleShopfloWebhook } = require('../src/shopflo-webhooks.js');

let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(
  () => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });

const req = (body) => ({
  headers: new Map([['Authorization', 'Bearer tok']]),
  text: async () => JSON.stringify(body),
});

// checkout_abandoned carrying an explicit opt-OUT — the case that matters (shape from
// shopflo.js mapCheckoutAbandoned / consentRowsFrom: identity in customer{}, consent
// signal is customer.marketing_consent).
const BODY = {
  event_name: 'checkout_abandoned',
  checkout_id: 'chk_c3',
  customer: { email: 'optout@buyer.com', phone: '+919000000001', marketing_consent: false },
  total_price: 1999, currency: 'INR',
  created_at: '2026-07-22T10:00:00.000Z', updated_at: '2026-07-22T10:06:00.000Z',
};

const ENV = { SHOPFLO_WEBHOOK_TOKEN: 'tok', SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const orig = A.sbComms;

(async () => {
  await t('consent write failure -> non-2xx (Shopflo will retry, opt-out not lost)', async () => {
    A.sbComms = async (path) => {
      if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
      if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E1' }] }; // first occurrence
      if (path.startsWith('/rest/v1/consent')) return { ok: false, status: 500, data: null };
      if (path.startsWith('/rest/v1/webhook_captures')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    const r = await handleShopfloWebhook(ENV, req(BODY));
    assert.equal(r.ok, false, 'a failed consent write must not ack success');
    assert.equal(r.status, 500, 'must surface a 500 so Shopflo redelivers');
    A.sbComms = orig;
  });

  await t('consent write THROWS (transport failure) -> non-2xx, not swallowed as {ok:true} (Gate-1 review)', async () => {
    A.sbComms = async (path) => {
      if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
      if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E1b' }] }; // first occurrence
      if (path.startsWith('/rest/v1/consent')) throw new Error('fetch failed');
      if (path.startsWith('/rest/v1/webhook_captures')) return { ok: true, data: [] };
      return { ok: true, data: [] };
    };
    const r = await handleShopfloWebhook(ENV, req(BODY));
    A.sbComms = orig;
    assert.equal(r.ok, false, 'a THROWN consent write must not ack success');
    assert.equal(r.status, 500, 'must surface a 500 so Shopflo redelivers, not the mapper-crash 200');
  });

  await t('deduped event retry STILL attempts consent (append-only, duplicate rows are cosmetic)', async () => {
    let consentAttempts = 0;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
      if (path.startsWith('/rest/v1/events')) return { ok: true, data: [] }; // deduped: ignore-duplicates -> []
      if (path.startsWith('/rest/v1/consent')) {
        consentAttempts++;
        assert.equal(JSON.parse(opts.body).state, 'opted_out');
        return { ok: true, data: [{}] };
      }
      return { ok: true, data: [] };
    };
    const r = await handleShopfloWebhook(ENV, req(BODY));
    A.sbComms = orig;
    assert.equal(r.ok, true);
    assert.ok(consentAttempts >= 1, 'consent must be re-attempted even on a deduped retry');
  });

  await t('consent succeeds -> handler acks 2xx normally', async () => {
    A.sbComms = async (path) => {
      if (path.includes('resolve_identity')) return { ok: true, data: 'P1' };
      if (path.startsWith('/rest/v1/events')) return { ok: true, data: [{ id: 'E2' }] };
      if (path.startsWith('/rest/v1/consent')) return { ok: true, data: [{}] };
      return { ok: true, data: [] };
    };
    const r = await handleShopfloWebhook(ENV, req(BODY));
    A.sbComms = orig;
    assert.equal(r.ok, true);
    assert.ok(r.consent >= 1);
  });

  await t('profile-resolution failure still surfaces as non-2xx (unchanged behaviour)', async () => {
    A.sbComms = async (path) => {
      if (path.includes('resolve_identity')) return { ok: false, status: 500, data: null };
      return { ok: true, data: [] };
    };
    const r = await handleShopfloWebhook(ENV, req(BODY));
    A.sbComms = orig;
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
