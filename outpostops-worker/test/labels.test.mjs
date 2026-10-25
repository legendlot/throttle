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

test('the printed sticker text gives the UPC and the product code to check', async () => {
  const { printedStickerCode } = await import('../src/labels.js');
  assert.deepEqual(printedStickerCode('SHAK00517082'), { upc: 'LOT-00517082', productCode: 'SHAK' });
  assert.deepEqual(printedStickerCode(' shxxr00517686 '), { upc: 'LOT-00517686', productCode: 'SHXXR' });
  for (const v of ['', null, 'LOT-00517082', 'SHA00517082', 'SHXXRR00517686', 'SHAK0517082', 'SHAK005170821', 'SH4K00517082',
    'SHAK00517082-E', 'SHAK00517082,x', 'SHAKO0517082']) {
    assert.equal(printedStickerCode(v), null, String(v));
  }
});

test('a typed sticker text is only taken if this vendor has that exact sticker, prefix included', async () => {
  const { printedStickerCode, stickerPoolPath } = await import('../src/labels.js');
  const path = stickerPoolPath(printedStickerCode('SHAK00517082'), 188);
  assert.match(path, /^\/rest\/v1\/upc_pool\?/);
  for (const f of ['upc_id=eq.LOT-00517082', 'product_code=eq.SHAK', 'vendor_id=eq.188']) assert.ok(path.includes(`${f}&`) || path.endsWith(f), f);
  assert.ok(stickerPoolPath(printedStickerCode('SHXXR00517686'), '188').includes('product_code=eq.SHXXR&'));
});
