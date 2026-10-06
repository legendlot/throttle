import test from 'node:test';
import assert from 'node:assert/strict';
import { dealUtm } from '../src/index.js';

// S409 (Sulaksh DM 2026-10-05): source = platform, campaign = deal, term = product code.
// Campaign is Odo's join key (upper(campaign) = engagement_no) — it must not change shape.

test('dealUtm: instagram creator, picked product', () => {
  assert.deepEqual(
    dealUtm({ channelPlatform: 'instagram', engagementNo: 'IGN-2026-00450', productRef: 'SHTK' }),
    { utm_source: 'instagram', utm_medium: 'influencer', utm_campaign: 'ign-2026-00450', utm_term: 'SHTK' },
  );
});

test('dealUtm: platform is case-insensitive and falls back to channel_platforms', () => {
  assert.equal(dealUtm({ channelPlatform: 'YouTube', engagementNo: 'X' }).utm_source, 'youtube');
  assert.equal(dealUtm({ channelPlatform: null, channelPlatforms: ['youtube'], engagementNo: 'X' }).utm_source, 'youtube');
  assert.equal(dealUtm({ channelPlatform: 'other', channelPlatforms: ['instagram'], engagementNo: 'X' }).utm_source, 'instagram');
});

test('dealUtm: no known platform reads "other", never a guess', () => {
  assert.equal(dealUtm({ channelPlatform: null, engagementNo: 'X' }).utm_source, 'other');
  assert.equal(dealUtm({ channelPlatform: 'other', channelPlatforms: [], engagementNo: 'X' }).utm_source, 'other');
});

test('dealUtm: no picked product → no utm_term key at all', () => {
  assert.equal('utm_term' in dealUtm({ channelPlatform: 'instagram', engagementNo: 'X', productRef: null }), false);
  assert.equal('utm_term' in dealUtm({ channelPlatform: 'instagram', engagementNo: 'X', productRef: '  ' }), false);
});
