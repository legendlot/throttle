// vendorIdFields — GSTIN + Udyam on vendor create/edit (S403, Prarthi #bugs 1790687279).
// Until S403 the vendor form's GSTIN was dropped on save by BOTH paths; this pins the shared
// normaliser both now call. Lifted out of the single-file worker like partner-gstin-gate.test.mjs.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  lift('const GSTIN_RE =', '\n'),
  lift('const UDYAM_RE =', '\nasync function createVendorRow'),
  'return { vendorIdFields, UDYAM_RE };',
].join('\n');
const { vendorIdFields: f, UDYAM_RE } = new Function(code)();

test('absent keys are left out — an edit that does not send them leaves the columns alone', () => {
  assert.deepEqual(f({ vendor_name: 'X' }), {});
});

test('GSTIN: whitespace stripped, uppercased', () => {
  assert.deepEqual(f({ gstin: ' 29aalfa6686p1ze ' }), { gstin: '29AALFA6686P1ZE' });
});

test('GSTIN: empty / whitespace / null clear it', () => {
  for (const v of ['', '   ', null]) assert.deepEqual(f({ gstin: v }), { gstin: null });
});

test('GSTIN: a malformed value is refused, not written', () => {
  assert.ok(f({ gstin: '29AALFA6686P1Z' }).error);
  assert.ok(f({ gstin: 'NA' }).error);
});

test('Udyam: pasted with spaces and lower case saves clean', () => {
  assert.deepEqual(f({ udyam_number: 'udyam - mh - 26 - 0123456' }), { udyam_number: 'UDYAM-MH-26-0123456' });
});

test('Udyam: empty clears, malformed refused', () => {
  assert.deepEqual(f({ udyam_number: '' }), { udyam_number: null });
  assert.ok(f({ udyam_number: 'UDYAM-MH-26-012345' }).error);
  assert.ok(f({ udyam_number: 'MH-26-0123456' }).error);
  assert.ok(f({ udyam_number: 12345 }).error);
});

test('non-text values are refused — String([]) would otherwise clear a stored value', () => {
  for (const v of [[], ['UDYAM-MH-26-0123456'], {}, 0, true]) {
    assert.ok(f({ udyam_number: v }).error, JSON.stringify(v));
    assert.ok(f({ gstin: v }).error, JSON.stringify(v));
  }
});

// The bug this item fixed was a save path that never WROTE gstin — pin that both paths spread the
// normaliser's output into what they write.
test('create and update both write the normalised fields', () => {
  const create = lift('async function createVendorRow', '\n}\n');
  assert.match(create, /const ids = vendorIdFields\(d\)/);
  assert.match(create, /insert\('vendors', \{[\s\S]*\.\.\.ids,[\s\S]*\}\)/);
  const update = lift("case 'updateVendor':", "case 'createCompanyAddress':");
  assert.match(update, /const ids = vendorIdFields\(d\)/);
  assert.match(update, /const updates = \{[^}]*\.\.\.ids \}/);
});

test('a bad Udyam refuses the whole save even with a good GSTIN', () => {
  assert.ok(f({ gstin: '29AALFA6686P1ZE', udyam_number: 'x' }).error);
});

test('the worker regex matches the migration CHECK', () => {
  const mig = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../migrations/snorkel_vendor_udyam_v1.sql'), 'utf8');
  assert.ok(mig.includes(`'${UDYAM_RE.source}'`), 'CHECK pattern drifted from UDYAM_RE');
});
