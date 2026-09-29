// vendorReadQuery — the permission gate on getVendors / getVendor. Before it, any Snorkel login
// (requester, sales_rep, sales_manager) could read every vendor's email, address, GSTIN and notes.
// Lives only in the single-file worker, so — like partner-gstin-gate.test.mjs — the test lifts
// its source text straight out of index.js.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8');
const lift = (start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, `missing ${start}`); const j = src.indexOf(end, i); assert.ok(j > i, `no end for ${start}`); return src.slice(i, j); };
const code = [
  lift('const canView ', '\n'),
  lift('const canRaisePO ', '\n'),
  lift('const canManageVendors ', '\n'),
  lift('const VENDOR_VIEW_COLS =', '\n// Bank details are read-gated.'),
  'return { vendorReadQuery, VENDOR_VIEW_COLS, PO_VENDOR_COLS };',
].join('\n');
const { vendorReadQuery: q, VENDOR_VIEW_COLS, PO_VENDOR_COLS } = new Function(code)();

// Role permission sets as in store.snorkel_roles (measured 2026-09-29), reduced to the two keys.
const REQUESTER = {}, SALES = { sales_view: true };
const STORE = { procurement_view: true };                        // store, approver, jarvis_ro
const MANAGER = { procurement_view: true, vendor_manage: true }; // procurement_manager, admin, finance_manager

const PRIVATE = ['contact_email', 'address', 'gstin', 'notes'];
const selectOf = s => new URLSearchParams(s.slice(1)).get('select');

test('no procurement_view → refused, list and single', () => {
  for (const p of [REQUESTER, SALES, null, undefined]) {
    assert.equal(q(p), null);
    assert.equal(q(p, { code: 'V001' }), null);
  }
});

test('procurement_view without vendor_manage → reduced columns, no private fields', () => {
  for (const s of [q(STORE), q(STORE, { code: 'V001' })]) {
    const cols = selectOf(s).split(',');
    for (const k of PRIVATE) assert.ok(!cols.includes(k), k);
    assert.ok(!cols.includes('*'));
  }
});

test('the reduced set still carries what the pickers, PO prefill and Vendors table read', () => {
  const cols = VENDOR_VIEW_COLS.split(',');
  for (const k of ['vendor_code', 'vendor_name', 'source_country', 'currency', 'payment_terms',
    'lead_time_days', 'category', 'process_type', 'location', 'contact_name', 'contact_phone'])
    assert.ok(cols.includes(k), k);
});

test('vendor_manage → full rows', () => {
  assert.equal(selectOf(q(MANAGER)), '*');
  assert.equal(selectOf(q(MANAGER, { code: 'V001' })), '*');
});

test('list query keeps the active / country filters', () => {
  const p = new URLSearchParams(q(STORE, { active: 'false', country: 'China' }).slice(1));
  assert.equal(p.get('active'), 'eq.false');
  assert.equal(p.get('source_country'), 'eq.China');
  assert.equal(p.get('order'), 'vendor_name.asc');
  assert.equal(new URLSearchParams(q(STORE, { countryNot: 'China' }).slice(1)).get('source_country'), 'neq.China');
});

test('active cannot smuggle a second select past the gate', () => {
  assert.deepEqual(q(STORE, { active: 'true&select=*' }), { error: 'active must be true or false' });
  assert.deepEqual(q(STORE, { active: 'all' }), { error: 'active must be true or false' });
});

test('code and country values are encoded, never spliced raw', () => {
  const s = q(STORE, { code: 'V1&select=*' });
  assert.equal(new URLSearchParams(s.slice(1)).getAll('select').length, 1);
  const l = q(STORE, { country: 'X&select=gstin' });
  assert.equal(new URLSearchParams(l.slice(1)).getAll('select').length, 1);
});

test('a PO raiser without vendor_manage still gets gstin — the PO form tax split reads it', () => {
  const cols = selectOf(q({ procurement_view: true, po_create: true })).split(',');
  assert.ok(cols.includes('gstin'));
  for (const k of ['contact_email', 'address', 'notes']) assert.ok(!cols.includes(k), k);
});

test('getPO / getPrintPOData read only what the PO carries — never email or notes', () => {
  const cols = PO_VENDOR_COLS.split(',');
  for (const k of ['vendor_name', 'address', 'contact_name', 'contact_phone', 'gstin']) assert.ok(cols.includes(k), k);
  assert.ok(!cols.includes('contact_email') && !cols.includes('notes') && !cols.includes('*'));
  // every vendor lookup inside the two routes uses it
  for (const [start, end] of [["case 'getPO':", "case '"], ["case 'getPrintPOData':", "case '"]]) {
    const i = src.indexOf(start), body = src.slice(i, src.indexOf(end, i + start.length));
    const lookups = body.match(/query\('vendors',[^;]*;/g) || [];
    assert.ok(lookups.length >= 2, start);
    for (const l of lookups) assert.ok(l.includes('select=${PO_VENDOR_COLS}'), `${start} ${l}`);
  }
});
