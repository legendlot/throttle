// Node unit tests for A/B arm assignment in the campaign fan-out (adversarial review of 89eadadb).
// Covers: holdout arms must receive NOTHING, a real arm sends with ITS template_id/variant_id,
// zero-variant campaigns are byte-identical to pre-A/B behaviour, and startCampaign validates a
// SINGLE-variant campaign (not just >=2) before it can fan out.
// Run: node test/campaign-variants-fanout.test.js
const assert = require('assert');
const A = require('../src/auth.js');
const CAMP = require('../src/campaigns.js');
const { pickVariant } = require('../src/variants.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

// Minimal sender row: 'all' purpose + single-sender fallback means pickSender always resolves it,
// regardless of the campaign's purpose — keeps these tests from needing to mirror send.js's full
// sender-scoring matrix.
const SENDER_ROW = { id: 'S1', channel: 'email', status: 'active', purpose: 'all',
  created_at: '2020-01-01T00:00:00Z', metadata: {}, address: 'sender@test.com' };

(async () => {
  await t('holdout arm receives NO send; real arm does (arm.template_id === null must not fall back to camp.template_id)', async () => {
    const campaignId = 'CVF1';
    const CAMPROW = { id: campaignId, status: 'sending', segment_id: 'S', template_id: 'CAMP_DEFAULT',
      channel: 'email', purpose: 'utility', name: 'x', vars: {} };
    const variants = [
      { id: 'a1', label: 'A', template_id: 'TPL_A', weight: 50, sort_order: 1 },
      { id: 'b1', label: 'B', template_id: null, weight: 50, sort_order: 2 },   // HOLDOUT
    ];
    // Find real profile_ids that this exact (campaignId, variants) pair assigns to each arm —
    // pickVariant is a pure hash, so this mirrors production assignment exactly rather than
    // asserting against a hand-picked fixture that could drift from the real function.
    const forArmA = [], forArmB = [];
    for (let i = 0; i < 200 && (forArmA.length < 2 || forArmB.length < 2); i++) {
      const pid = `P${i}`;
      const arm = pickVariant(campaignId, pid, variants);
      if (arm?.id === 'a1' && forArmA.length < 2) forArmA.push(pid);
      if (arm?.id === 'b1' && forArmB.length < 2) forArmB.push(pid);
    }
    assert.equal(forArmA.length, 2, 'test setup: need 2 profiles landing on the real arm');
    assert.equal(forArmB.length, 2, 'test setup: need 2 profiles landing on the holdout arm');

    const recs = [...forArmA, ...forArmB].map((pid) => ({ profile_id: pid, address: `${pid}@test.com` }));
    const dedupReserveCalls = [];   // one call per send() ATTEMPT — proves whether send() ran at all
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes(`/campaigns?id=eq.${campaignId}`) && (!opts.method || opts.method === 'GET'))
        return { ok: true, data: [CAMPROW] };
      if (path.includes(`/campaign_variants?campaign_id=eq.${campaignId}`)) return { ok: true, data: variants };
      if (path.includes('/rpc/campaign_recipients')) return { ok: true, data: recs };
      if (path.includes('/messages?on_conflict')) {
        const body = JSON.parse(opts.body);
        dedupReserveCalls.push(body.dedup_key);
        return { ok: true, data: [{ id: 'R' + dedupReserveCalls.length }] };
      }
      if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };   // not found → send() resolves 'failed', not a throw
      if (path.includes(`/campaigns?id=eq.${campaignId}`) && opts.method === 'PATCH') return { ok: true, data: [CAMPROW] };
      return { ok: true, data: [] };
    };
    await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async () => {} } }, { campaignId, after: null });

    assert.ok(dedupReserveCalls.length < recs.length, `send() must be attempted for FEWER than all ${recs.length} recipients (got ${dedupReserveCalls.length})`);
    assert.equal(dedupReserveCalls.length, 2, 'send() must be attempted exactly for the 2 real-arm profiles');
    for (const pid of forArmB) {
      assert.ok(!dedupReserveCalls.includes(`campaign:${campaignId}:${pid}`), `holdout profile ${pid} must NOT have been sent to`);
    }
    for (const pid of forArmA) {
      assert.ok(dedupReserveCalls.includes(`campaign:${campaignId}:${pid}`), `real-arm profile ${pid} must have been sent to`);
    }
  });

  await t('a non-holdout arm sends with THAT arm\'s template_id and stamps its variant_id (not camp.template_id)', async () => {
    const campaignId = 'CVF2';
    const CAMPROW = { id: campaignId, status: 'sending', segment_id: 'S', template_id: 'CAMP_DEFAULT',
      channel: 'email', purpose: 'utility', name: 'x', vars: {} };
    // Single arm → pickVariant's arms.length===1 shortcut always returns it, no hunting for a
    // matching profile_id needed.
    const variants = [{ id: 'a1', label: 'A', template_id: 'TPL_A', weight: 100, sort_order: 1 }];
    const recs = [{ profile_id: 'PX', address: 'px@test.com' }];
    const templateRequests = [];
    let writtenRow = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes(`/campaigns?id=eq.${campaignId}`) && (!opts.method || opts.method === 'GET'))
        return { ok: true, data: [CAMPROW] };
      if (path.includes(`/campaign_variants?campaign_id=eq.${campaignId}`)) return { ok: true, data: variants };
      if (path.includes('/rpc/campaign_recipients')) return { ok: true, data: recs };
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [{ id: 'RESV1' }] };
      if (path.includes('/templates?id=eq.')) {
        templateRequests.push(path);
        return { ok: true, data: [{ id: 'TPL_A', content: { subject: 's', html_body: 'h', text_body: 't' }, variables: [] }] };
      }
      if (path.includes('/sender_identities')) return { ok: true, data: [SENDER_ROW] };
      if (path.includes('/profiles?id=eq.')) return { ok: true, data: [] };
      if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{}] };   // test_mode default ON → gate blocks before any network adapter call
      if (path.includes('/messages?id=eq.RESV1') && opts.method === 'PATCH') {
        writtenRow = JSON.parse(opts.body);
        return { ok: true, data: [{ id: 'RESV1' }] };
      }
      if (path.includes(`/campaigns?id=eq.${campaignId}`) && opts.method === 'PATCH') return { ok: true, data: [CAMPROW] };
      return { ok: true, data: [] };
    };
    await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async () => {} } }, { campaignId, after: null });

    assert.ok(templateRequests.some((p) => p.includes('TPL_A')), 'must fetch the ARM template, not camp.template_id');
    assert.ok(!templateRequests.some((p) => p.includes('CAMP_DEFAULT')), 'must NOT fetch camp.template_id when an arm applies');
    assert.ok(writtenRow, 'the messages row must have been written');
    assert.equal(writtenRow.template_id, 'TPL_A');
    assert.equal(writtenRow.variant_id, 'a1');
  });

  await t('zero variants → send uses camp.template_id and variant_id null (regression guard, every existing campaign)', async () => {
    const campaignId = 'CVF3';
    const CAMPROW = { id: campaignId, status: 'sending', segment_id: 'S', template_id: 'CAMP_DEFAULT',
      channel: 'email', purpose: 'utility', name: 'x', vars: {} };
    const recs = [{ profile_id: 'PY', address: 'py@test.com' }];
    const templateRequests = [];
    let writtenRow = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes(`/campaigns?id=eq.${campaignId}`) && (!opts.method || opts.method === 'GET'))
        return { ok: true, data: [CAMPROW] };
      if (path.includes(`/campaign_variants?campaign_id=eq.${campaignId}`)) return { ok: true, data: [] };   // NO variants
      if (path.includes('/rpc/campaign_recipients')) return { ok: true, data: recs };
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [{ id: 'RESV2' }] };
      if (path.includes('/templates?id=eq.')) {
        templateRequests.push(path);
        return { ok: true, data: [{ id: 'CAMP_DEFAULT', content: { subject: 's', html_body: 'h', text_body: 't' }, variables: [] }] };
      }
      if (path.includes('/sender_identities')) return { ok: true, data: [SENDER_ROW] };
      if (path.includes('/profiles?id=eq.')) return { ok: true, data: [] };
      if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{}] };
      if (path.includes('/messages?id=eq.RESV2') && opts.method === 'PATCH') {
        writtenRow = JSON.parse(opts.body);
        return { ok: true, data: [{ id: 'RESV2' }] };
      }
      if (path.includes(`/campaigns?id=eq.${campaignId}`) && opts.method === 'PATCH') return { ok: true, data: [CAMPROW] };
      return { ok: true, data: [] };
    };
    await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async () => {} } }, { campaignId, after: null });

    assert.ok(templateRequests.some((p) => p.includes('CAMP_DEFAULT')), 'must fall back to camp.template_id when there are no variants');
    assert.ok(writtenRow, 'the messages row must have been written');
    assert.equal(writtenRow.template_id, 'CAMP_DEFAULT');
    assert.equal(writtenRow.variant_id, null);
  });

  await t('startCampaign rejects a SINGLE unapproved-template variant (proves the >=1 fix; >=2 would have let this through)', async () => {
    const campaignId = 'CVF4';
    const CAMPROW = { id: campaignId, status: 'approved', segment_id: 'S', template_id: 'CAMP_DEFAULT',
      channel: 'whatsapp', purpose: 'marketing', name: 'x', vars: {}, approved_by: 'someone' };
    const variants = [{ id: 'a1', label: 'A', template_id: 'TPL_A', weight: 100, sort_order: 1 }];
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes(`/campaigns?id=eq.${campaignId}`) && (!opts.method || opts.method === 'GET'))
        return { ok: true, data: [CAMPROW] };
      if (path.includes(`/campaign_variants?campaign_id=eq.${campaignId}`)) return { ok: true, data: variants };
      if (path.includes('/templates?id=in.')) return { ok: true, data: [{ id: 'TPL_A', name: 'tpl', approval_status: 'PENDING' }] };
      // Nothing past the guard should be reached — reachableCount / claim etc. would need more
      // mocking, and their absence here is itself part of the proof the function returned early.
      return { ok: true, data: [] };
    };
    const r = await CAMP.startCampaign({}, campaignId, 'tester');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'variant_A_template_not_approved');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
