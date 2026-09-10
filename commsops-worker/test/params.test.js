// intParam — the NaN-proof query-param parse (S370, [core] backlog item).
// Mirrors ignitionops/test/params.test.mjs so the two workers cannot drift apart.
const test = require('node:test');
const assert = require('assert');
const { intParam } = require('../src/params.js');

const u = (qs) => new URL(`https://x.dev/?${qs}`);

test('intParam: missing, empty and non-numeric all fall back to the default', () => {
  assert.equal(intParam(u(''), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit='), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit=abc'), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit=NaN'), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit=Infinity'), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit=%20'), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit=1e999'), 'limit', 200, { min: 1, max: 500 }), 200);
});

test('intParam: never returns NaN, whatever the input', () => {
  for (const q of ['limit=abc', 'limit=', 'limit=NaN', 'limit=-', 'limit=0x', 'limit=null', 'limit=[]']) {
    const v = intParam(u(q), 'limit', 200, { min: 1, max: 500 });
    assert.ok(Number.isFinite(v), `${q} produced ${v}`);
  }
});

test('intParam: clamps above max, defaults below min, floors fractions', () => {
  assert.equal(intParam(u('limit=9999'), 'limit', 200, { min: 1, max: 500 }), 500);
  assert.equal(intParam(u('limit=0'), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit=-7'), 'limit', 200, { min: 1, max: 500 }), 200);
  assert.equal(intParam(u('limit=25'), 'limit', 200, { min: 1, max: 500 }), 25);
  assert.equal(intParam(u('limit=25.9'), 'limit', 200, { min: 1, max: 500 }), 25);
});

test('intParam: offset/after keep zero as a real value and reject negatives', () => {
  assert.equal(intParam(u('offset=0'), 'offset', 0), 0);
  assert.equal(intParam(u('offset=120'), 'offset', 0), 120);
  assert.equal(intParam(u('offset=-5'), 'offset', 0), 0);
  assert.equal(intParam(u('offset=x'), 'offset', 0), 0);
  assert.equal(intParam(u('after=abc'), 'after', 0), 0);
  assert.equal(intParam(u('after=41'), 'after', 0), 41);
});

// The regression this file exists for: the five commsops call sites, at their real bounds.
// Before the fix each built `&limit=NaN` / `&offset=NaN` into the PostgREST URL (and into the
// dashCached key `co:NaN:NaN`), because Math.min/Math.max propagate NaN.
test('intParam: every commsops site is NaN-proof at its own bounds', () => {
  for (const [name, dflt, opts] of [
    ['limit', 200, { min: 1, max: 500 }],   // getCampaignsOverview + getJourneysOverview
    ['offset', 0, {}],                      // both overviews
    ['after', 0, {}],                       // /web/poll
  ]) {
    assert.equal(intParam(u(`${name}=abc`), name, dflt, opts), dflt, `${name} rejects non-numeric`);
    assert.ok(Number.isFinite(intParam(u(`${name}=abc`), name, dflt, opts)), `${name} never NaN`);
    assert.equal(intParam(u(`${name}=7`), name, dflt, opts), 7, `${name} passes a real value`);
  }
  assert.equal(intParam(u('limit=501'), 'limit', 200, { min: 1, max: 500 }), 500);
});
