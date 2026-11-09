// node --test src/lib/*.test.mjs  (npm test) — the ⌘K matcher's ranking + DKT parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, dktQuery } from './fuzzy.js';

const score = (q, t) => fuzzyMatch(q, t)?.score ?? -1;

test('ranking: prefix > word-start > substring > subsequence', () => {
  const prefix = score('tas', 'tasks');
  const wordStart = score('tas', 'my tasks');
  const substring = score('ask', 'tasks');
  const subseq = score('mt', 'my tasks');
  assert.ok(prefix > wordStart, `prefix ${prefix} > word-start ${wordStart}`);
  assert.ok(wordStart > substring, `word-start ${wordStart} > substring ${substring}`);
  assert.ok(substring > subseq, `substring ${substring} > subsequence ${subseq}`);
});

test('subsequence never false-negatives when the chars are in order', () => {
  assert.ok(fuzzyMatch('dt', 'update the docs'), 'dt in "update the docs"');
  assert.ok(fuzzyMatch('ac', 'xabc a'), 'ac in "xabc a"');
  assert.equal(fuzzyMatch('zz', 'tasks'), null);
  assert.equal(fuzzyMatch('ts', 'st'), null);
});

test('matched indices point at the matched characters', () => {
  const text = 'update the docs';
  const m = fuzzyMatch('dt', text);
  assert.deepEqual(m.idx.map(i => text[i]), ['d', 't']);
  assert.deepEqual(fuzzyMatch('tas', 'tasks').idx, [0, 1, 2]);
});

test('empty query matches everything with no highlight', () => {
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, idx: [] });
  assert.equal(fuzzyMatch('a', ''), null);
});

test('DKT id parsing', () => {
  assert.equal(dktQuery('DKT-123'), '123');
  assert.equal(dktQuery('dkt123'), '123');
  assert.equal(dktQuery('123'), '123');
  assert.equal(dktQuery('DKT-0'), '0');
  assert.equal(dktQuery('DKT-0042'), '42');
  assert.equal(dktQuery('dkt-'), null);
  assert.equal(dktQuery('1e3'), null);
  assert.equal(dktQuery('report'), null);
  assert.equal(dktQuery(''), null);
});
