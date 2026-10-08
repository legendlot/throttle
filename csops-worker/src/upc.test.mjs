// UPC normalisation on ticket writes (S412 — editing a conversation-born ticket's UPC hit the FK).
import test from 'node:test';
import assert from 'assert';
import { normalizeUpc, normalizeTicketUpcs, upcInFilter, findMissingUpc } from './upc.js';

test('normalizeUpc: label prefixes and bare serials map to LOT-<8 digits>', () => {
  assert.equal(normalizeUpc('SHAK00386646'), 'LOT-00386646');
  assert.equal(normalizeUpc('386646'), 'LOT-00386646');
  assert.equal(normalizeUpc('  lot-00386646 '), 'LOT-00386646');
  assert.equal(normalizeUpc('LOT-00386646'), 'LOT-00386646');
});

test('normalizeUpc: blank and digitless input pass through', () => {
  assert.equal(normalizeUpc(''), '');
  assert.equal(normalizeUpc(null), '');
  assert.equal(normalizeUpc(' abc '), 'abc');
});

test('normalizeTicketUpcs: normalises both UPC columns, blank clears to null', () => {
  assert.deepEqual(
    normalizeTicketUpcs({ lot_unit_upc: 'SHAK00386646', replacement_unit_upc: '  ', product: 'Shadow' }),
    { lot_unit_upc: 'LOT-00386646', replacement_unit_upc: null, product: 'Shadow' },
  );
});

test('normalizeTicketUpcs: absent keys stay absent and the input is not mutated', () => {
  const p = { product: 'Shadow' };
  const out = normalizeTicketUpcs(p);
  assert.deepEqual(out, { product: 'Shadow' });
  assert.ok(!('lot_unit_upc' in out));
  const q = { lot_unit_upc: '386646' };
  normalizeTicketUpcs(q);
  assert.equal(q.lot_unit_upc, '386646');
});

test('upcInFilter: values are quoted and encoded so junk cannot break the list', () => {
  assert.equal(upcInFilter(['LOT-00386646']), 'in.(%22LOT-00386646%22)');
  assert.equal(decodeURIComponent(upcInFilter(['a)b', 'x"y'])), 'in.("a)b","x\\"y")');
});

test('findMissingUpc: unchanged values are not looked up', async () => {
  let called = false;
  const r = await findMissingUpc({ lot_unit_upc: 'LOT-1' }, { lot_unit_upc: 'LOT-1' }, async () => { called = true; return []; });
  assert.deepEqual(r, { missing: null, failed: false });
  assert.equal(called, false);
});

test('findMissingUpc: reports the first changed UPC that is not a unit, deduped lookup', async () => {
  let asked;
  const r = await findMissingUpc(
    { lot_unit_upc: 'LOT-1', replacement_unit_upc: 'LOT-2' }, { lot_unit_upc: null },
    async (list) => { asked = list; return ['LOT-1']; },
  );
  assert.deepEqual(asked, ['LOT-1', 'LOT-2']);
  assert.deepEqual(r, { missing: 'LOT-2', failed: false });
  const same = await findMissingUpc({ lot_unit_upc: 'LOT-3', replacement_unit_upc: 'LOT-3' }, {}, async (l) => { asked = l; return l; });
  assert.deepEqual(asked, ['LOT-3']);
  assert.deepEqual(same, { missing: null, failed: false });
});

test('findMissingUpc: a failed lookup is reported, not treated as missing', async () => {
  assert.deepEqual(await findMissingUpc({ lot_unit_upc: 'LOT-1' }, {}, async () => null), { missing: null, failed: true });
});

test('findMissingUpc: null / cleared values skip the check', async () => {
  assert.deepEqual(await findMissingUpc({ lot_unit_upc: null }, { lot_unit_upc: 'LOT-1' }, async () => { throw new Error('no'); }), { missing: null, failed: false });
});
