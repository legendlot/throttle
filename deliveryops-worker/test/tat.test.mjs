import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tatDays } from '../src/tat.js';

test('surface days for a metro pincode', () => {
  assert.equal(tatDays('400001', 'surface'), 3);   // Mumbai
});
test('express days for the same pincode differ', () => {
  assert.equal(tatDays('400001', 'express'), 2);
});
test('Bangalore-local is 1 day', () => {
  assert.equal(tatDays('560001', 'surface'), 1);
});
test('defaults to surface when mode omitted', () => {
  assert.equal(tatDays('400001'), 3);
});
test('unknown pincode returns null', () => {
  assert.equal(tatDays('000000', 'surface'), null);
});
