// Roster build orchestration (frozen-roster Task 4). Run: node test/campaign-roster-build.test.js
//
// THE INVARIANTS UNDER TEST, in order of what they cost when wrong:
//   · shard_count is fixed at CLAIM time and every resume keeps the STORED value — roster rows are
//     hashed with it, so assignment-N ≠ walk-N orphans rows into shards nobody walks (§9.9).
//   · a partial build never stamps roster_built_at — its absence is what routes a resume back into
//     the BUILD; stamping early would send a truncated roster that reports itself complete (§9.1).
//   · the post-build approval re-check parks LOUDLY and seeds nothing — nobody is at a button
//     there (§9.14).
//   · a stop is honoured at every step: the in-flight chunk acks silently on a changed status, and
//     the atomic finalize's empty representation means "do not seed".
const assert = require('assert');
const A = require('../src/auth.js');
const G = require('../src/gate.js');
const CAMP = require('../src/campaigns.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const CID = 'CRB1';
const CAMPROW = (over = {}) => ({ id: CID, status: 'approved', segment_id: 'S', template_id: 'T',
  channel: 'whatsapp', purpose: 'marketing', name: 'Roster Build', approved_by: 'u1', vars: {},
  exclude_segment_ids: [], exclude_campaign_ids: [], exclude_contacted_hours: null,
  roster_built_at: null, roster_size: null, build_cursor: null, shard_count: 1, ...over });

// startCampaign-shaped stub: guards satisfied (quiet-exempt, no budget cap), reach fixed.
function stubStart({ camp = CAMPROW(), reachable = 25000 } = {}) {
  const seen = { claim: null, queued: [] };
  G._clearSettingsCache();
  A.sbComms = async (path, env, opts = {}) => {
    if (path.includes(`/campaigns?id=eq.${CID}`) && (!opts.method || opts.method === 'GET')) return { ok: true, data: [camp] };
    if (path.includes('campaign_variants')) return { ok: true, data: [] };
    if (path.includes('channel_quiet_hours')) return { ok: true, data: [{ channel: camp.channel, enabled: false, start_time: '22:00', end_time: '08:00' }] };
    if (path.includes('materialize_segment')) return { ok: true, data: null };
    if (path.includes('campaign_reach')) return { ok: true, data: [{ total: reachable, reachable, excluded: 0, sendable: reachable }] };
    if (path.includes('send_budget_status')) return { ok: true, data: [{ budget: null, used: 0, remaining: null }] };
    if (path.includes('/settings?id=eq.1')) return { ok: true, data: [{ approval_required_marketing: false }] };
    if (path.includes(`/campaigns?id=eq.${CID}`) && opts.method === 'PATCH') {
      seen.claim = JSON.parse(opts.body); return { ok: true, data: [{ ...camp, ...seen.claim }] };
    }
    return { ok: true, data: [] };
  };
  const ENV = { BROADCAST_QUEUE: { send: async (m) => seen.queued.push(m) } };
  return { seen, ENV };
}

// processBuildChunk-shaped stub.
function stubChunk({ camp = CAMPROW({ status: 'building_roster', shard_count: 3 }),
  chunk = { scanned: 15000, inserted: 9000, next_cursor: 'CUR-1', done: false, roster_total: null },
  chunkOk = true, finalizeEmpty = false, settings = { approval_required_marketing: false } } = {}) {
  const seen = { rpcCalls: [], patches: [], queued: [], alerts: 0 };
  G._clearSettingsCache();
  A.sbComms = async (path, env, opts = {}) => {
    if (path.includes(`/campaigns?id=eq.${CID}`) && (!opts.method || opts.method === 'GET')) return { ok: true, data: [camp] };
    if (path.includes('/rpc/build_roster_chunk')) {
      seen.rpcCalls.push(JSON.parse(opts.body));
      return chunkOk ? { ok: true, data: [chunk] } : { ok: false, status: 500, data: null };
    }
    if (path.includes('/settings?id=eq.1')) return { ok: true, data: [settings] };
    if (path.includes(`/campaigns?id=eq.${CID}`) && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body);
      seen.patches.push({ path, body });
      if (finalizeEmpty && path.includes('status=eq.building_roster')) return { ok: true, data: [] };
      return { ok: true, data: [{ ...camp, ...body }] };
    }
    return { ok: true, data: [] };
  };
  const ENV = { BROADCAST_QUEUE: { send: async (m) => seen.queued.push(m) } };
  return { seen, ENV };
}

(async () => {
  // ── startCampaign: build vs resume routing ──────────────────────────────────
  await t('a fresh send claims building_roster and enqueues the build — nothing fans out yet', async () => {
    const { seen, ENV } = stubStart({ reachable: 25000 });
    const r = await CAMP.startCampaign(ENV, CID, 'u1');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.building, true);
    assert.equal(r.estimated, 25000);
    assert.equal(seen.claim.status, 'building_roster');
    assert.equal(seen.claim.shard_count, 3, 'shardsFor(25000) = 3, fixed at claim time');
    assert.deepEqual(seen.queued, [{ kind: 'build_roster', campaignId: CID, after: null }],
      'exactly one build seed, no fan-out chains');
  });

  await t('a build-RESUME keeps the STORED shard_count and continues from the cursor', async () => {
    // Stopped mid-build: cursor set, roster_built_at null, shard_count 5 from the original claim.
    // shardsFor(800) would say 1 — using it would orphan rows already hashed % 5.
    const { seen, ENV } = stubStart({
      camp: CAMPROW({ status: 'stopped', build_cursor: 'CUR-7', shard_count: 5 }), reachable: 800 });
    const r = await CAMP.startCampaign(ENV, CID, 'u1');
    assert.equal(r.building, true);
    assert.equal(seen.claim.shard_count, 5, 'STORED shard_count, never shardsFor(sendable)');
    assert.equal(seen.queued[0].after, 'CUR-7', 'build continues from the persisted cursor');
  });

  await t('a roster-RESUME seeds the STORED shard_count of chains and never touches shard_count', async () => {
    const { seen, ENV } = stubStart({
      camp: CAMPROW({ status: 'sent', roster_built_at: '2026-08-15T20:00:00Z', roster_size: 48167, shard_count: 5 }),
      reachable: 12000 });   // shardsFor(12000)=2 — must NOT be used
    const r = await CAMP.startCampaign(ENV, CID, 'u1');
    assert.equal(r.building, undefined, 'roster path, not a rebuild');
    assert.equal(r.audience, 48167, 'audience from the frozen roster, not the drifted estimate');
    assert.equal(r.shards, 5);
    assert.ok(!('shard_count' in seen.claim), 'resume must not rewrite shard_count');
    assert.equal(seen.claim.shards_done, 0, 'reset, or the first chain to finish ends the campaign');
    assert.equal(seen.queued.length, 5);
    assert.ok(seen.queued.every((m) => m.shardCount === 5 && !m.kind));
  });

  // ── processBuildChunk ───────────────────────────────────────────────────────
  await t('a chunk on a non-building campaign acks silently — the stop is honoured', async () => {
    const { seen, ENV } = stubChunk({ camp: CAMPROW({ status: 'stopped' }) });
    await CAMP.processBuildChunk(ENV, { campaignId: CID, after: null });
    assert.equal(seen.rpcCalls.length, 0, 'no chunk RPC on a stopped campaign');
    assert.equal(seen.queued.length, 0);
  });

  await t('a not-done chunk persists the cursor, enqueues the next slice, and NEVER stamps roster_built_at', async () => {
    const { seen, ENV } = stubChunk();
    await CAMP.processBuildChunk(ENV, { campaignId: CID, after: null });
    assert.equal(seen.patches.length, 1);
    assert.equal(seen.patches[0].body.build_cursor, 'CUR-1');
    assert.ok(!('roster_built_at' in seen.patches[0].body),
      'a partial build must never present as finished (§9.1)');
    assert.deepEqual(seen.queued, [{ kind: 'build_roster', campaignId: CID, after: 'CUR-1' }]);
  });

  await t('the FINAL chunk finalizes atomically and seeds the stored shard_count of chains', async () => {
    const { seen, ENV } = stubChunk({
      chunk: { scanned: 400, inserted: 130, next_cursor: 'CUR-9', done: true, roster_total: 27130 } });
    await CAMP.processBuildChunk(ENV, { campaignId: CID, after: 'CUR-8' });
    const fin = seen.patches.find((x) => x.path.includes('status=eq.building_roster'));
    assert.ok(fin, 'finalize must be CONDITIONAL on still-building — a concurrent Stop wins');
    assert.equal(fin.body.status, 'sending');
    assert.equal(fin.body.roster_size, 27130);
    assert.equal(fin.body.audience_snapshot, 27130, 'one number, one source');
    assert.ok(fin.body.roster_built_at, 'stamped only here, by the completing chunk');
    assert.equal(seen.queued.length, 3, 'chains = stored shard_count');
    assert.deepEqual(seen.queued.map((m) => m.shard).sort(), [0, 1, 2]);
  });

  await t('an outgrown auto-approved campaign PARKS + alerts and seeds NOTHING (§9.14)', async () => {
    const { seen, ENV } = stubChunk({
      camp: CAMPROW({ status: 'building_roster', approved_by: null, shard_count: 3 }),
      chunk: { scanned: 10, inserted: 5, next_cursor: 'C', done: true, roster_total: 40000 },
      settings: { approval_required_marketing: true, approval_audience_threshold: 500 } });
    await CAMP.processBuildChunk(ENV, { campaignId: CID, after: 'C0' });
    const park = seen.patches[0];
    assert.equal(park.body.status, 'pending_approval');
    assert.equal(park.body.roster_size, 40000, 'the roster is complete and KEPT — only the send needs eyes');
    assert.ok(park.body.roster_built_at);
    assert.equal(seen.queued.length, 0, 'nothing fans out past a park');
  });

  await t('a human-approved campaign does NOT re-park on growth — approval stands', async () => {
    const { seen, ENV } = stubChunk({
      camp: CAMPROW({ status: 'building_roster', approved_by: 'afshaan', shard_count: 3 }),
      chunk: { scanned: 10, inserted: 5, next_cursor: 'C', done: true, roster_total: 40000 },
      settings: { approval_required_marketing: true, approval_audience_threshold: 500 } });
    await CAMP.processBuildChunk(ENV, { campaignId: CID, after: 'C0' });
    assert.equal(seen.queued.length, 3, 'seeds normally');
  });

  await t('a concurrent Stop at finalize (empty representation) seeds nothing and does not throw', async () => {
    const { seen, ENV } = stubChunk({
      chunk: { scanned: 10, inserted: 5, next_cursor: 'C', done: true, roster_total: 100 },
      finalizeEmpty: true });
    await CAMP.processBuildChunk(ENV, { campaignId: CID, after: 'C0' });
    assert.equal(seen.queued.length, 0);
  });

  await t('a failed chunk RPC THROWS — retry → DLQ, never a silently truncated roster', async () => {
    const { ENV } = stubChunk({ chunkOk: false });
    await assert.rejects(() => CAMP.processBuildChunk(ENV, { campaignId: CID, after: null }),
      /build_roster_chunk_failed/);
  });

  // ── stalled (Task 5) ────────────────────────────────────────────────────────
  await t('stallCampaign patches ONLY an in-flight campaign, and reports which', async () => {
    const patches = [];
    A.sbComms = async (path, env, opts = {}) => {
      patches.push(path);
      // conditional PATCH: in-flight → row back; finished → empty representation
      return { ok: true, data: path.includes('in.(building_roster,sending)') && !path.includes('MISS')
        ? [{ id: CID, name: 'Big Send', status: 'stalled' }] : [] };
    };
    const hit = await CAMP.stallCampaign({}, CID);
    assert.ok(hit && hit.status === 'stalled');
    assert.ok(patches[0].includes('status=in.(building_roster,sending)'),
      'a campaign that finished or was stopped between the failure and the DLQ write is left alone');
  });

  await t('a STALLED campaign resumes — into the BUILD without a roster, into the SEND with one', async () => {
    // no roster → build path, from the persisted cursor, stored shard_count kept
    let st = stubStart({ camp: CAMPROW({ status: 'stalled', build_cursor: 'CUR-3', shard_count: 4 }), reachable: 900 });
    let r = await CAMP.startCampaign(st.ENV, CID, 'u1');
    assert.equal(r.building, true, `stalled+no-roster must resume the build: ${JSON.stringify(r)}`);
    assert.equal(st.seen.claim.shard_count, 4);
    assert.equal(st.seen.queued[0].after, 'CUR-3');
    // roster → send path, chains from the stored count
    st = stubStart({ camp: CAMPROW({ status: 'stalled', roster_built_at: 'T', roster_size: 300, shard_count: 2 }) });
    r = await CAMP.startCampaign(st.ENV, CID, 'u1');
    assert.equal(r.building, undefined);
    assert.equal(st.seen.queued.length, 2, 'send-resume seeds the stored chains');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
