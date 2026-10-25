import test from 'node:test';
import assert from 'node:assert/strict';
import { wholeCodeAtEnd } from '../src/op/scan.mjs';

test('auto-enter takes the whole code at the end of the box', () => {
  for (const [v, want] of [['LOT-00123456', 'LOT-00123456'], ['lot-00123456 ', 'LOT-00123456'], ['LOT-00123456-E', 'LOT-00123456-E'],
    ['CTN-0000123', 'CTN-0000123'], ['8906123456789', '8906123456789'],
    ['xLOT-00123456', 'LOT-00123456'], ['-ELOT-00123456', 'LOT-00123456'], ['LOT-0012345LOT-00999999', 'LOT-00999999']]) {
    assert.equal(wholeCodeAtEnd(v), want, v);
  }
});

test('auto-enter waits while the code is not whole yet', () => {
  for (const v of ['', 'LOT-', 'LOT-0012345', 'LOT-00123456-', 'CTN-000012', '890612345678', 'hello']) assert.equal(wholeCodeAtEnd(v), null, v);
});

test('the printed sticker text is a code the reprint lookup takes', async () => {
  const { STICKER_TEXT_RE } = await import('../src/op/scan.mjs');
  for (const v of ['SHAK00517082', 'SHXXR00517686']) assert.ok(STICKER_TEXT_RE.test(v), v);
  for (const v of ['LOT-00517082', 'SHA00517082', 'SHAK0051708', 'SHAK00517082X', '8906123456789']) assert.ok(!STICKER_TEXT_RE.test(v), v);
});
