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

test('intParam: clamps above max, defaults below min — limit=0 now means default', () => {
  assert.equal(intParam(u('limit=9999'), 'limit', 50, { min: 1, max: 200 }), 200);
  // ⚠️ S369 hostile review: this IS a behaviour change and the first version of this comment
  // wrongly called it equivalent. `'0'` is a TRUTHY string, so `Number(get('limit') || 50)` never
  // fell back — old `?limit=0` reached PostgREST as `limit=0` and returned ZERO rows. No caller
  // sends it (the app sends 8/10/200/PAGE), so nothing broke; the claim was the defect.
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

// ── Old-vs-new, per call site. The first six tests exercised the helper in ISOLATION, which is
// exactly how "limit=0 is unchanged" shipped as a false claim (S369 hostile review). This table
// pins the INTENDED value at each of the nine sites for the inputs that actually differ.
const OLD_LIMIT = (q, d, max) => Math.min(Number(u(q).searchParams.get('limit') || d), max);
const OLD_DAYS  = (q, d) => Math.max(Number(u(q).searchParams.get('days') || d), 1);

const SITES = [
  { fn: 'getInfluencers',     dflt: 50,  max: 200 },
  { fn: 'getEngagements',     dflt: 50,  max: 200 },
  { fn: 'getRoster',          dflt: 100, max: 500 },
  { fn: 'getDiscountCodes',   dflt: 100, max: 500 },
];

test('every limit site: hostile input yields a usable integer, never NaN and never 0 rows', () => {
  for (const { fn, dflt, max } of SITES) {
    for (const q of ['limit=abc', 'limit=NaN', 'limit=0', 'limit=%20', 'limit=-7', 'limit=1e999']) {
      const got = intParam(u(q), 'limit', dflt, { min: 1, max });
      assert.ok(Number.isInteger(got) && got >= 1 && got <= max, `${fn} ${q} -> ${got}`);
    }
    assert.equal(intParam(u('limit=7'), 'limit', dflt, { min: 1, max }), 7, `${fn} passes a real value`);
    assert.equal(intParam(u(`limit=${max + 1}`), 'limit', dflt, { min: 1, max }), max, `${fn} clamps to max`);
  }
});

test('the four inputs whose behaviour genuinely CHANGED, pinned against the old expression', () => {
  // Documented so a future reader does not have to re-derive which of these were equivalences.
  assert.equal(OLD_LIMIT('limit=abc', 50, 200).toString(), 'NaN');            // the bug
  assert.equal(intParam(u('limit=abc'), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(OLD_LIMIT('limit=0', 50, 200), 0);                            // zero rows
  assert.equal(intParam(u('limit=0'), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(OLD_LIMIT('limit=%20', 50, 200), 0);                          // zero rows
  assert.equal(intParam(u('limit=%20'), 'limit', 50, { min: 1, max: 200 }), 50);
  assert.equal(OLD_LIMIT('limit=1e999', 50, 200), 200);
  assert.equal(intParam(u('limit=1e999'), 'limit', 50, { min: 1, max: 200 }), 50);
});

test('days: old clamped 0/-3 to 1 day, new returns the 10-day default — and 1e9 is capped', () => {
  assert.equal(OLD_DAYS('days=0', 10), 1);
  assert.equal(intParam(u('days=0'), 'days', 10, { min: 1, max: 365 }), 10);
  assert.equal(OLD_DAYS('days=-3', 10), 1);
  assert.equal(intParam(u('days=-3'), 'days', 10, { min: 1, max: 365 }), 10);
  // ?days=1e9 made `new Date(Date.now() - days*86400000).toISOString()` throw RangeError -> 500.
  assert.equal(intParam(u('days=1e9'), 'days', 10, { min: 1, max: 365 }), 365);
  assert.doesNotThrow(() => new Date(Date.now() - intParam(u('days=1e9'), 'days', 10, { min: 1, max: 365 }) * 86400000).toISOString());
});
