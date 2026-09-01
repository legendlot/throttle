const { test } = require('node:test');
const assert = require('node:assert');
const { courierName, GENERIC } = require('../src/courier-display.js');

test('courier-display: known brands render with correct casing', () => {
  assert.equal(courierName('delhivery'), 'Delhivery');
  assert.equal(courierName('shadowfax'), 'Shadowfax');
  assert.equal(courierName('shiprocket'), 'Shiprocket');
  assert.equal(courierName('xpressbees'), 'XpressBees');
  assert.equal(courierName('bluedart'), 'Blue Dart');
});

// The reason this module is an allow-list and not a capitaliser. These two values are 30% of
// the non-null column (self 6,019 + other 2,278 of 27,528, measured 2026-09-01) and a
// capitalise-first-letter helper would ship "…on its way with Self." to a real customer.
test('courier-display: routing placeholders fall back to the generic phrase', () => {
  assert.equal(courierName('self'), GENERIC);
  assert.equal(courierName('other'), GENERIC);
});

test('courier-display: unknown / empty values fall back rather than guess', () => {
  assert.equal(courierName('some_new_courier_2027'), GENERIC);
  assert.equal(courierName(''), GENERIC);
  assert.equal(courierName(null), GENERIC);
  assert.equal(courierName(undefined), GENERIC);
});

test('courier-display: tolerates casing and stray whitespace from the column', () => {
  assert.equal(courierName('  Delhivery  '), 'Delhivery');
  assert.equal(courierName('DELHIVERY'), 'Delhivery');
});

test('courier-display: never emits a bare placeholder into copy', () => {
  for (const v of ['self', 'other', 'unknown', null]) {
    const sentence = `Your order is on its way with ${courierName(v)}.`;
    assert.ok(!/ with (self|other|unknown|null)\./i.test(sentence), `leaked placeholder: ${sentence}`);
  }
});

console.log('courier-display tests OK');
