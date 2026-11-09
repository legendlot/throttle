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

test('rankGroups: best item first across groups, ties keep order', async () => {
  const { rankGroups } = await import('./fuzzy.js');
  const g = (group, ...scores) => ({ group, items: scores.map(s => ({ _score: s })) });
  // "board": mid-word task hits (500) must not sit above a word-start command (700).
  const order = rankGroups([g('tasks', 500, 499), g('places'), g('nav', 498), g('commands', 700)]).map(x => x.group);
  assert.deepEqual(order, ['commands', 'tasks', 'nav', 'places']);
  // An exact DKT id (3000) keeps Tasks first.
  assert.equal(rankGroups([g('tasks', 3000), g('commands', 1000)])[0].group, 'tasks');
  // Ties keep the given order.
  assert.deepEqual(rankGroups([g('recent', 700), g('tasks', 700), g('nav', 700)]).map(x => x.group), ['recent', 'tasks', 'nav']);
});

test('scoreTask: DKT exact > DKT prefix > title; server floor lifts out-of-order + typo hits', async () => {
  const { scoreTask, serverFloor } = await import('./fuzzy.js');
  const mk = (title, no) => ({ lc: title.toLowerCase(), lcSub: no.toLowerCase(), num: no.replace(/\D/g, '') });
  const a = mk('SF <> LOT - Summary Sheet', 'DKT-247');
  assert.equal(scoreTask(a, '247', '247').score, 3000);
  assert.ok(scoreTask(mk('x', 'DKT-2471'), '247', '247').score >= 1990);
  // "sop qc" vs "...new QC SOP": fuzzy alone ranks it low or not at all; the floor keeps it.
  const b = mk('Approval from afshaan implementation for new QC SOP', 'DKT-844');
  const raw = scoreTask(b, 'sop qc', null);
  const lifted = scoreTask(b, 'sop qc', null, serverFloor(3, 0));
  assert.ok(lifted.score >= 450 && (!raw || lifted.score >= raw.score));
  // typo: no fuzzy match at all → only the server floor makes it a result
  const c = mk('Checklist Tracker', 'DKT-1');
  assert.equal(scoreTask(c, 'chekclistz', null), null);
  assert.equal(scoreTask(c, 'chekclistz', null, serverFloor(4, 2)).score, 248);
  // a missing rank is the weakest floor, never the exact-id one
  assert.equal(serverFloor(null), 250); assert.equal(serverFloor(''), 250);
  assert.equal(dktQuery('#12'), '12');
  // a floor never lowers a better fuzzy score
  assert.ok(scoreTask(c, 'check', null, serverFloor(4)).score > 900);
});
