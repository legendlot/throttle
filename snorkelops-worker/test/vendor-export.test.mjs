// Row shape of the Vendors directory export (Prarthi, #bugs 1790662998), lifted into
// apps/snorkel/src/lib/vendorExport.js so it can be tested outside React/Next.
// Run: node --test snorkelops-worker/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVendorsCsv, phoneCell, textCell, VENDOR_EXPORT_COLUMNS } from '../../apps/snorkel/src/lib/vendorExport.js';

const labels = { product_supplier: 'Product supplier (FBU / CKD)', moulding: 'Moulding' };

test('header is the column list, one row per vendor', () => {
  const csv = buildVendorsCsv([{ vendor_code: 'V001' }, { vendor_code: 'V002' }], labels);
  assert.ok(csv.startsWith('﻿'), 'UTF-8 BOM so Excel reads – and — correctly');
  const lines = csv.slice(1).split('\n');
  assert.equal(lines[0], VENDOR_EXPORT_COLUMNS.join(','));
  assert.equal(lines.length, 3);
  assert.equal(lines[1].split(',').length, VENDOR_EXPORT_COLUMNS.length);
});

test('every form field lands in its column; process shows its label', () => {
  const csv = buildVendorsCsv([{
    vendor_code: 'V010', vendor_name: 'Acme, Ltd', category: 'Packaging', process_type: 'product_supplier',
    source_country: 'India', location: 'Pune', currency: 'INR', contact_name: 'Ravi',
    contact_phone: '098452 78523', contact_email: 'a@b.in', payment_terms: 'Credit 30',
    lead_time_days: 14, address: 'Plot 4\nMIDC', gstin: '27ABCDE1234F1Z5', notes: 'said "ok"',
    active: true, created_at: '2026-09-28T20:00:00+00:00', udyam_number: 'UDYAM-MH-26-0123456',
  }], labels);
  const row = csv.slice(csv.indexOf('\n') + 1);
  assert.ok(row.startsWith('V010,"Acme, Ltd",Packaging,Product supplier (FBU / CKD),India,Pune,INR,Ravi,'));
  assert.ok(row.includes('"=""098452 78523"""'), 'phone kept as text');
  assert.ok(row.includes(',Credit 30,14,"Plot 4\nMIDC",27ABCDE1234F1Z5,"said ""ok""",Yes,2026-09-29,UDYAM-MH-26-0123456'),
    'multi-line address quoted; created_at is the IST date (20:00 UTC = next day IST)');
});

test('unknown process value is written raw, missing fields are blank not "undefined"', () => {
  const csv = buildVendorsCsv([{ vendor_code: 'V011', process_type: 'mystery', active: false }], labels);
  const row = csv.split('\n')[1];
  assert.ok(!row.includes('undefined') && !row.includes('null'));
  assert.equal(row.split(',')[3], 'mystery');
  assert.equal(row.split(',')[15], 'No');
});

test('phoneCell wraps digit-ish phones only', () => {
  assert.equal(phoneCell('9599083163'), '="9599083163"');
  assert.equal(phoneCell('+86 138 0000 0000'), '="+86 138 0000 0000"');
  assert.equal(phoneCell('WeChat: acme01'), 'WeChat: acme01');
  assert.equal(phoneCell(null), '');
  assert.equal(phoneCell(''), '');
});

test('textCell defuses a leading formula character; phones keep their deliberate ="…"', () => {
  assert.equal(textCell('=HYPERLINK("http://x","a")'), `'=HYPERLINK("http://x","a")`);
  assert.equal(textCell('@SUM(1)'), `'@SUM(1)`);
  assert.equal(textCell('-5 days'), `'-5 days`);
  assert.equal(textCell('Acme Ltd'), 'Acme Ltd');
  assert.equal(textCell(null), '');
  const row = buildVendorsCsv([{ vendor_code: 'V1', vendor_name: '+cheap', contact_phone: '9599083163' }]).split('\n')[1];
  assert.ok(row.startsWith(`V1,'+cheap,`));
  assert.ok(row.includes(`"=""9599083163"""`));
});
