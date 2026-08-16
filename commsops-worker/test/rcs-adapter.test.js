// RCS adapter — pre-network refusals + webhook event classification.
// Run: node test/rcs-adapter.test.js
const assert = require('assert');
const { send, parseStatusWebhook } = require('../src/adapters/rcs.js');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ', n); }
                      catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };
const ta = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); }
                             catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

const GOOD = {
  to: '+919876543210', purpose: 'marketing', provider_template_id: 'tpl1',
  vars: {}, sms_fallback: { sender: 'LGNDRC', message: 'hi', template_id: 'dlt1', route: 'promotional' },
};

(async () => {
  // ── send(): every refusal fires BEFORE any network call (no API key set here, and none of
  //    these reach tsFetch — a fetch attempt would fail with API_KEY_MISSING, not these reasons).
  await ta('a bare-10-digit recipient is refused, never truncated or repaired', async () => {
    const r = await send({ ...GOOD, to: '9876543210' }, {});
    assert.strictEqual(r.status, 'failed'); assert.strictEqual(r.reason, 'invalid_phone');
  });
  await ta('a non-+91 E.164 is still a valid RCS recipient shape (fails later on API key, not phone)', async () => {
    // RCS takes E.164 unchanged (spec §6b rule 4) — unlike SMS there is no India-only carve-out
    // at the adapter; reach the network layer and fail there in this keyless test env.
    const r = await send({ ...GOOD, to: '+14155550123' }, {});
    assert.notStrictEqual(r.reason, 'invalid_phone');
  });
  await ta('non-marketing purpose is refused (D6 — the bot is promotional)', async () => {
    const r = await send({ ...GOOD, purpose: 'utility' }, {});
    assert.strictEqual(r.reason, 'rcs_is_marketing_only');
  });
  await ta('a missing SMS fallback leg is refused (with_fallback is the only send path)', async () => {
    const r = await send({ ...GOOD, sms_fallback: null }, {});
    assert.strictEqual(r.reason, 'missing_sms_fallback');
  });
  await ta('an incomplete fallback leg is refused, not half-sent', async () => {
    const r = await send({ ...GOOD, sms_fallback: { sender: 'LGNDRC', message: '', template_id: 'x' } }, {});
    assert.strictEqual(r.reason, 'missing_sms_fallback');
  });
  await ta('an unregistered RCS template is refused', async () => {
    const r = await send({ ...GOOD, provider_template_id: null }, {});
    assert.strictEqual(r.reason, 'rcs_template_not_registered');
  });

  // ── parseStatusWebhook(): classification.
  t('Fallback event → fallback_flip', () => {
    const [ev] = parseStatusWebhook({ event: 'Fallback', transaction_id: 'tx1', sms_cost: '0.1' });
    assert.strictEqual(ev.fallback_flip, true);
    assert.strictEqual(ev.provider_message_id, 'tx1');
    assert.strictEqual(ev.cost, 0.1);           // F11 — string credit coerced to number
  });
  t('Delivery_status nonrcs → fallback_flip too (both arrive, either order)', () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'nonrcs' });
    assert.strictEqual(ev.fallback_flip, true);
  });
  t('delivered → delivered', () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'delivered', route: 'rcs' });
    assert.strictEqual(ev.canonical_status, 'delivered');
    assert.strictEqual(ev.route, 'rcs');
  });
  t("RCS 'read' → canonical 'opened' (same mapping as WhatsApp)", () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'read' });
    assert.strictEqual(ev.canonical_status, 'opened');
  });
  t('failed carries a reason', () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'failed', error: 'blocked' });
    assert.strictEqual(ev.canonical_status, 'failed');
    assert.strictEqual(ev.reason, 'blocked');
  });
  t('an unknown status returns canonical_status null, never throws (catalogue is partial)', () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'quantum_flux' });
    assert.strictEqual(ev.canonical_status, null);
    assert.strictEqual(ev.raw_status, 'quantum_flux');
  });
  t('Click event → click with url', () => {
    const [ev] = parseStatusWebhook({ event: 'Click', transaction_id: 'tx1', url: 'https://x/y' });
    assert.strictEqual(ev.click, true);
    assert.strictEqual(ev.clicked_url, 'https://x/y');
  });
  t('User_response → postback captured, no status write', () => {
    const [ev] = parseStatusWebhook({ event: 'User_response', transaction_id: 'tx1', postback: 'BUY_NOW' });
    assert.strictEqual(ev.user_response, true);
    assert.strictEqual(ev.postback, 'BUY_NOW');
  });
  t('array, {data:[]}, {events:[]} and single-object payloads all normalize', () => {
    const p = { transaction_id: 'tx1', status: 'delivered' };
    for (const shape of [[p], { data: [p] }, { events: [p] }, p]) {
      const evs = parseStatusWebhook(shape);
      assert.strictEqual(evs.length, 1);
    }
  });
  t('garbage rows are dropped, not thrown', () => {
    assert.deepStrictEqual(parseStatusWebhook(null), []);
    assert.deepStrictEqual(parseStatusWebhook({ data: [null, 42] }), []);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
