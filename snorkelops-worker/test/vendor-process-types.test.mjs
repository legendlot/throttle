// store.vendors.process_type is hand-copied in THREE places: the DB CHECK
// (snorkel_vendor_process_type_v2, S400), the worker's VENDOR_PROCESS_TYPES and the Snorkel vendor
// dropdown. A value in one but not another means a save that 400s (worker behind the DB) or a
// dropdown choice the DB refuses. The worker is a zero-import single file, so this reads the source.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const CHECK = ['moulding','painting','assembly','raw_material','product_supplier','pcba','tooling','other'];

test('worker VENDOR_PROCESS_TYPES matches the vendors_process_type_check CHECK', () => {
  const src = readFileSync(new URL('../src/index.js', here), 'utf8');
  const m = src.match(/const VENDOR_PROCESS_TYPES = \[([^\]]*)\]/);
  assert.ok(m, 'VENDOR_PROCESS_TYPES not found in worker');
  assert.deepEqual(m[1].split(',').map(s => s.trim().replace(/'/g, '')), CHECK);
});

test('Snorkel vendor dropdown offers exactly the CHECK values', () => {
  const src = readFileSync(new URL('../../apps/snorkel/src/app/(auth)/procurement/vendors/page.js', here), 'utf8');
  const block = src.match(/const VENDOR_PROCESS_TYPES = \[([\s\S]*?)\];/);
  assert.ok(block, 'VENDOR_PROCESS_TYPES not found in vendors page');
  assert.deepEqual([...block[1].matchAll(/value: '([^']+)'/g)].map(x => x[1]), CHECK);
});
