// Status-rank guard (review M6) — out-of-order status webhooks can't downgrade the
// canonical `messages.status`. Exercises wa-webhooks.js's handleStatuses via its
// exported handler, stubbing A.sbComms per test/wa.test.js's pattern.
// Run: node test/status-rank.test.js

const assert = require('assert');
const A = require('../src/auth.js');
const waHook = require('../src/wa-webhooks.js');

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ok  ', name); },
    (e) => { fail++; console.log('  FAIL', name, '\n        ', e.message); });
}

// `status` here is the RAW Meta status (sent/delivered/read/failed) — parseStatusWebhook
// maps it to our canonical status via STATUS_MAP (read → opened).
const mk = (id, status) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
  statuses: [{ id, status, timestamp: '1700000000', recipient_id: '9199' }] } }] }] });

(async () => {
  await t('an opened row is NOT patched back to delivered (patch omits status)', async () => {
    const orig = A.sbComms;
    const patches = [];
    A.sbComms = async (path, env, init) => {
      if (path.startsWith('/rest/v1/messages?provider=eq.whatsapp'))
        return { ok: true, data: [{ id: 'msg-1', profile_id: 'prof-1', channel: 'whatsapp', status: 'opened' }] };
      if (path.startsWith('/rest/v1/messages?id=eq.')) { patches.push(JSON.parse(init.body)); return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    await waHook.handleStatuses({}, mk('m1', 'delivered'));   // late delivered receipt, after read
    A.sbComms = orig;
    assert.ok(!('status' in patches[0]), 'status field must be omitted from the PATCH');
  });

  await t('an opened row IS patched to failed (terminal always wins)', async () => {
    const orig = A.sbComms;
    const patches = [];
    A.sbComms = async (path, env, init) => {
      if (path.startsWith('/rest/v1/messages?provider=eq.whatsapp'))
        return { ok: true, data: [{ id: 'msg-1', profile_id: 'prof-1', channel: 'whatsapp', status: 'opened' }] };
      if (path.startsWith('/rest/v1/messages?id=eq.')) { patches.push(JSON.parse(init.body)); return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    await waHook.handleStatuses({}, mk('m2', 'failed'));
    A.sbComms = orig;
    assert.equal(patches[0].status, 'failed');
  });

  await t('delivered → opened is a normal upgrade and IS patched', async () => {
    const orig = A.sbComms;
    const patches = [];
    A.sbComms = async (path, env, init) => {
      if (path.startsWith('/rest/v1/messages?provider=eq.whatsapp'))
        return { ok: true, data: [{ id: 'msg-1', profile_id: 'prof-1', channel: 'whatsapp', status: 'delivered' }] };
      if (path.startsWith('/rest/v1/messages?id=eq.')) { patches.push(JSON.parse(init.body)); return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    await waHook.handleStatuses({}, mk('m3', 'read'));
    A.sbComms = orig;
    assert.equal(patches[0].status, 'opened');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
