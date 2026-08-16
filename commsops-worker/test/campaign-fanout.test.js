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
// One exactly-full page, sized from the real constant so the continuation branch is genuinely hit.
const PAGE = Array.from({ length: CAMP.SENDS_PER_MSG },
  (_, i) => ({ profile_id: `P${i + 1}`, address: `p${i + 1}@b.com` }));
const LAST_PROFILE = PAGE[PAGE.length - 1].profile_id;

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
      // A FULL page — derived from SENDS_PER_MSG, never restated. The continuation only fires on
      // `recs.length === SENDS_PER_MSG`, so a hardcoded count turns this into a test of the
      // drain-the-shard branch the moment the constant moves (it did: 5 → 75, and this test then
      // failed for years-of-nothing reasons while still being read as evidence of a real fan-out bug).
      if (path.includes('campaign_recipients')) return { ok: true, data: PAGE };
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
    assert.equal(enq[0].after, LAST_PROFILE);
    assert.ok(heartbeatPatch, 'a processed full page must PATCH the campaign heartbeat (status=eq.sending filter)');
    assert.ok(heartbeatPatch.path.includes('id=eq.C'), 'heartbeat PATCH must target this campaign id');
    assert.ok(!!heartbeatPatch.body.updated_at, 'heartbeat PATCH body must carry updated_at');
  });

  await t('auto-approved campaign whose dynamic segment outgrew the threshold is sent back for approval, not fanned out (review M2)', async () => {
    const APPROVED_CAMP = { id: 'C2', status: 'approved', approved_by: null, segment_id: 'S', template_id: 'T',
      channel: 'email', purpose: 'marketing', name: 'y', vars: {} };
    let claimPatchCalled = false;
    let pendingPatchBody = null;
    let queuedSend = false;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C2') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [APPROVED_CAMP] };
      if (path.includes('/rpc/materialize_segment')) return { ok: true, data: null };
      if (path.includes('/segments?id=eq.')) return { ok: true, data: [{ definition: {} }] };
      // S276: reachableCount now reads campaign_reach (exclusion-aware), not preview_segment.
      if (path.includes('/rpc/campaign_reach')) return { ok: true, data: [{ total: 40000, reachable: 40000, excluded: 0, sendable: 40000 }] };
      if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{ approval_required_marketing: true, approval_audience_threshold: 500 }] };
      // The atomic sending-claim PATCH filters on status=in.(approved,scheduled) — that must never fire.
      if (path.includes('/campaigns?id=eq.C2') && path.includes('status=in.') && opts.method === 'PATCH') {
        claimPatchCalled = true; return { ok: true, data: [APPROVED_CAMP] };
      }
      // The M2 fix PATCHes the campaign straight to pending_approval instead.
      if (path.includes('/campaigns?id=eq.C2') && opts.method === 'PATCH') {
        pendingPatchBody = JSON.parse(opts.body); return { ok: true, data: [APPROVED_CAMP] };
      }
      return { ok: true, data: [] };
    };
    const r = await CAMP.startCampaign({ BROADCAST_QUEUE: { send: async () => { queuedSend = true; } } }, 'C2', 'scheduler');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'audience_grew_needs_approval');
    assert.ok(!claimPatchCalled, 'must NOT claim/flip to sending — the atomic-claim PATCH must never fire');
    assert.ok(!queuedSend, 'must NOT enqueue a fan-out message');
    assert.ok(pendingPatchBody, 'must PATCH the campaign');
    assert.equal(pendingPatchBody.status, 'pending_approval');
    assert.equal(pendingPatchBody.audience_snapshot, 40000);
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
