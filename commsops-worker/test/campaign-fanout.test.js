// Node unit tests for campaign fan-out failure handling (hostile-review C2 / H3).
// Run: node test/campaign-fanout.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const CAMP = require('../src/campaigns.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;
const CAMPROW = { id: 'C', status: 'sending', segment_id: 'S', template_id: 'T', channel: 'email', purpose: 'utility', name: 'x', vars: {} };

(async () => {
  await t('recipients-RPC failure → THROWS (queue retries); campaign is NOT marked sent', async () => {
    let sentPatch = false;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [CAMPROW] };
      if (path.includes('campaign_recipients')) return { ok: false, status: 500, data: null };
      if (path.includes('/campaigns?id=eq.C') && opts.method === 'PATCH') { sentPatch = true; return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    let threw = false;
    try { await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async () => {} } }, { campaignId: 'C', after: null }); }
    catch (e) { threw = true; assert.ok(String(e.message).includes('campaign_recipients_failed')); }
    assert.ok(threw, 'must throw so the queue retries');
    assert.ok(!sentPatch, 'must NOT mark the campaign sent');
  });

  await t('one recipient throwing does not kill the page; continuation still enqueues; heartbeat PATCH fires', async () => {
    const enq = [];
    let heartbeatPatch = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [CAMPROW] };
      if (path.includes('campaign_recipients')) return { ok: true, data: [
        { profile_id: 'P1', address: 'a@b.com' }, { profile_id: 'P2', address: 'b@b.com' },
        { profile_id: 'P3', address: 'c@b.com' }, { profile_id: 'P4', address: 'd@b.com' } ] };  // == SENDS_PER_MSG
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [{ id: 'R' + Math.random() }] };
      if (path.includes('/templates?id=eq.')) {
        // throw RAW on the first template lookup only → recipient 1's send() throws
        if (!global.__threw_once) { global.__threw_once = true; throw new Error('boom'); }
        return { ok: true, data: [] };   // others: template_not_found → failed result, no throw
      }
      if (path.includes('/campaigns?id=eq.C') && path.includes('status=eq.sending') && opts.method === 'PATCH') {
        heartbeatPatch = { path, body: JSON.parse(opts.body) };
        return { ok: true, data: [CAMPROW] };
      }
      return { ok: true, data: [] };
    };
    global.__threw_once = false;
    await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async (m) => enq.push(m) } }, { campaignId: 'C', after: null });
    assert.equal(enq.length, 1, 'continuation enqueued despite recipient-1 throw');
    assert.equal(enq[0].after, 'P4');
    assert.ok(heartbeatPatch, 'a processed full page must PATCH the campaign heartbeat (status=eq.sending filter)');
    assert.ok(heartbeatPatch.path.includes('id=eq.C'), 'heartbeat PATCH must target this campaign id');
    assert.ok(!!heartbeatPatch.body.updated_at, 'heartbeat PATCH body must carry updated_at');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
