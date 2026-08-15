// Node unit tests for campaign audience EXCLUSIONS (S276).
// Run: node test/campaign-exclusions.test.js
//
// The SQL predicate itself (comms.campaign_excluded) is verified against live data; these cover
// the WORKER's half: that the rules are read off the campaign row, threaded into every RPC call,
// re-sent on EVERY page of the fan-out (not snapshotted at start), that exclusion segments get
// materialized before they are trusted, and that `sendable` — not `reachable` — is what the
// approval threshold and the audience snapshot are judged on.
const assert = require('assert');
const A = require('../src/auth.js');
const G = require('../src/gate.js');   // for _clearSettingsCache — the quiet-hours stub below
const CAMP = require('../src/campaigns.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const EXCL = {
  exclude_segment_ids: ['SEG-X', 'SEG-Y'],
  exclude_campaign_ids: ['CAMP-OLD'],
  exclude_contacted_hours: 24,
};
const SENDING = { id: 'C', status: 'sending', segment_id: 'S', template_id: 'T',
  channel: 'whatsapp', purpose: 'utility', name: 'x', vars: {}, ...EXCL };

(async () => {
  await t('exclusionArgs maps the row onto the RPC param names; missing/null fields degrade to off', () => {
    assert.deepEqual(CAMP.exclusionArgs(SENDING), {
      p_exclude_segments: ['SEG-X', 'SEG-Y'],
      p_exclude_campaigns: ['CAMP-OLD'],
      p_exclude_contacted_hours: 24,
    });
    // A campaign predating the migration has no columns at all — must not become `undefined`
    // in the JSON body, which PostgREST would reject or read as a missing argument.
    assert.deepEqual(CAMP.exclusionArgs({ id: 'old' }), {
      p_exclude_segments: [], p_exclude_campaigns: [], p_exclude_contacted_hours: null,
    });
  });

  await t('every fan-out page re-sends the exclusion rules (live re-evaluation, not a start snapshot)', async () => {
    const calls = [];
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [SENDING] };
      if (path.includes('campaign_recipients')) {
        calls.push(JSON.parse(opts.body));
        // full page → the fan-out continues to a second page
        return { ok: true, data: [
          { profile_id: 'P1', address: '911' }, { profile_id: 'P2', address: '912' },
          { profile_id: 'P3', address: '913' }, { profile_id: 'P4', address: '914' }] };
      }
      if (path.includes('/messages?on_conflict')) return { ok: true, data: [{ id: 'R' + calls.length }] };
      return { ok: true, data: [] };
    };
    const enq = [];
    const env = { BROADCAST_QUEUE: { send: async (m) => enq.push(m) } };
    await CAMP.processQueueMessage(env, { campaignId: 'C', after: null });
    await CAMP.processQueueMessage(env, { campaignId: 'C', after: 'P4' });   // the continuation page
    assert.equal(calls.length, 2, 'both pages queried recipients');
    for (const [i, body] of calls.entries()) {
      assert.deepEqual(body.p_exclude_segments, ['SEG-X', 'SEG-Y'], `page ${i + 1} carries segment exclusions`);
      assert.deepEqual(body.p_exclude_campaigns, ['CAMP-OLD'], `page ${i + 1} carries campaign exclusions`);
      assert.equal(body.p_exclude_contacted_hours, 24, `page ${i + 1} carries the time window`);
    }
    assert.equal(calls[1].p_after, 'P4', 'continuation keeps the keyset cursor');
  });

  await t('a campaign with NO exclusions still sends valid empty params (back-compat)', async () => {
    let body = null;
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C') && (!opts.method || opts.method === 'GET'))
        return { ok: true, data: [{ ...SENDING, exclude_segment_ids: [], exclude_campaign_ids: [], exclude_contacted_hours: null }] };
      if (path.includes('campaign_recipients')) { body = JSON.parse(opts.body); return { ok: true, data: [] }; }
      return { ok: true, data: [] };
    };
    await CAMP.processQueueMessage({ BROADCAST_QUEUE: { send: async () => {} } }, { campaignId: 'C', after: null });
    assert.deepEqual(body.p_exclude_segments, []);
    assert.deepEqual(body.p_exclude_campaigns, []);
    assert.equal(body.p_exclude_contacted_hours, null);
  });

  await t('exclusion segments are MATERIALIZED before the reach count trusts their members', async () => {
    const materialized = [];
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/rpc/materialize_segment')) { materialized.push(JSON.parse(opts.body).p_segment_id); return { ok: true, data: 1 }; }
      if (path.includes('/rpc/campaign_reach')) return { ok: true, data: [{ total: 100, reachable: 90, excluded: 40, sendable: 50 }] };
      return { ok: true, data: [] };
    };
    const r = await CAMP.reachableCount({}, SENDING);
    // target segment first, then every exclusion segment — a stale exclusion set silently lets
    // through exactly the people it was meant to hold back (PATTERN-176).
    assert.deepEqual(materialized, ['S', 'SEG-X', 'SEG-Y']);
    assert.deepEqual(r, { total: 100, reachable: 90, excluded: 40, sendable: 50 });
  });

  await t('a failing exclusion-segment materialize does not abort the campaign', async () => {
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/rpc/materialize_segment')) {
        const id = JSON.parse(opts.body).p_segment_id;
        return id === 'SEG-X' ? { ok: false, status: 500, data: null } : { ok: true, data: 1 };
      }
      if (path.includes('/rpc/campaign_reach')) return { ok: true, data: [{ total: 10, reachable: 9, excluded: 1, sendable: 8 }] };
      return { ok: true, data: [] };
    };
    const r = await CAMP.reachableCount({}, SENDING);
    assert.equal(r.sendable, 8, 'best-effort: one bad exclusion segment must not block the count');
  });

  await t('approval threshold + audience_snapshot are judged on SENDABLE, not reachable', async () => {
    // reachable 40,000 (over the 500 threshold) but only 300 sendable after exclusions →
    // must auto-approve on 300 and snapshot 300. Judging on `reachable` here would send a
    // campaign back for approval on an audience that does not exist.
    const APPROVED = { id: 'C3', status: 'approved', approved_by: null, segment_id: 'S', template_id: 'T',
      channel: 'email', purpose: 'marketing', name: 'z', vars: {}, ...EXCL };
    let claimBody = null;
    let queued = false;
    // ⚠️ Quiet hours must be stubbed EXEMPT and the gate cache cleared, or this test fails by
    // TIME OF DAY: startCampaign's clock guard (2026-08-15) falls back to the global 21:00–09:00
    // window when the channel_quiet_hours read returns nothing recognisable, so an evening run
    // refused the send and this suite went red at 23:12 having passed all afternoon. This suite
    // tests exclusions, not the clock — the clock has its own suite (campaign-budget-block).
    G._clearSettingsCache();
    A.sbComms = async (path, env, opts = {}) => {
      if (path.includes('/campaigns?id=eq.C3') && (!opts.method || opts.method === 'GET')) return { ok: true, data: [APPROVED] };
      if (path.includes('/rpc/materialize_segment')) return { ok: true, data: 1 };
      if (path.includes('/rpc/campaign_reach')) return { ok: true, data: [{ total: 50000, reachable: 40000, excluded: 39700, sendable: 300 }] };
      if (path.includes('channel_quiet_hours')) return { ok: true, data: [{ channel: 'email', enabled: false, start_time: '22:00', end_time: '08:00' }] };
      if (path.includes('send_budget_status')) return { ok: true, data: [{ budget: null, used: 0, remaining: null }] };
      if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{ approval_required_marketing: true, approval_audience_threshold: 500 }] };
      if (path.includes('/campaigns?id=eq.C3') && path.includes('status=in.') && opts.method === 'PATCH') {
        claimBody = JSON.parse(opts.body); return { ok: true, data: [APPROVED] };
      }
      return { ok: true, data: [] };
    };
    const r = await CAMP.startCampaign({ BROADCAST_QUEUE: { send: async () => { queued = true; } } }, 'C3', 'me');
    assert.equal(r.ok, true, 'sendable 300 is under the 500 threshold → sends without re-approval');
    assert.equal(r.audience, 300, 'the reported audience is the number that will actually receive');
    assert.ok(queued, 'fan-out enqueued');
    assert.equal(claimBody.audience_snapshot, 300, 'snapshot records sendable, not reachable');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
