// Multi-select transport tests (S347, 2026-09-04).
//
// The bug this closes is silent by construction: a filter value containing a comma split into
// fragments, matched no row, and the report rendered EMPTY — indistinguishable from a quiet
// month. So the case that matters most below is the comma-bearing value, and the second is
// that a page cached before this shipped keeps working.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMulti, MULTI_SEP } from './multiselect.js';

const join = (vals) => MULTI_SEP + vals.join(MULTI_SEP);

test('the separator is a control character, so it can never occur in a product or agent name', () => {
  assert.equal(MULTI_SEP, '\u001f');
  assert.equal(MULTI_SEP.length, 1);
});

test('a value CONTAINING a comma survives — this is the whole point of the change', () => {
  assert.deepEqual(splitMulti(join(['Shadow, Red'])), ['Shadow, Red']);
  assert.deepEqual(splitMulti(join(['Shadow, Red', 'Titan'])), ['Shadow, Red', 'Titan']);
});

test('a multi-value selection round-trips', () => {
  assert.deepEqual(splitMulti(join(['Shadow', 'Titan', 'Brutus'])), ['Shadow', 'Titan', 'Brutus']);
});

test('a single value round-trips', () => {
  assert.deepEqual(splitMulti(join(['Shadow'])), ['Shadow']);
});

test('BACKWARD COMPAT: a page cached before this shipped sends the comma form and still works', () => {
  assert.deepEqual(splitMulti('Shadow,Titan'), ['Shadow', 'Titan']);
  assert.deepEqual(splitMulti('Shadow, Titan'), ['Shadow', 'Titan']);
  assert.deepEqual(splitMulti('Shadow'), ['Shadow']);
});

test('empty and blank inputs yield no filter rather than a filter matching nothing', () => {
  assert.deepEqual(splitMulti(''), []);
  assert.deepEqual(splitMulti(undefined), []);
  assert.deepEqual(splitMulti(join([])), []);
  assert.deepEqual(splitMulti(join(['', '  '])), []);
});

test('surrounding whitespace is trimmed in the new encoding too', () => {
  assert.deepEqual(splitMulti(join(['  Shadow  ', ' Titan'])), ['Shadow', 'Titan']);
});
