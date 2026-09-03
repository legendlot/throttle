// handleTrustsignalRcs — the F4 channel flip: ONE-WAY, IDEMPOTENT, cost from the SMS leg only.
// Run: node test/rcs-webhook.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const { handleTrustsignalRcs } = require('../src/webhooks.js');

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ', n); }
                            catch (e) { fail++; console.log('  FAIL', n, '\n        ', e.message); } };

// Record every PostgREST call and answer message lookups from `row`.
function stub(row) {
  const calls = [];
  A.sbComms = async (path, env, opts) => {
    calls.push({ path, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
    if (path.startsWith('/rest/v1/messages?provider_message_id=')) return { ok: true, data: row ? [row] : [] };
    return { ok: true, data: [{}] };
  };
  return calls;
}
const orig = A.sbComms;
const RCS_MSG = { id: 'm1', status: 'sent', to_address: '+919876543210', profile_id: 'p1',
                  channel: 'rcs', fallback_from: null };

(async () => {
  await t('fallback DLR flips channel rcs→sms (keyed fallback_from IS NULL) AND applies the SMS leg status', async () => {
    const calls = stub({ ...RCS_MSG });
    await handleTrustsignalRcs({}, {
      transaction_id: 'tx1', mid: 'sms_mid_1', status: 'delivered',
      st: '2026-08-17T00:00:00Z', dlrt: '2026-08-17T00:00:03Z', webhook_type: 'rcs_fallback_status',
    });
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.strictEqual(patches.length, 2, 'expected flip + status patches');
    assert.ok(patches[0].path.includes('fallback_from=is.null'), 'flip not keyed on fallback_from IS NULL');
    assert.strictEqual(patches[0].body.channel, 'sms');
    assert.strictEqual(patches[0].body.fallback_from, 'rcs');
    assert.strictEqual(patches[1].body.status, 'delivered');
    assert.strictEqual(patches[1].body.delivered_at, '2026-08-17T00:00:03Z');
  });

  await t('nonrcs flips without a status patch (the SMS DLR arrives separately)', async () => {
    const calls = stub({ ...RCS_MSG });
    await handleTrustsignalRcs({}, { transaction_id: 'tx1', status: 'nonrcs', webhook_type: 'rcs_message' });
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.strictEqual(patches.length, 1);
    assert.strictEqual(patches[0].body.channel, 'sms');
  });

  await t('an rcs-leg delivered arriving AFTER the flip is discarded', async () => {
    const calls = stub({ ...RCS_MSG, channel: 'sms', fallback_from: 'rcs' });
    await handleTrustsignalRcs({}, { transaction_id: 'tx1', status: 'delivered', route: 'rcs' });
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'discarded event still PATCHed');
  });

  await t("the SMS leg's own failure still lands (F8 — terminal state when fallback also fails)", async () => {
    const calls = stub({ ...RCS_MSG, channel: 'sms', fallback_from: 'rcs' });
    await handleTrustsignalRcs({}, { transaction_id: 'tx1', status: 'failed', route: 'sms', error: 'dnd' });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'SMS-leg failure was not applied');
    assert.strictEqual(patch.body.status, 'failed');
  });

  await t('status is forward-only: a late sent does not regress delivered', async () => {
    const calls = stub({ ...RCS_MSG, status: 'delivered' });
    await handleTrustsignalRcs({}, { transaction_id: 'tx1', status: 'sent' });
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'regression PATCH issued');
  });

  await t("read can land after delivered (opened outranks delivered) and stamps read_at", async () => {
    const calls = stub({ ...RCS_MSG, status: 'delivered' });
    await handleTrustsignalRcs({}, { transaction_id: 'tx1', status: 'read', timestamp: '2026-08-17T00:00:00Z' });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.strictEqual(patch.body.status, 'opened');
    assert.strictEqual(patch.body.read_at, '2026-08-17T00:00:00Z');
  });

  await t('a click emits link_clicked (F12 — the existing event name, never a new one)', async () => {
    const calls = stub({ ...RCS_MSG });
    await handleTrustsignalRcs({}, { transaction_id: 'tx1', status: 'click',
      final_url: 'https://x/y', st: '2026-08-17T00:01:00Z', webhook_type: 'rcs_message' });
    const ev = calls.find((c) => c.path.startsWith('/rest/v1/events'));
    assert.ok(ev, 'no event insert');
    assert.strictEqual(ev.body.name, 'link_clicked');
    assert.strictEqual(ev.body.properties.url, 'https://x/y');
    assert.ok(ev.body.idempotency_key.includes('https://x/y'), 'idempotency key must include the url');
  });

  await t('an unknown transaction id is ignored — never creates a row', async () => {
    const calls = stub(null);
    await handleTrustsignalRcs({}, { transaction_id: 'ghost', status: 'delivered' });
    assert.ok(!calls.some((c) => c.method === 'PATCH' || c.method === 'POST'), 'wrote for unknown id');
  });

  // ── User_response (suggested-reply postback) — S340 ──────────────────────────────────────
  // THE REGRESSION THESE GUARD: the postback handler used to sit BELOW the message lookup. A
  // user_response carries no transaction_id (only tlmsgid) while send() stores transaction_id as
  // provider_message_id, so the lookup missed, `if (!row) continue` fired, and every postback was
  // dropped — including before the diagnostic log meant to reveal the payload shape. `stub(null)`
  // reproduces exactly that condition: NO message row is resolvable, and the event must still land.
  const stubResolving = (row, profileId = 'p-resolved') => {
    const calls = [];
    A.sbComms = async (path, env, opts) => {
      calls.push({ path, method: opts?.method || 'GET', body: opts?.body ? JSON.parse(opts.body) : null });
      if (path.startsWith('/rest/v1/messages?provider_message_id=')) return { ok: true, data: row ? [row] : [] };
      if (path.startsWith('/rest/v1/rpc/resolve_identity')) return { ok: true, data: profileId };
      return { ok: true, data: [{}] };
    };
    return calls;
  };

  await t('documented user_response emits rcs_user_response EVEN WITH NO RESOLVABLE MESSAGE ROW', async () => {
    const calls = stubResolving(null);
    await handleTrustsignalRcs({}, {
      phone: '+919999999999', mtype: 'text', response: 'Yes, send me the offer',
      status: 'received', from: '+919999999999', st: '2026-09-03T11:15:30Z',
      response_type: 'text', webhook_type: 'rcs_user_response',
      tlmsgid: 'msg_987654321', camp_id: 'camp_7',
    });
    const ev = calls.find((c) => c.path.startsWith('/rest/v1/events'));
    assert.ok(ev, 'postback produced no event — it was dropped, which is the original bug');
    assert.strictEqual(ev.body.name, 'rcs_user_response');
    assert.strictEqual(ev.body.profile_id, 'p-resolved');
    assert.strictEqual(ev.body.properties.postback, 'Yes, send me the offer');
    assert.strictEqual(ev.body.properties.response_type, 'text');
    assert.strictEqual(ev.body.properties.tlmsgid, 'msg_987654321');
    assert.strictEqual(ev.body.properties.camp_id, 'camp_7');
    assert.strictEqual(ev.body.idempotency_key, 'trustsignal:rcs:user_response:msg_987654321');
  });

  await t('the postback is attributed by PHONE, not by provider_message_id', async () => {
    const calls = stubResolving(null);
    await handleTrustsignalRcs({}, {
      phone: '9999999999', response: 'Tell me more', webhook_type: 'rcs_user_response',
      tlmsgid: 'msg_1', st: '2026-09-03T11:15:30Z',
    });
    const rpc = calls.find((c) => c.path.startsWith('/rest/v1/rpc/resolve_identity'));
    assert.ok(rpc, 'identity was never resolved');
    // bare 10-digit normalises to E.164 +91 via shopify.normalizePhone
    assert.deepStrictEqual(rpc.body.p_identifiers, [{ type: 'phone', value: '+919999999999' }]);
    // and it must NOT have gone looking for a message row it can never find
    assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/messages?provider_message_id=')),
      'user_response still hit the message lookup that used to swallow it');
  });

  await t('a postback with no usable phone is logged and dropped, never inserted unattributed', async () => {
    const calls = stubResolving(null);
    await handleTrustsignalRcs({}, {
      response: 'orphan', webhook_type: 'rcs_user_response', tlmsgid: 'msg_2',
      st: '2026-09-03T11:15:30Z',
    });
    assert.ok(!calls.some((c) => c.path.startsWith('/rest/v1/events')),
      'inserted an event with no profile attribution');
  });

  await t('a status event still resolves by provider_message_id (no regression from the reorder)', async () => {
    const calls = stubResolving({ ...RCS_MSG });
    await handleTrustsignalRcs({}, { transaction_id: 'tx1', status: 'delivered', route: 'rcs' });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'ordinary DLR stopped being applied');
    assert.strictEqual(patch.body.status, 'delivered');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
