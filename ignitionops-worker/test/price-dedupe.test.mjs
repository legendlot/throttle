import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeBySku } from '../src/price-dedupe.js';

const v = (sku, price, status = 'ACTIVE', id = sku + price) => ({ sku, price, status, variant_id: id });

test('unique skus pass through untouched, no duplicates reported', () => {
  const { rows, duplicates } = dedupeBySku([v('a', 10), v('b', 20)]);
  assert.deepEqual(rows.map(r => r.sku), ['a', 'b']);
  assert.deepEqual(duplicates, []);
});

test('priced beats ₹0, whichever comes first', () => {
  assert.equal(dedupeBySku([v('a', 0), v('a', 2399)]).rows[0].price, 2399);
  assert.equal(dedupeBySku([v('a', 2399), v('a', 0)]).rows[0].price, 2399);
});

test('two priced on equal status: first seen wins', () => {
  const { rows, duplicates } = dedupeBySku([v('a', 799, 'ACTIVE', 'old'), v('a', 999, 'ACTIVE', 'new')]);
  assert.equal(rows[0].variant_id, 'old');
  assert.deepEqual(duplicates, ['a']);
});

test('an ACTIVE product beats a draft/archived one, even a priced one', () => {
  const { rows } = dedupeBySku([v('a', 1999, 'ARCHIVED', 'dead'), v('a', 0, 'ACTIVE', 'live')]);
  assert.equal(rows[0].variant_id, 'live');
});

test('case-different skus are separate rows (the primary key is case-sensitive)', () => {
  const { rows, duplicates } = dedupeBySku([v('Bhoot', 1), v('bhoot', 1)]);
  assert.equal(rows.length, 2);
  assert.deepEqual(duplicates, []);
});

test('a batch of 200 can never carry the same sku twice', () => {
  const input = Array.from({ length: 450 }, (_, i) => v(`s${i % 300}`, i));
  const { rows } = dedupeBySku(input);
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).map(r => r.sku);
    assert.equal(new Set(batch).size, batch.length);
  }
  assert.equal(rows.length, 300);
});
