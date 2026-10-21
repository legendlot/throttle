import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionRequest } from '../src/production.js';

test('one vendor, a day range', () => {
  assert.deepEqual(productionRequest({ vendor_id: '188', from: '2026-10-01', to: '2026-10-21' }), { vendorId: 188, from: '2026-10-01', to: '2026-10-21' });
  assert.deepEqual(productionRequest({ vendor_id: '188', from: '2026-10-21' }), { vendorId: 188, from: '2026-10-21', to: null });
});

test('all vendors and all time are explicit words', () => {
  assert.deepEqual(productionRequest({ vendor_id: 'all', from: 'all' }), { vendorId: null, from: null, to: null });
});

test('a missing or bad from is refused, never read as all time', () => {
  for (const from of [undefined, '', '2026-13-01', '2026-02-30', '21-10-2026', 'ALL', '0000-01-01', '1999-12-31']) {
    assert.ok(productionRequest({ vendor_id: '188', from }).error, String(from));
  }
});

test('bad vendor ids and ranges are refused', () => {
  for (const vendor_id of [undefined, '', '0', '-1', '1.5', 'x', 'ALL', '0x10', '1e2', ' 188', '0188']) assert.ok(productionRequest({ vendor_id, from: 'all' }).error, String(vendor_id));
  assert.ok(productionRequest({ vendor_id: '188', from: '2026-10-21', to: '2026-10-01' }).error);
  assert.ok(productionRequest({ vendor_id: '188', from: '2026-10-01', to: 'tomorrow' }).error);
});
