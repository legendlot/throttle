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

  // ── parseStatusWebhook(): classification. Payload shapes below are the vendor's OWN examples
  //    from the Sigmo "RCS Webhook Payload Reference" (read 2026-08-17), verbatim where possible.
  t("documented Delivery Status payload → delivered, dated by dlrt, credit read", () => {
    const [ev] = parseStatusWebhook({
      transaction_id: 'txn_123456789', mid: 'msg_987654321', to: '+919999999999',
      route: 'rcs', status: 'delivered', st: '2026-07-23T10:15:00Z', dlrt: '2026-07-23T10:15:03Z',
      credit: 1, template_id: 'welcome_template', bot_id: 'sample_bot',
      error: '', error_code: '', webhook_type: 'rcs_message',
    });
    assert.strictEqual(ev.canonical_status, 'delivered');
    assert.strictEqual(ev.at, '2026-07-23T10:15:03Z');   // dlrt wins over st
    assert.strictEqual(ev.route, 'rcs');
  });
  t("documented Click payload → click with final_url (a STATUS value, not an event shape)", () => {
    const [ev] = parseStatusWebhook({
      transaction_id: 'txn_123456789', to: '+919999999999', status: 'click',
      st: '2026-07-23T10:30:15Z', final_url: 'https://example.com/offer',
      ip: '103.25.142.18', user_agent: 'Mozilla/5.0 (Linux; Android 14)', webhook_type: 'rcs_message',
    });
    assert.strictEqual(ev.click, true);
    assert.strictEqual(ev.clicked_url, 'https://example.com/offer');
  });
  t("documented Fallback payload → flip + the SMS leg's own terminal status", () => {
    const [ev] = parseStatusWebhook({
      transaction_id: 'txn_456789123', mid: 'sms_mid_123456', to: '+919999999999',
      status: 'delivered', st: '2026-07-23T14:20:00Z', dlrt: '2026-07-23T14:20:03Z',
      error: '', webhook_type: 'rcs_fallback_status',
    });
    assert.strictEqual(ev.fallback_flip, true);
    assert.strictEqual(ev.sms_status, 'delivered');
  });
  t('a FAILED fallback carries the flip AND the failure reason (F8)', () => {
    const [ev] = parseStatusWebhook({
      transaction_id: 'txn_1', status: 'failed', error: 'dnd', webhook_type: 'rcs_fallback_status',
    });
    assert.strictEqual(ev.fallback_flip, true);
    assert.strictEqual(ev.sms_status, 'failed');
    assert.strictEqual(ev.reason, 'dnd');
  });
  t('Delivery_status nonrcs → flip only, no sms_status, no cost (that arrives on the fallback DLR)', () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'nonrcs', credit: 1, webhook_type: 'rcs_message' });
    assert.strictEqual(ev.fallback_flip, true);
    assert.strictEqual(ev.sms_status, null);
    assert.strictEqual(ev.cost, null);
  });
  t("RCS 'read' → canonical 'opened' (same mapping as WhatsApp)", () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'read', webhook_type: 'rcs_message' });
    assert.strictEqual(ev.canonical_status, 'opened');
  });
  t('failed carries a reason from `error`', () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'failed', error: 'blocked', error_code: 'E42' });
    assert.strictEqual(ev.canonical_status, 'failed');
    assert.strictEqual(ev.reason, 'blocked');
  });
  t('an unknown status returns canonical_status null, never throws (catalogue is partial)', () => {
    const [ev] = parseStatusWebhook({ transaction_id: 'tx1', status: 'quantum_flux' });
    assert.strictEqual(ev.canonical_status, null);
    assert.strictEqual(ev.raw_status, 'quantum_flux');
  });
  t("documented User Response payload → captured via tlmsgid (it has NO transaction_id)", () => {
    const [ev] = parseStatusWebhook({
      phone: '+919999999999', mtype: 'text', response: 'I would like to know more',
      status: 'received', from: '+919999999999', st: '2026-07-23T11:15:30Z',
      bot_id: 'bot_12345', response_type: 'text', webhook_type: 'rcs_user_response',
      tlmsgid: 'msg_987654321', template_id: 'welcome_template',
    });
    assert.strictEqual(ev.user_response, true);
    assert.strictEqual(ev.provider_message_id, 'msg_987654321');
    assert.strictEqual(ev.postback, 'I would like to know more');
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
