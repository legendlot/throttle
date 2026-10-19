import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPEN_CARTON_RACE_RE, packRequest } from '../src/pack.js';

const C = 'LOT-00000001', R = 'LOT-00000002';

test('an order pack keeps the pre-O12 request hash shape', () => {
  const p = packRequest({ work_order_id: 31, car_upc: C, remote_upc: R, pack_type: 'retail' });
  assert.equal(p.woId, 31);
  assert.equal(p.packType, null);   // the order's packaging wins; the toggle is not sent on
  assert.deepEqual(p.hashed, { work_order_id: 31, car_upc: C, remote_upc: R });
  assert.equal(packRequest({ work_order_id: '31', car_upc: C, remote_upc: R }).woId, 31);
});

test('no order needs a packaging type, and the hash covers it', () => {
  for (const wo of [undefined, null, '']) {
    const p = packRequest({ work_order_id: wo, pack_type: 'export', car_upc: C, remote_upc: R });
    assert.equal(p.woId, null);
    assert.equal(p.packType, 'export');
    assert.deepEqual(p.hashed, { work_order_id: null, pack_type: 'export', car_upc: C, remote_upc: R });
  }
  assert.match(packRequest({ car_upc: C, remote_upc: R }).error, /choose the packaging/);
  assert.match(packRequest({ pack_type: 'other', car_upc: C, remote_upc: R }).error, /choose the packaging/);
});

test('bad order ids and missing stickers are refused', () => {
  for (const wo of [0, -1, 1.5, 'x', '12a', true, {}]) {
    assert.match(packRequest({ work_order_id: wo, car_upc: C, remote_upc: R }).error, /order id/);
  }
  assert.match(packRequest({ work_order_id: 1, car_upc: C }).error, /car_upc and remote_upc/);
  assert.match(packRequest({ pack_type: 'ecom', remote_upc: R }).error, /car_upc and remote_upc/);
});

test('both open-carton race indexes map to a retry', () => {
  assert.ok(OPEN_CARTON_RACE_RE.test('duplicate key value violates unique constraint "cartons_one_open_per_bench_order"'));
  assert.ok(OPEN_CARTON_RACE_RE.test('duplicate key value violates unique constraint "cartons_one_open_per_bench_sku"'));
  assert.ok(!OPEN_CARTON_RACE_RE.test('duplicate key value violates unique constraint "cartons_ctn_no_key"'));
});
