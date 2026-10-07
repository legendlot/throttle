// Tests for the post display-field rules.
//
//     node --test src/social-posts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postNeedsMeta, shouldFetchPostMeta, postMetaPatch } from './social-posts.js';

test('a row with a permalink is finished; a bare or missing row is not', () => {
  assert.equal(postNeedsMeta({ permalink: 'https://www.instagram.com/p/x/' }), false);
  assert.equal(postNeedsMeta({ permalink: null, caption: null }), true);
  assert.equal(postNeedsMeta(undefined), true);
});

test('only Instagram without meta in hand fetches — Facebook never reaches the IG host', () => {
  assert.equal(shouldFetchPostMeta('instagram', null), true);
  assert.equal(shouldFetchPostMeta('instagram', { permalink: 'p' }), false);   // the poller's path
  assert.equal(shouldFetchPostMeta('facebook', null), false);
  assert.equal(shouldFetchPostMeta('messenger', null), false);
});

test('the patch carries only fields Meta gave, so it can never null one out', () => {
  assert.deepEqual(postMetaPatch({ permalink: 'p', caption: 'c', media_type: 'VIDEO', media_url: null }),
    { permalink: 'p', caption: 'c', media_type: 'VIDEO' });
  assert.deepEqual(postMetaPatch({ id: '1', error: { message: 'x' } }), {});
  assert.deepEqual(postMetaPatch(null), {});
});
