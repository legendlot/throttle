import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  adApprovalGate, adTake, istToday, manualRunStatusRefusal, metaAdPatch, paidViewsByTake,
  organicViews, rollupVideos, VIDEO_METRICS_NEEDING_BASE,
} from '../src/index.js';

// S373 — ads on deals. Approval opens AD_APPROVE_AFTER_DAYS (10) IST calendar days after the take posted.
const take = (o = {}) => ({ id: 'v1', seq: 1, post_date: '2026-09-11', ...o });

test('approval gate: refused the IST second before day 10, allowed from IST midnight', () => {
  // 2026-09-21 00:00 IST === 2026-09-20T18:30:00Z
  const before = adApprovalGate(take(), Date.parse('2026-09-20T18:29:59Z'));
  assert.equal(before.ok, false);
  assert.equal(before.earliest, '2026-09-21');
  assert.equal(before.message, 'can approve from 21 Sep — 10 days after the video posted on 11 Sep');
  const at = adApprovalGate(take(), Date.parse('2026-09-20T18:30:00Z'));
  assert.equal(at.ok, true);
  assert.equal(at.message, null);
});

test('approval gate: a UTC-only count would be wrong — 20 Sep 20:00 UTC is already the 21st in IST', () => {
  assert.equal(istToday(Date.parse('2026-09-20T20:00:00Z')), '2026-09-21');
  assert.equal(adApprovalGate(take(), Date.parse('2026-09-20T20:00:00Z')).ok, true);
});

test('approval gate: month boundary counts calendar days', () => {
  const g = adApprovalGate(take({ post_date: '2026-09-25' }), Date.parse('2026-10-04T12:00:00Z'));
  assert.equal(g.ok, false);
  assert.equal(g.earliest, '2026-10-05');
});

test('approval gate: no take, and a take with no (or a junk) post date, are refused with words', () => {
  const none = adApprovalGate(null);
  assert.equal(none.ok, false);
  assert.match(none.message, /link the ad to a take/);
  for (const pd of [null, '', '2026-02-31', 'soon']) {
    const g = adApprovalGate(take({ seq: 2, post_date: pd }));
    assert.equal(g.ok, false, String(pd));
    assert.equal(g.earliest, null);
    assert.match(g.message, /take #2 has no post date yet/);
  }
});

test('adTake finds the ad\'s take among the deal\'s videos, null when unlinked or gone', () => {
  const vids = [take(), take({ id: 'v2', seq: 2 })];
  assert.equal(adTake({ video_id: 'v2' }, vids).seq, 2);
  assert.equal(adTake({ video_id: null }, vids), null);
  assert.equal(adTake({ video_id: 'gone' }, vids), null);
});

test('manual run status: running is refused unless approved; everything else is free', () => {
  assert.match(manualRunStatusRefusal('running', { approval_status: 'pending' }), /once it is approved/);
  assert.match(manualRunStatusRefusal('running', { approval_status: 'rejected' }), /once it is approved/);
  assert.match(manualRunStatusRefusal('running', {}), /once it is approved/, 'a new ad is pending');
  assert.equal(manualRunStatusRefusal('running', { approval_status: 'approved' }), null);
  assert.equal(manualRunStatusRefusal('ended', { approval_status: 'pending' }), null);
  assert.equal(manualRunStatusRefusal('not_started', {}), null);
  // Meta already reported it running (unapproved) — re-saving the form must not trip on it.
  assert.equal(manualRunStatusRefusal('running', { approval_status: 'pending', run_status: 'running' }), null);
});

test('Meta status mapping', () => {
  const now = Date.parse('2026-09-11T06:00:00Z');
  const run = (status, cur = {}) => metaAdPatch(cur, status, {}, now).run_status;
  assert.equal(run({ effective_status: 'ACTIVE' }), 'running');
  for (const s of ['PAUSED', 'ARCHIVED', 'DELETED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']) assert.equal(run({ effective_status: s }), 'ended', s);
  for (const s of ['IN_PROCESS', 'PENDING_REVIEW', 'WITH_ISSUES', 'DISAPPROVED', undefined]) assert.equal(run({ effective_status: s }), undefined, String(s));
  // Past the ad set's end beats ACTIVE.
  assert.equal(run({ effective_status: 'ACTIVE', end_time: '2026-09-10T23:59:59+0530' }), 'ended');
  assert.equal(run({ effective_status: 'ACTIVE', end_time: '2026-09-30T23:59:59+0530' }), 'running');
});

test('Meta patch: figures, views = Σ video_play_actions, dates fill only when empty (IST)', () => {
  const now = Date.parse('2026-09-11T06:00:00Z');
  const p = metaAdPatch({}, { effective_status: 'ACTIVE', start_time: '2026-09-11T20:00:00-0700', end_time: '2026-09-30T23:59:00+0530' },
    { spend: '1234.567', impressions: '98765', video_play_actions: [{ action_type: 'video_view', value: '4000' }, { action_type: 'video_view', value: '250' }] }, now);
  assert.equal(p.meta_spend, 1234.57);
  assert.equal(p.meta_impressions, 98765);
  assert.equal(p.meta_views, 4250);
  assert.equal(p.meta_status, 'ACTIVE');
  assert.equal(p.start_date, '2026-09-12', '20:00 PDT on the 11th is the 12th in IST');
  assert.equal(p.end_date, '2026-09-30');
  const typed = metaAdPatch({ start_date: '2026-09-01', end_date: '2026-09-02' }, { start_time: '2026-09-11T00:00:00+0530', end_time: '2026-09-30T00:00:00+0530' }, {}, now);
  assert.equal('start_date' in typed, false, 'a typed start date is never overwritten');
  assert.equal('end_date' in typed, false);
  const empty = metaAdPatch({}, {}, {}, now);
  assert.equal(empty.meta_views, 0);
  assert.equal(empty.meta_spend, 0);
});

test('paid views per take: only SYNCED ads on a take count; a take with none is absent', () => {
  const m = paidViewsByTake([
    { video_id: 'v1', meta_views: 100, meta_synced_at: 't' },
    { video_id: 'v1', meta_views: '50', meta_synced_at: 't' },
    { video_id: 'v2', meta_views: 999, meta_synced_at: null },     // never synced → typed value stands
    { video_id: null, meta_views: 7, meta_synced_at: 't' },        // no take
  ]);
  assert.deepEqual(m, { v1: 150 });
});

test('organic = views − paid, null when views unknown, never below 0', () => {
  assert.equal(organicViews(1000, 300), 700);
  assert.equal(organicViews(1000, null), 1000);
  assert.equal(organicViews('1000', '250'), 750);
  assert.equal(organicViews(null, 50), null);
  assert.equal(organicViews(100, 400), 0);
});

test('rollup sums paid_views across takes, null only when every take is null, and keeps it out of metric_gaps', () => {
  const v = (seq, o) => ({ seq, views: 100, metric_gaps: {}, ...o });
  assert.equal(rollupVideos([v(1, { paid_views: 30 }), v(2, { paid_views: 20 })]).paid_views, 50);
  assert.equal(rollupVideos([v(1, { paid_views: null }), v(2, { paid_views: 0 })]).paid_views, 0);
  const none = rollupVideos([v(1, { paid_views: null, metric_gaps: { paid_views: 'gated_data' } })]);
  assert.equal(none.paid_views, null);
  assert.equal('paid_views' in none.metric_gaps, false, 'paid views is not a completeness metric');
});

test('a paid (or organic) views figure does not demand followers-at-post; real metrics still do', () => {
  assert.equal(VIDEO_METRICS_NEEDING_BASE.includes('paid_views'), false);
  assert.equal(VIDEO_METRICS_NEEDING_BASE.includes('organic_views'), false);
  assert.equal(VIDEO_METRICS_NEEDING_BASE.includes('follower_count_at_post'), false);
  for (const k of ['views', 'likes', 'comments', 'shares', 'saves', 'reposts', 'impressions', 'followers_gained']) {
    assert.ok(VIDEO_METRICS_NEEDING_BASE.includes(k), k);
  }
});

// The spend fallbacks are closures inside their handlers, so they are checked at the source:
// ad money (ad_spend) must never be influencer spend again (S373 budget exclusion).
test('no spendOf fallback, and no budget read, sums ad_spend', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const spendOfs = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /const spendOf =/.test(l));
  assert.ok(spendOfs.length >= 5, `found ${spendOfs.length} spendOf definitions`);
  for (const [n] of spendOfs) {
    const body = src.split('\n').slice(n - 1, n + 1).join(' ');   // some wrap onto a second line
    assert.equal(/\bad_spend\b/.test(body), false, `spendOf at line ${n} still sums ad_spend`);
  }
  // …and ad_payments / engagement_ads never feed a spend, budget or payments-page read.
  for (const fn of ['getPayments', 'getMonthlyTargets', 'getMonthlyBreakdown', 'getCampaignSummary', 'getReports', 'getKpis', 'campaignRollup']) {
    const start = src.indexOf(`function ${fn}(`);
    assert.ok(start > 0, fn);
    const end = src.indexOf('\nasync function ', start + 10);
    const body = src.slice(start, end > 0 ? end : undefined);
    assert.equal(/ad_payments|engagement_ads|meta_spend/.test(body), false, `${fn} reads ad money`);
  }
});
