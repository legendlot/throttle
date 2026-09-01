// Fan-out over the FROZEN roster + holdout evidence (frozen-roster Task 6).
// Run: node test/campaign-roster-fanout.test.js
//
// UNDER TEST: a rostered campaign pages from comms.campaign_roster (its shard, its cursor) and a
// pre-roster campaign falls back to the live query untouched; holdout-assigned recipients get a
// skipped/holdout row instead of vanishing (a holdout with no row is indistinguishable from a
// missed recipient in reconciliation — §9.17); the per-page exclusion batch still applies on the
// roster path, and excluded-and-holdout resolves to excluded.
const assert = require('assert');
const A = require('../src/auth.js');
const CAMP = require('../src/campaigns.js');
const { pickVariant } = require('../src/variants.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const CID = 'CRF1';
const ROSTERED = (over = {}) => ({ id: CID, status: 'sending', segment_id: 'S', template_id: 'T',
  channel: 'email', purpose: 'utility', name: 'x', vars: {},
  exclude_segment_ids: [], exclude_campaign_ids: [], exclude_contacted_hours: null,
  roster_built_at: '2026-08-15T20:00:00Z', roster_size: 100, shard_count: 3, ...over });

function stub({ camp = ROSTERED(), rosterPage = [], variants = [], excludedIds = [] } = {}) {
  const seen = { rosterGets: [], rpcCalls: 0, skipInserts: [], reserves: [], continued: null };
  A.sbComms = async (path, env, opts = {}) => {
    if (path.includes(`/campaigns?id=eq.${CID}`) && (!opts.method || opts.method === 'GET')) return { ok: true, data: [camp] };
    if (path.includes('/campaign_variants?')) return { ok: true, data: variants };
    if (path.includes('/campaign_roster?')) { seen.rosterGets.push(path); return { ok: true, data: rosterPage }; }
    if (path.includes('/rpc/campaign_recipients')) { seen.rpcCalls++; return { ok: true, data: rosterPage }; }
    // ⚠️ Returns ROWS, not ids — `TABLE(profile_id uuid, cause text)` since S326's
    // `comms_campaign_excluded_batch_reports_cause_v1`. A bare id array makes campaigns.js read
    // `r.profile_id` off a string, so the excluded set matches nobody. `recent_contact` is the
    // truthful cause here: the campaign fixture below excludes via `exclude_contacted_hours`.
    if (path.includes('/rpc/campaign_excluded_batch'))
      return { ok: true, data: excludedIds.map((x) => (typeof x === 'string' ? { profile_id: x, cause: 'recent_contact' } : x)) };
    if (path === '/rest/v1/messages' && opts.method === 'POST') { seen.skipInserts.push(JSON.parse(opts.body)); return { ok: true, data: [] }; }
    if (path.includes('/messages?on_conflict')) {
      seen.reserves.push(JSON.parse(opts.body).profile_id);
      return { ok: true, data: [{ id: 'R' + seen.reserves.length }] };
    }
    if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };
    if (path.includes(`/campaigns?id=eq.${CID}`) && opts.method === 'PATCH') return { ok: true, data: [camp] };
    return { ok: true, data: [] };
  };
  const ENV = { BROADCAST_QUEUE: { send: async (m) => { seen.continued = m; } } };
  return { seen, ENV };
}
const RECS = (n) => Array.from({ length: n }, (_, i) => ({ profile_id: `P${i}`, address: `p${i}@t.com` }));

(async () => {
  await t('a rostered campaign pages from campaign_roster — its shard, its cursor, never the RPC', async () => {
    const { seen, ENV } = stub({ rosterPage: RECS(4) });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: 'P-CUR', shard: 2, shardCount: 3 });
    assert.equal(seen.rpcCalls, 0, 'live query must not run when a roster exists');
    assert.equal(seen.rosterGets.length, 1);
    const q = seen.rosterGets[0];
    assert.ok(q.includes('shard=eq.2'), 'the chain walks ITS shard');
    assert.ok(q.includes('profile_id=gt.P-CUR'), 'keyset cursor');
    assert.ok(q.includes('order=profile_id.asc'), 'stable walk order');
    assert.equal(seen.reserves.length, 4, 'everyone on the page attempted');
  });

  await t('the first page (after:null) omits the cursor filter', async () => {
    const { seen, ENV } = stub({ rosterPage: RECS(2) });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null, shard: 0, shardCount: 3 });
    assert.ok(!seen.rosterGets[0].includes('profile_id=gt'), 'no gt filter on the seed page');
  });

  await t('a PRE-roster campaign falls back to the live query — never stranded across the deploy', async () => {
    const { seen, ENV } = stub({ camp: ROSTERED({ roster_built_at: null }), rosterPage: RECS(2) });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null, shard: 0, shardCount: 1 });
    assert.equal(seen.rosterGets.length, 0);
    assert.equal(seen.rpcCalls, 1, 'the original path, untouched');
  });

  await t('holdout recipients get a skipped/holdout row WITH their arm, and no send', async () => {
    const variants = [
      { id: 'a1', label: 'A', template_id: 'TPL_A', weight: 50, sort_order: 1 },
      { id: 'b1', label: 'B', template_id: null, weight: 50, sort_order: 2 },   // HOLDOUT
    ];
    // find profiles landing on each arm with the REAL hash, as the variants suite does
    const forA = [], forB = [];
    for (let i = 0; i < 300 && (forA.length < 2 || forB.length < 2); i++) {
      const arm = pickVariant(CID, `P${i}`, variants);
      if (arm?.id === 'a1' && forA.length < 2) forA.push(`P${i}`);
      if (arm?.id === 'b1' && forB.length < 2) forB.push(`P${i}`);
    }
    const page = [...forA, ...forB].map((pid) => ({ profile_id: pid, address: `${pid}@t.com` }));
    const { seen, ENV } = stub({ rosterPage: page, variants });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null, shard: 0, shardCount: 3 });
    assert.equal(seen.skipInserts.length, 1, 'one array insert for the page');
    const rows = seen.skipInserts[0];
    assert.deepEqual(rows.map((r) => r.profile_id).sort(), [...forB].sort(), 'exactly the holdouts');
    assert.ok(rows.every((r) => r.status === 'skipped' && r.reason === 'holdout' && r.variant_id === 'b1'),
      'evidence carries the arm — assigned, deliberately unsent, visible');
    assert.deepEqual(seen.reserves.sort(), [...forA].sort(), 'real arm sends; holdout does not');
  });

  await t('excluded-and-holdout resolves to EXCLUDED — one row, one reason', async () => {
    const variants = [
      { id: 'a1', label: 'A', template_id: 'TPL_A', weight: 50, sort_order: 1 },
      { id: 'b1', label: 'B', template_id: null, weight: 50, sort_order: 2 },
    ];
    let holdoutPid = null;
    for (let i = 0; i < 300 && !holdoutPid; i++)
      if (pickVariant(CID, `P${i}`, variants)?.id === 'b1') holdoutPid = `P${i}`;
    const { seen, ENV } = stub({
      camp: ROSTERED({ exclude_contacted_hours: 24 }),
      rosterPage: [{ profile_id: holdoutPid, address: 'x@t.com' }],
      variants, excludedIds: [holdoutPid] });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null, shard: 0, shardCount: 3 });
    const all = seen.skipInserts.flat();
    assert.equal(all.length, 1, 'one row, not two');
    assert.equal(all[0].reason, 'excluded_recent_contact', 'exclusion wins — it was evidenced first');
  });

  await t('a SHORT roster page finishes the shard (finish_campaign_shard), a full one continues', async () => {
    // short page (< SENDS_PER_MSG) → no continuation, shard finish RPC fires
    let finishes = 0;
    const { seen, ENV } = stub({ rosterPage: RECS(3) });
    const inner = A.sbComms;
    A.sbComms = async (path, env, opts = {}) => path.includes('finish_campaign_shard')
      ? (finishes++, { ok: true, data: false }) : inner(path, env, opts);
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null, shard: 1, shardCount: 3 });
    assert.equal(seen.continued, null, 'short page → no continuation');
    assert.equal(finishes, 1, 'the shard reports itself drained');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
