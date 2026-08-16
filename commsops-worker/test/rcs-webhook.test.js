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
  await t('Fallback event flips channel rcs→sms, keyed on fallback_from IS NULL', async () => {
    const calls = stub({ ...RCS_MSG });
    await handleTrustsignalRcs({}, { event: 'Fallback', transaction_id: 'tx1', sms_cost: '0.15' });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'no PATCH issued');
    assert.ok(patch.path.includes('fallback_from=is.null'), 'flip not keyed on fallback_from IS NULL');
    assert.strictEqual(patch.body.channel, 'sms');
    assert.strictEqual(patch.body.fallback_from, 'rcs');
    assert.strictEqual(patch.body.pricing.provider_credit, 0.15);   // SMS leg's credit, on the flip
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
    await handleTrustsignalRcs({}, { event: 'Click', transaction_id: 'tx1', url: 'https://x/y', timestamp: 'T' });
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
