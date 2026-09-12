// intParam — the NaN-proof query-param parse (S379, [core] backlog item).
// Mirrors commsops/test/params.test.js + ignitionops/test/params.test.mjs so the workers
// cannot drift apart. The extra block at the bottom covers this copy's one widening:
// it also accepts a bare URLSearchParams, which is how csops hands params to its handlers.
import test from 'node:test';
import assert from 'assert';
import { intParam } from './params.js';

const u = (qs) => new URL(`https://x.dev/?${qs}`);

test('intParam: missing, empty and non-numeric all fall back to the default', () => {
  assert.equal(intParam(u(''), 'limit', 100, { min: 1 }), 100);
  assert.equal(intParam(u('limit='), 'limit', 100, { min: 1 }), 100);
  assert.equal(intParam(u('limit=abc'), 'limit', 100, { min: 1 }), 100);
  assert.equal(intParam(u('limit=NaN'), 'limit', 100, { min: 1 }), 100);
  assert.equal(intParam(u('limit=Infinity'), 'limit', 100, { min: 1 }), 100);
  assert.equal(intParam(u('limit=%20'), 'limit', 100, { min: 1 }), 100);
  assert.equal(intParam(u('limit=1e999'), 'limit', 100, { min: 1 }), 100);
});

test('intParam: never returns NaN, whatever the input', () => {
  for (const q of ['limit=abc', 'limit=', 'limit=NaN', 'limit=-', 'limit=0x', 'limit=null', 'limit=[]']) {
    const v = intParam(u(q), 'limit', 100, { min: 1 });
    assert.ok(Number.isFinite(v), `${q} produced ${v}`);
  }
});

test('intParam: clamps above max, defaults below min, floors fractions', () => {
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

// The regression this file exists for: the four csops call sites at their real bounds.
// Before the fix each built `&limit=NaN` / `&offset=NaN` into the PostgREST URL, because the
// default sat INSIDE the parseInt and Math.min propagates NaN.
test('intParam: every csops site is NaN-proof at its own bounds', () => {
  for (const [name, dflt, opts] of [
    ['limit', 50, { min: 1, max: 200 }],  // getTickets + getCalls
    ['offset', 0, {}],                    // both handlers
  ]) {
    assert.equal(intParam(u(`${name}=abc`), name, dflt, opts), dflt, `${name} rejects non-numeric`);
    assert.ok(Number.isFinite(intParam(u(`${name}=abc`), name, dflt, opts)), `${name} never NaN`);
    assert.equal(intParam(u(`${name}=7`), name, dflt, opts), 7, `${name} passes a real value`);
  }
});

// This copy's widening: csops handlers receive `params`, not the whole URL.
test('intParam: accepts a bare URLSearchParams identically to a URL', () => {
  const qs = 'limit=abc&offset=9';
  assert.equal(intParam(new URLSearchParams(qs), 'limit', 50, { min: 1, max: 200 }),
               intParam(u(qs), 'limit', 50, { min: 1, max: 200 }));
  assert.equal(intParam(new URLSearchParams(qs), 'offset', 0), 9);
  assert.equal(intParam(new URLSearchParams(''), 'limit', 50, { min: 1, max: 200 }), 50);
});
