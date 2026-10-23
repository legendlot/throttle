import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitLabelCode } from '../src/labels.js';

test('a sticker or batch label gives the unit UPC', () => {
  assert.equal(unitLabelCode('LOT-00517279'), 'LOT-00517279');
  assert.equal(unitLabelCode(' lot-00517279-e '), 'LOT-00517279');
  for (const s of ['R', 'X']) assert.equal(unitLabelCode(`LOT-00517279-${s}`), 'LOT-00517279');
});

test('anything else is refused, so nothing reaches a PostgREST filter', () => {
  for (const v of ['', null, undefined, 'LOT-1234567', 'LOT-123456789', 'LOT-00517279-Q', 'CTN-0000038', '5949999234230',
    'LOT-12345678,remote_upc.eq.x', 'LOT-12345678)', 'LOT-12345678\nx', 'LOT-12345678-E-E']) {
    assert.equal(unitLabelCode(v), null, String(v));
  }
});
