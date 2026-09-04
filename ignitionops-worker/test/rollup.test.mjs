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

test('string numbers from PostgREST are summed as numbers, whitespace is not a value', () => {
  const r = rollupVideos([v(1, { views: '12' }), v(2, { views: ' ' })]);
  assert.equal(r.views, 12);
});
