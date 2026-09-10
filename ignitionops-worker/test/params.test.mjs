import test from 'node:test';
import assert from 'node:assert/strict';
import { intParam, chunk } from '../src/index.js';

// `?limit=abc` used to reach PostgREST as `&limit=NaN` (S368 hostile review). Nine query-param
// parses shared the shape — four `limit`, four `offset`, one `days` — so the helper is tested
// once and every site calls it.
const u = q => new URL(`https://x/?${q}`);

test('intParam: missing, empty and non-numeric all fall back to the default', () => {
  assert.equal(intParam(u(''), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(intParam(u('limit='), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(intParam(u('limit=abc'), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(intParam(u('limit=NaN'), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(intParam(u('limit=Infinity'), 'limit', 50, { min: 1, max: 200 }), 50);
});

test('intParam: never returns NaN, whatever the input', () => {
  for (const q of ['limit=abc', 'limit=1e999', 'limit=-', 'limit=0x', 'limit=%20', 'limit=null']) {
    const v = intParam(u(q), 'limit', 50, { min: 1, max: 200 });
    assert.ok(Number.isInteger(v), `${q} -> ${v}`);
  }
});

test('intParam: clamps above max, defaults below min — limit=0 still means default', () => {
  assert.equal(intParam(u('limit=9999'), 'limit', 50, { min: 1, max: 200 }), 200);
  assert.equal(intParam(u('limit=0'), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(intParam(u('limit=-7'), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(intParam(u('limit=25'), 'limit', 50, { min: 1, max: 200 }), 25);
  assert.equal(intParam(u('limit=25.9'), 'limit', 50, { min: 1, max: 200 }), 25);
});

test('intParam: offset keeps zero as a real value and rejects negatives', () => {
  assert.equal(intParam(u('offset=0'), 'offset', 0), 0);
  assert.equal(intParam(u('offset=120'), 'offset', 0), 120);
  assert.equal(intParam(u('offset=-5'), 'offset', 0), 0);
  assert.equal(intParam(u('offset=x'), 'offset', 0), 0);
});

// The chasing list's engagement_history anchor read: 500 UUIDs joined is a ~19 KB query string.
test('chunk: splits into runs of `size`, last one shorter, nothing lost or duplicated', () => {
  const ids = Array.from({ length: 237 }, (_, i) => `id${i}`);
  const parts = chunk(ids, 100);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(p => p.length), [100, 100, 37]);
  assert.deepEqual(parts.flat(), ids);
  assert.deepEqual(chunk([], 100), []);
  assert.deepEqual(chunk(['a'], 100), [['a']]);
});

test('chunk: 100 UUIDs keeps each in.(…) filter under 4 KB', () => {
  const ids = Array.from({ length: 500 }, () => crypto.randomUUID());
  for (const part of chunk(ids, 100)) assert.ok(part.join(',').length < 4000);
});
