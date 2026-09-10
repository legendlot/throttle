import test from 'node:test';
import assert from 'node:assert/strict';
import { rollupVideos } from '../src/index.js';

const v = (seq, o = {}) => ({ seq, video_link: null, post_date: null, views: null, likes: null, comments: null,
  shares: null, reposts: null, saves: null, impressions: null, followers_gained: null,
  follower_count_at_post: null, metric_gaps: {}, ...o });

test('sums the eight SUM metrics across takes, null only when every take is null', () => {
  const r = rollupVideos([v(1, { views: 1000, likes: 10 }), v(2, { views: 250, likes: null, comments: 3 })]);
  assert.equal(r.views, 1250);
  assert.equal(r.likes, 10);
  assert.equal(r.comments, 3);
  assert.equal(r.shares, null);
});

test('post_date, video_link and follower_count_at_post mirror seq 1 only', () => {
  const r = rollupVideos([
    v(2, { post_date: '2026-10-03', video_link: 'https://b', follower_count_at_post: 900 }),
    v(1, { post_date: '2026-09-28', video_link: 'https://a', follower_count_at_post: 800 }),
  ]);
  assert.equal(r.post_date, '2026-09-28');
  assert.equal(r.video_link, 'https://a');
  assert.equal(r.follower_count_at_post, 800);
});

test('metric_gaps keeps a reason only where the rolled metric is still null', () => {
  const r = rollupVideos([
    v(1, { views: 100, metric_gaps: { views: 'late', likes: 'platform_hides' } }),
    v(2, { metric_gaps: { likes: 'not_yet' } }),
  ]);
  assert.deepEqual(r.metric_gaps, { likes: 'platform_hides' });
});

test('empty input yields an all-null patch and an empty gaps object', () => {
  const r = rollupVideos([]);
  assert.equal(r.views, null);
  assert.equal(r.post_date, null);
  assert.deepEqual(r.metric_gaps, {});
});

test('seq arriving as a STRING still sorts numerically ("2" before "1" is still take 1 first)', () => {
  const r = rollupVideos([
    v('2', { post_date: '2026-10-03', video_link: 'https://b' }),
    v('1', { post_date: '2026-09-28', video_link: 'https://a' }),
  ]);
  assert.equal(r.post_date, '2026-09-28');
  assert.equal(r.video_link, 'https://a');
});

test('with seq 1 deleted, the mirror fields come from the LOWEST seq present — never from nothing', () => {
  const r = rollupVideos([
    v(3, { post_date: '2026-10-09', video_link: 'https://c', follower_count_at_post: 1100 }),
    v(2, { post_date: '2026-10-03', video_link: 'https://b', follower_count_at_post: 900 }),
  ]);
  assert.equal(r.post_date, '2026-10-03');
  assert.equal(r.video_link, 'https://b');
  assert.equal(r.follower_count_at_post, 900);
});

test('string numbers from PostgREST are summed as numbers, whitespace is not a value', () => {
  const r = rollupVideos([v(1, { views: '12' }), v(2, { views: ' ' })]);
  assert.equal(r.views, 12);
});

// ── S369 hostile review: a rolled-up reason must cover EVERY take that is missing the number ──
// Since S369 a declared gap satisfies metricsCompleteness, so a reason that leaks up from ONE
// take marks the whole deal Complete while another take's hole is real and unexplained.
test('a reason rolls up only when every null take declared one', () => {
  const both = rollupVideos([
    { seq: 1, views: null, metric_gaps: { views: 'gated_data' } },
    { seq: 2, views: null, metric_gaps: { views: 'internal_gap' } },
  ]);
  assert.equal(both.views, null);
  assert.equal(both.metric_gaps.views, 'gated_data', 'both explained -> the reason stands');

  const onlyOne = rollupVideos([
    { seq: 1, views: null, metric_gaps: { views: 'gated_data' } },
    { seq: 2, views: null, metric_gaps: {} },              // nobody filled this take in
  ]);
  assert.equal(onlyOne.views, null);
  assert.equal(onlyOne.metric_gaps.views, undefined, 'one unexplained hole -> NOT explained');
});

test('a take with a real number needs no reason, and a stale reason never survives it', () => {
  const out = rollupVideos([
    { seq: 1, views: 100, metric_gaps: { views: 'gated_data' } },
    { seq: 2, views: null, metric_gaps: {} },
  ]);
  assert.equal(out.views, 100, 'a real number on any take is the rollup');
  assert.equal(out.metric_gaps.views, undefined, 'a reason behind a real number is stale');
});

test('the single-take case (497 of 497 deals today) is unchanged', () => {
  const out = rollupVideos([{ seq: 1, views: null, metric_gaps: { views: 'system_timing' } }]);
  assert.equal(out.metric_gaps.views, 'system_timing');
});
