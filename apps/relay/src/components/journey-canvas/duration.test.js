// Run from apps/relay:  node src/components/journey-canvas/duration.test.js
const assert = require('assert');
const { durToMinutes, splitMinutes, toDurString, fmtDur } = require('./duration.js');

// Every value saved in comms.journey_versions on 2026-09-24 round-trips to the same total.
for (const [s, mins] of [['30 minutes', 30], ['6 hours', 360], ['24 hours', 1440], ['5 minutes', 5],
  ['60 minutes', 60], ['10 hours', 600], ['4 hours', 240], ['2 minutes', 2], ['1 hour', 60]]) {
  assert.strictEqual(durToMinutes(s), mins, s);
  assert.strictEqual(durToMinutes(toDurString(splitMinutes(mins))), mins, `round-trip ${s}`);
}
// Split entry -> the largest exact unit, in a form the engine regex accepts.
const ENGINE = /^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/;
assert.strictEqual(toDurString({ h: 2, m: 30 }), '150 minutes');
assert.strictEqual(toDurString({ h: 3 }), '3 hours');
assert.strictEqual(toDurString({ h: 1 }), '1 hour');
assert.strictEqual(toDurString({ d: 1, h: 0, m: 0 }), '1 day');
assert.strictEqual(toDurString({ h: 48 }), '2 days');
assert.strictEqual(toDurString({ d: 1, h: 6 }), '30 hours');
assert.strictEqual(toDurString({ m: 1 }), '1 minute');
assert.strictEqual(toDurString({ m: '90' }), '90 minutes'); // strings from inputs
for (const x of ['150 minutes', '3 hours', '1 hour', '1 day', '2 days', '1 minute']) assert.ok(ENGINE.test(x), x);
// Empty / zero -> '' (not set).
assert.strictEqual(toDurString({}), '');
assert.strictEqual(toDurString({ d: '', h: '', m: '' }), '');
assert.strictEqual(toDurString({ m: 0 }), '');
// Legacy units still parse.
assert.strictEqual(durToMinutes('1 week'), 10080);
assert.strictEqual(durToMinutes('1.5 hours'), 90);
assert.strictEqual(durToMinutes('garbage'), null);
assert.deepStrictEqual(splitMinutes(1590), { d: 1, h: 2, m: 30 });
assert.strictEqual(fmtDur('150 minutes'), '2h 30m');
assert.strictEqual(fmtDur('1590 minutes'), '1d 2h 30m');
assert.strictEqual(fmtDur('6 hours'), '6 hours');
assert.strictEqual(fmtDur('30 hours'), '1d 6h');
assert.strictEqual(fmtDur(''), '');
assert.strictEqual(fmtDur(undefined), undefined);
console.log('duration.test.js: all passed');
