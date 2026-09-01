// Per-page VISIBLE exclusion in the fan-out (frozen-roster spec §9.21, Task 2).
// Run: node test/campaign-excluded-batch.test.js
//
// THE CONTRACT UNDER TEST: an excluded profile leaves a `skipped/excluded_<cause>` row NAMING THE
// CAUSE the RPC reported (S326 — segment | prior_campaign | recent_contact) and
// is not sent; a failed batch check or a failed skip-write THROWS the page (retry) rather than
// soft-continuing; a campaign with no exclusion rules pays zero extra subrequests; and a page
// consisting entirely of excluded profiles still advances the chain's cursor.
//
// Stub conventions (match campaign-variants-fanout.test.js): send() runs FOR REAL against the
// stubbed sbComms — a call to `/messages?on_conflict` (the dedup reserve) is the proof a send was
// attempted. finalize PATCHes the reserved row, so a plain `POST /rest/v1/messages` (no query
// string) is unambiguously the page-level skip-row array insert.
const assert = require('assert');
const A = require('../src/auth.js');
const G = require('../src/gate.js');
const CAMP = require('../src/campaigns.js');
let pass = 0, fail = 0;
const t = (n, f) => Promise.resolve().then(f).then(() => { pass++; console.log('  ok  ', n); },
  (e) => { fail++; console.log('  FAIL', n, '\n        ', e.message); });
const orig = A.sbComms;

const CID = 'CEB1';
const CAMPROW = (over = {}) => ({ id: CID, status: 'sending', segment_id: 'S', template_id: 'T',
  channel: 'email', purpose: 'utility', name: 'x', vars: {},
  exclude_segment_ids: [], exclude_campaign_ids: ['11111111-1111-1111-1111-111111111111'],
  exclude_contacted_hours: null, ...over });

const RECS = (n) => Array.from({ length: n }, (_, i) => ({ profile_id: `P${i}`, address: `p${i}@t.com` }));

// ⚠️ THE RPC RETURNS ROWS, NOT IDS — `TABLE(profile_id uuid, cause text)`, since migration
// `comms_campaign_excluded_batch_reports_cause_v1` (S326). This stub returned a bare `['P1','P3']`
// for a while after that change and the file went red: `campaigns.js` maps `r.profile_id` over the
// response, which is `undefined` for a string, so the excluded set became `{undefined}`, matched
// nobody, and inserted an empty array. `cause` defaults to what THIS file's CAMPROW would really
// produce — it sets `exclude_campaign_ids` and nothing else, so the RPC's CASE lands on
// 'prior_campaign' (precedence: segment → prior_campaign → recent_contact).
function stub({ camp = CAMPROW(), recs = RECS(4), excludedIds = [], batchOk = true, skipInsertOk = true,
                cause = 'prior_campaign' } = {}) {
  const asRows = (xs) => xs.map((x) => (typeof x === 'string' ? { profile_id: x, cause } : x));
  const seen = { batchCalls: 0, skipRows: null, reserves: [], continued: null };
  G._clearSettingsCache();
  A.sbComms = async (path, env, opts = {}) => {
    if (path.includes(`/campaigns?id=eq.${CID}`) && (!opts.method || opts.method === 'GET')) return { ok: true, data: [camp] };
    if (path.includes('/campaign_variants?')) return { ok: true, data: [] };
    if (path.includes('/rpc/campaign_recipients')) return { ok: true, data: recs };
    if (path.includes('/rpc/campaign_excluded_batch')) {
      seen.batchCalls++;
      return batchOk ? { ok: true, data: asRows(excludedIds) } : { ok: false, status: 500, data: null };
    }
    if (path === '/rest/v1/messages' && opts.method === 'POST') {
      if (!skipInsertOk) return { ok: false, status: 500, data: null };
      seen.skipRows = JSON.parse(opts.body);
      return { ok: true, data: [] };
    }
    if (path.includes('/messages?on_conflict')) {
      const b = JSON.parse(opts.body);
      seen.reserves.push(b.profile_id);
      return { ok: true, data: [{ id: 'R' + seen.reserves.length }] };
    }
    if (path.includes('/templates?id=eq.')) return { ok: true, data: [] };  // send resolves 'failed' softly
    if (path.includes(`/campaigns?id=eq.${CID}`) && opts.method === 'PATCH') return { ok: true, data: [camp] };
    return { ok: true, data: [] };
  };
  const ENV = { BROADCAST_QUEUE: { send: async (m) => { seen.continued = m; } } };
  return { seen, ENV };
}

(async () => {
  await t('excluded profiles get skip rows and are NOT sent; the rest are attempted', async () => {
    const { seen, ENV } = stub({ excludedIds: ['P1', 'P3'] });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null });
    assert.equal(seen.batchCalls, 1);
    assert.ok(Array.isArray(seen.skipRows) && seen.skipRows.length === 2, 'one array insert, two rows');
    for (const row of seen.skipRows) {
      assert.equal(row.status, 'skipped');
      // ⭐ REGRESSION GUARD FOR THE S326 FIX, and note this assertion USED to read
      // 'excluded_recent_contact' — which was the bug: this campaign's only rule is
      // `exclude_campaign_ids`, so labelling it a time-window skip is exactly the mislabel that
      // hid 52,381 deliberate suppressions on `Freedom to Play Sale_17Aug`. The reason must name
      // the cause the RPC actually reported, or a suppression is indistinguishable from a bug.
      assert.equal(row.reason, 'excluded_prior_campaign');
      assert.equal(row.source, `campaign:${CID}`);
      assert.ok(row.to_address, 'the address travels with the evidence');
    }
    assert.deepEqual(seen.skipRows.map((x) => x.profile_id).sort(), ['P1', 'P3']);
    assert.deepEqual(seen.reserves.sort(), ['P0', 'P2'], 'only the non-excluded are attempted');
  });

  await t('a failed batch check THROWS the page — nothing sent, nothing written', async () => {
    // Soft-continuing here would send to people the exclusion should hold back, inside the exact
    // S276 concurrency window the check exists for.
    const { seen, ENV } = stub({ batchOk: false });
    await assert.rejects(() => CAMP.processQueueMessage(ENV, { campaignId: CID, after: null }),
      /campaign_excluded_batch_failed/);
    assert.equal(seen.reserves.length, 0, 'no send may run past a failed exclusion check');
    assert.equal(seen.skipRows, null);
    assert.equal(seen.continued, null, 'the chain must not advance past a failed page');
  });

  await t('a failed skip-write THROWS before any send — silence is the bug, not the fallback', async () => {
    const { seen, ENV } = stub({ excludedIds: ['P0'], skipInsertOk: false });
    await assert.rejects(() => CAMP.processQueueMessage(ENV, { campaignId: CID, after: null }),
      /exclusion_skip_write_failed/);
    assert.equal(seen.reserves.length, 0, 'sends run only after the evidence is written');
  });

  await t('no exclusion rules → the batch RPC is never called (zero subrequest tax)', async () => {
    const { seen, ENV } = stub({ camp: CAMPROW({ exclude_campaign_ids: [] }) });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null });
    assert.equal(seen.batchCalls, 0);
    assert.equal(seen.skipRows, null);
    assert.equal(seen.reserves.length, 4, 'everyone attempted');
  });

  await t('batch returns empty → no insert call, everyone attempted', async () => {
    const { seen, ENV } = stub({ excludedIds: [] });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null });
    assert.equal(seen.batchCalls, 1);
    assert.equal(seen.skipRows, null, 'no empty-array insert');
    assert.equal(seen.reserves.length, 4);
  });

  await t('a page ENTIRELY excluded still advances the cursor and continues the chain', async () => {
    // The pool works a filtered copy; recs stays untouched. A full page of exclusions must not
    // read as "short page → campaign finished" — that would end the whole broadcast early.
    const SENDS_PER_MSG = 75;  // mirror of the constant; the canary below fails if it drifts
    const recs = RECS(SENDS_PER_MSG);
    const { seen, ENV } = stub({ recs, excludedIds: recs.map((r) => r.profile_id) });
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null });
    assert.equal(seen.reserves.length, 0, 'nobody sent');
    assert.equal(seen.skipRows.length, SENDS_PER_MSG, 'everybody evidenced');
    assert.ok(seen.continued, 'chain continued');
    assert.equal(seen.continued.after, `P${SENDS_PER_MSG - 1}`, 'cursor = last rec of the UNFILTERED page');
  });

  await t('variant_id is stamped on skip rows when the campaign has arms', async () => {
    // Same reasoning as finalize stamping variant_id on every outcome: a skipped message still
    // belongs to an arm, and ab-stats' failure-asymmetry check reads those rows.
    const variants = [
      { id: 'a1', label: 'A', template_id: 'TPL_A', weight: 50, sort_order: 1 },
      { id: 'b1', label: 'B', template_id: 'TPL_B', weight: 50, sort_order: 2 },
    ];
    const { seen, ENV } = stub({ excludedIds: ['P0', 'P1', 'P2', 'P3'] });
    const inner = A.sbComms;
    A.sbComms = async (path, env, opts = {}) => path.includes('/campaign_variants?')
      ? { ok: true, data: variants } : inner(path, env, opts);
    await CAMP.processQueueMessage(ENV, { campaignId: CID, after: null });
    assert.ok(seen.skipRows.every((x) => x.variant_id === 'a1' || x.variant_id === 'b1'),
      'every skip row carries its arm');
  });

  A.sbComms = orig;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
