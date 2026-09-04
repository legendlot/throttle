// Multi-select transport tests, CLIENT side (S347c).
//
// These exist because the worker-side test could not fail if the client's separator strip were
// removed — it asserts what the DECODER does, which is unchanged either way. The invariant that
// actually matters spans both halves: whatever joinMulti sends must decode to the same NUMBER of
// values it was given, or the filter silently means something else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinMulti, MULTI_SEP } from './csopsFetch.js';
import { splitMulti } from '../../../../csops-worker/src/multiselect.js';

test('⭐ round-trip preserves the VALUE COUNT even when a value contains the separator', () => {
  // Without the strip in joinMulti this decodes to 2 values and the filter means something else.
  const out = splitMulti(joinMulti(['A' + MULTI_SEP + 'B']));
  assert.equal(out.length, 1, 'a separator inside a value must not become a second value');
});

test('ordinary values round-trip unchanged, commas included', () => {
  for (const vals of [['Shadow'], ['Shadow', 'Titan'], ['Shadow, Red'], ['Shadow, Red', 'Titan']]) {
    assert.deepEqual(splitMulti(joinMulti(vals)), vals);
  }
});

test('null and undefined elements are dropped, never sent as the strings "null"/"undefined"', () => {
  // These would reach a uuid[] parameter and 500 the whole report.
  assert.deepEqual(splitMulti(joinMulti([null, 'A', undefined])), ['A']);
});

test('an empty selection encodes to something the worker reads as NO filter', () => {
  assert.deepEqual(splitMulti(joinMulti([])), []);
});
