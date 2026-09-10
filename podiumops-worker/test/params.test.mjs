// intParam — the NaN-proof query-param parse (S370, [core] backlog item).
// Mirrors ignitionops/test/params.test.mjs so the two workers cannot drift apart.
import test from 'node:test';
import assert from 'node:assert';
import { intParam } from '../src/params.mjs';

const u = (qs) => new URL(`https://x.dev/?${qs}`);

test('intParam: missing, empty and non-numeric all fall back to the default', () => {
  assert.equal(intParam(u(''), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit='), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit=abc'), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit=NaN'), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit=Infinity'), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit=%20'), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit=1e999'), 'limit', 500, { min: 1, max: 2000 }), 500);
});

test('intParam: never returns NaN, whatever the input', () => {
  for (const q of ['limit=abc', 'limit=', 'limit=NaN', 'limit=-', 'limit=0x', 'limit=null', 'limit=[]']) {
    const v = intParam(u(q), 'limit', 500, { min: 1, max: 2000 });
    assert.ok(Number.isFinite(v), `${q} produced ${v}`);
  }
});

test('intParam: clamps above max, defaults below min, floors fractions', () => {
  assert.equal(intParam(u('limit=9999'), 'limit', 500, { min: 1, max: 2000 }), 2000);
  assert.equal(intParam(u('limit=0'), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit=-7'), 'limit', 500, { min: 1, max: 2000 }), 500);
  assert.equal(intParam(u('limit=25'), 'limit', 500, { min: 1, max: 2000 }), 25);
  assert.equal(intParam(u('limit=25.9'), 'limit', 500, { min: 1, max: 2000 }), 25);
});

test('intParam: offset keeps zero as a real value and rejects negatives', () => {
  assert.equal(intParam(u('offset=0'), 'offset', 0), 0);
  assert.equal(intParam(u('offset=120'), 'offset', 0), 120);
  assert.equal(intParam(u('offset=-5'), 'offset', 0), 0);
  assert.equal(intParam(u('offset=x'), 'offset', 0), 0);
});

// The regression this file exists for: the five podiumops call sites, at their real bounds.
// Before the fix each built `&limit=NaN` into the PostgREST URL, because Math.min/Math.max
// propagate NaN — `start`/`span` also fed a RazorpayX payroll ID scan range.
test('intParam: every podiumops site is NaN-proof at its own bounds', () => {
  for (const [name, dflt, opts] of [
    ['limit', 500, { min: 1, max: 2000 }],   // listEmployees
    ['offset', 0, {}],                       // listEmployees
    ['start', 1, { min: 1 }],                // getRazorpayxPayrollScan
    ['span', 40, { min: 1, max: 45 }],       // getRazorpayxPayrollScan
    ['limit', 200, { min: 1, max: 1000 }],   // getCompAccessLog
  ]) {
    assert.equal(intParam(u(`${name}=abc`), name, dflt, opts), dflt, `${name} rejects non-numeric`);
    assert.ok(Number.isFinite(intParam(u(`${name}=abc`), name, dflt, opts)), `${name} never NaN`);
    assert.equal(intParam(u(`${name}=7`), name, dflt, opts), 7, `${name} passes a real value`);
  }
  // span is the one with a hard ceiling — RazorpayX rejects a wider scan.
  assert.equal(intParam(u('span=99'), 'span', 40, { min: 1, max: 45 }), 45);
  assert.equal(intParam(u('span=abc'), 'span', 40, { min: 1, max: 45 }), 40);
});
