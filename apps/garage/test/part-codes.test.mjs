import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartCodes as p } from '../src/lib/partCodes.mjs';

test('reads the code off a line with a name and a number on it', () => {
  assert.deepEqual(p('1. FL-PP-10 : License Street Red = 968,\n2. fl-pb-42 : Splitter B = 962 .\nFL-PP-10'), ['FL-PP-10', 'FL-PB-42']);
});
test('a hyphen in the name is not a second code', () => {
  assert.deepEqual(p('FL-PP-10 T-Connector 10-12 pcs'), ['FL-PP-10']);
});
test('real long codes survive, comma or tab separated', () => {
  assert.deepEqual(p('HW-SC-23-6-BK, HW-CSC-7-23-5\nGH-PB--31.'), ['HW-SC-23-6-BK', 'HW-CSC-7-23-5', 'GH-PB--31']);
});
test('Word and Excel dashes neither drop a code nor cut it short', () => {
  assert.deepEqual(p('FL–PP–10\nHW-SC-23-6–BK'), ['FL-PP-10', 'HW-SC-23-6-BK']);
});
test('nothing code-shaped gives nothing', () => {
  assert.deepEqual(p(''), []);
  assert.deepEqual(p(null), []);
  assert.deepEqual(p('License 968'), []);
});
