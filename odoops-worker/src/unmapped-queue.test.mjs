// resolveSkus's queue write must insert-if-absent on the real unique key and never merge (S409).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNMAPPED_QUEUE_INSERT } from './unmapped-queue.mjs';

test('queue write targets the (channel_id, channel_sku) unique key', () => {
  assert.match(UNMAPPED_QUEUE_INSERT.path, /^\/rest\/v1\/unmapped_sku\?on_conflict=channel_id,channel_sku$/);
});

test('queue write never merges — an ignored/resolved row must not be reset to open', () => {
  assert.match(UNMAPPED_QUEUE_INSERT.prefer, /resolution=ignore-duplicates/);
  assert.doesNotMatch(UNMAPPED_QUEUE_INSERT.prefer, /merge-duplicates/);
});

test('index.js: every unmapped_sku POST outside queueUnmappedFsns goes through UNMAPPED_QUEUE_INSERT', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./index.js', import.meta.url), 'utf8');
  // queueUnmappedFsns is the one deliberate merge (it pre-filters closed rows and must refresh
  // last_seen on open memo FSNs). Strip its body, then no unmapped_sku write may merge.
  const start = src.indexOf('async function queueUnmappedFsns(');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, 'queueUnmappedFsns not found');
  const rest = src.slice(0, start) + src.slice(end);
  for (const line of rest.split('\n')) {
    if (/unmapped_sku/.test(line) && /merge-duplicates/.test(line)) assert.fail(`merging unmapped_sku write: ${line.trim()}`);
  }
  assert.match(rest, /sbSales\(UNMAPPED_QUEUE_INSERT\.path, \{ method: 'POST', prefer: UNMAPPED_QUEUE_INSERT\.prefer/);
});
