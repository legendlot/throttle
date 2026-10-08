import test from 'node:test';
import assert from 'node:assert/strict';
import { normQuery, cleanGroups, flatItems, moveIndex, highlightParts, createSearchRunner } from '../src/lib/typeahead.js';

test('normQuery trims and collapses whitespace, coerces null', () => {
  assert.equal(normQuery('  petrol   hunter '), 'petrol hunter');
  assert.equal(normQuery(null), '');
  assert.equal(normQuery(42), '42');
});

test('cleanGroups drops empty groups, keeps error groups, wraps a bare item array', () => {
  assert.deepEqual(cleanGroups([{ group: 'A', items: [] }, { group: 'B', items: [{ id: 1 }] }, { group: 'C', error: true }]),
    [{ group: 'B', error: false, items: [{ id: 1 }] }, { group: 'C', error: true, items: [] }]);
  assert.deepEqual(cleanGroups([{ id: 1 }, null, { id: 2 }]), [{ group: '', items: [{ id: 1 }, { id: 2 }] }]);
  assert.deepEqual(cleanGroups(null), []);
  assert.deepEqual(cleanGroups([]), []);
});

test('flatItems keeps display order across groups', () => {
  assert.deepEqual(flatItems([{ items: [1, 2] }, { items: [] }, { items: [3] }]), [1, 2, 3]);
});

test('moveIndex wraps and enters from -1', () => {
  assert.equal(moveIndex(-1, 1, 3), 0);
  assert.equal(moveIndex(-1, -1, 3), 2);
  assert.equal(moveIndex(2, 1, 3), 0);
  assert.equal(moveIndex(0, -1, 3), 2);
  assert.equal(moveIndex(1, 1, 3), 2);
  assert.equal(moveIndex(0, 1, 0), -1);
  assert.equal(moveIndex(5, 1, 3), 0); // stale index after the list shrank
});

test('highlightParts marks every case-insensitive hit and escapes regex characters', () => {
  assert.deepEqual(highlightParts('Petrol petrol', 'PET'), [
    { text: 'Pet', hit: true }, { text: 'rol ', hit: false }, { text: 'pet', hit: true }, { text: 'rol', hit: false },
  ]);
  assert.deepEqual(highlightParts('Chanda(kid inf)', '(kid'), [
    { text: 'Chanda', hit: false }, { text: '(kid', hit: true }, { text: ' inf)', hit: false },
  ]);
  assert.deepEqual(highlightParts('abc', 'x.*'), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlightParts(null, 'a'), [{ text: '', hit: false }]);
});

// Fake timers: run the queued callbacks by hand so the debounce is deterministic.
function fakeTimers() {
  let id = 0;
  const q = new Map();
  return {
    setTimeout(fn) { q.set(++id, fn); return id; },
    clearTimeout(t) { q.delete(t); },
    flush() { const fns = [...q.values()]; q.clear(); return Promise.all(fns.map(f => f())); },
    get size() { return q.size; },
  };
}

test('runner: under minChars → short, empty → idle, no fetch', async () => {
  const states = [];
  let calls = 0;
  const timers = fakeTimers();
  const r = createSearchRunner({ fetchResults: async () => { calls++; return []; }, onState: s => states.push(s), timers });
  r.run('p');
  r.run('   ');
  await timers.flush();
  assert.deepEqual(states.map(s => s.status), ['short', 'idle']);
  assert.equal(calls, 0);
});

test('runner: debounce — only the last keystroke fetches', async () => {
  const seen = [];
  const timers = fakeTimers();
  const r = createSearchRunner({ fetchResults: async (q) => { seen.push(q); return [{ group: 'G', items: [{ id: q }] }]; },
    onState: () => {}, timers });
  r.run('pe'); r.run('pet'); r.run('petrol');
  assert.equal(timers.size, 1);
  await timers.flush();
  assert.deepEqual(seen, ['petrol']);
});

test('runner: stale guard — a slow earlier response never overwrites a later one', async () => {
  const states = [];
  const timers = fakeTimers();
  const pending = {};
  const r = createSearchRunner({
    fetchResults: (q, signal) => new Promise((resolve) => { pending[q] = { resolve, signal }; }),
    onState: s => states.push(s), timers,
  });
  r.run('pe');
  const f1 = timers.flush();                 // "pe" is now in flight
  r.run('petrol');                           // aborts "pe"
  assert.equal(pending.pe.signal.aborted, true);
  const f2 = timers.flush();
  pending.petrol.resolve([{ group: 'G', items: [{ id: 'petrol' }] }]);
  pending.pe.resolve([{ group: 'G', items: [{ id: 'pe' }] }]); // arrives last
  await Promise.all([f1, f2]);
  const done = states.filter(s => s.status === 'done');
  assert.equal(done.length, 1);
  assert.equal(done[0].q, 'petrol');
});

test('runner: a failed call reports error (not an empty list); an abort is silent', async () => {
  const states = [];
  const timers = fakeTimers();
  const r = createSearchRunner({ fetchResults: async () => { throw new Error('boom'); }, onState: s => states.push(s), timers });
  r.run('petrol');
  await timers.flush();
  assert.deepEqual(states.at(-1), { status: 'error', q: 'petrol', error: 'boom' });

  const s2 = [];
  const r2 = createSearchRunner({
    fetchResults: () => { const e = new Error('aborted'); e.name = 'AbortError'; return Promise.reject(e); },
    onState: s => s2.push(s), timers,
  });
  r2.run('petrol');
  await timers.flush();
  assert.deepEqual(s2.map(s => s.status), ['loading']);
});

test('runner: cancel() drops an in-flight response', async () => {
  const states = [];
  const timers = fakeTimers();
  let resolve;
  const r = createSearchRunner({ fetchResults: () => new Promise(res => { resolve = res; }), onState: s => states.push(s), timers });
  r.run('petrol');
  const f = timers.flush();
  r.cancel();
  resolve([{ group: 'G', items: [{ id: 1 }] }]);
  await f;
  assert.deepEqual(states.map(s => s.status), ['loading']);
});

test('matchRows: every word must match some field, case-insensitive; empty query returns all', async () => {
  const { matchRows } = await import('../src/lib/typeahead.js');
  const rows = [
    { name: 'petrol_hunter', code: 'IN575' },
    { name: 'petrol_hunter', code: 'IN1368' },
    { name: 'Asha', code: null },
  ];
  const f = r => [r.name, r.code];
  assert.deepEqual(matchRows(rows, 'PETROL 575', f).map(r => r.code), ['IN575']);
  assert.equal(matchRows(rows, '  ', f).length, 3);
  assert.deepEqual(matchRows(rows, 'asha', f).map(r => r.name), ['Asha']);
  assert.deepEqual(matchRows(rows, 'null', f), []);           // a null field is not the text "null"
  assert.deepEqual(matchRows(rows, 'hunter in13', f).map(r => r.code), ['IN1368']);
  assert.deepEqual(matchRows(null, 'x', f), []);
});

test('highlightParts bolds each word of a multi-word query', () => {
  assert.deepEqual(highlightParts('petrol_hunter · IN575', 'petrol 575'), [
    { text: 'petrol', hit: true }, { text: '_hunter · IN', hit: false }, { text: '575', hit: true },
  ]);
});
