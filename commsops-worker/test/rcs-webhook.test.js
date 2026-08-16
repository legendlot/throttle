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

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
