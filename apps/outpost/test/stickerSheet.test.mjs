import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStickerSheet, stickerItems } from '../src/op/stickerSheet.mjs';

test('sticker code = product code + LOT number, the factory format', () => {
  assert.deepEqual(stickerItems([{ upc_id: 'LOT-00123456', product_code: 'GOBG' }]),
    [{ upcId: 'LOT-00123456', code: 'GOBG00123456' }]);
});

test('sheet is A3, 21 columns of 13 mm, and no value can close the script tag', () => {
  const html = buildStickerSheet({ batch: { batch_id: 'B-1', product: 'Gator', model: 'Base', color: 'Green', product_code: 'GOBG' },
    rows: [{ upc_id: 'LOT-1</script><b>', product_code: 'GOBG' }] });
  assert.match(html, /size: A3 portrait/);
  assert.match(html, /repeat\(21,13mm\)/);
  assert.match(html, /Gator · Base · Green · 1 stickers/);
  assert.equal(html.includes('</script><b>'), false);
});

test('a remote batch (5-letter code) is labelled by its product name', () => {
  const html = buildStickerSheet({ batch: { batch_id: 'B-2', product: 'Gator-Remote', product_code: 'GOXXR' }, rows: [] });
  assert.match(html, /Gator-Remote · 0 stickers/);
});
