// node --test src/lib/*.test.mjs  (npm test) — scratchpad save queue: per-note merge + debounce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaveQueue } from './saveQueue.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('title + body edits within the debounce save together (no dropped field)', async () => {
  const calls = [];
  const q = createSaveQueue((id, p) => calls.push([id, p]), 20);
  q.push('a', { body: 'hello' });
  q.push('a', { title: 'T' });
  await wait(40);
  assert.deepEqual(calls, [['a', { body: 'hello', title: 'T' }]]);
});

test("one note's edit never cancels another's", async () => {
  const calls = [];
  const q = createSaveQueue((id, p) => calls.push([id, p]), 20);
  q.push('a', { body: 'A' });
  q.push('b', { body: 'B' });
  await wait(40);
  assert.deepEqual(calls.sort(), [['a', { body: 'A' }], ['b', { body: 'B' }]]);
});

test('flushAll saves now; drop discards; nothing saves twice', async () => {
  const calls = [];
  const q = createSaveQueue((id, p) => calls.push([id, p]), 1000);
  q.push('a', { title: 'x' });
  q.push('b', { title: 'y' });
  q.drop('b');
  q.flushAll();
  await wait(10);
  assert.deepEqual(calls, [['a', { title: 'x' }]]);
  q.flushAll();
  assert.equal(calls.length, 1);
});
